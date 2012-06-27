/**
 * Serializes a chunk of tokens or an HTML DOM to MediaWiki's wikitext flavor.
 * 
 * @class
 * @constructor
 * @param options {Object} List of options for serialization
 */
WikitextSerializer = function( options ) {
	this.options = $.extend( {
		// defaults
	}, options || {} );
};

require('./core-upgrade.js');
var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer;

var WSP = WikitextSerializer.prototype;

/* *********************************************************************
 * Here is what the state attributes mean:
 *
 * listStack
 *    Stack of list contexts to let us emit wikitext for nested lists.
 *    Each context keeps track of 3 values:
 *    - itemBullet: the wikitext bullet char for this list
 *    - itemCount : # of list items encountered so far for the list 
 *    - bullets   : cumulative bullet prefix based on all the lists
 *                  that enclose the current list
 *
 * onNewline
 *    true on start of file or after a new line has been emitted.
 *
 * onStartOfLine
 *    true when onNewline is true, and also in other start-of-line contexts
 *    Ex: after a comment has been emitted, or after include/noinclude tokens.
 *
 * singleLineMode
 *    - if (> 0), we cannot emit any newlines.
 *    - this value changes as we entire/exit dom subtrees that require
 *      single-line wikitext output. WSP._tagHandlers specify single-line
 *      mode for individual tags.
 *
 * availableNewlineCount
 *    # of newlines that have been encountered so far but not emitted yet.
 *    Newlines are buffered till they need to be output.  This lets us
 *    swallow newlines in contexts where they shouldn't be emitted for
 *    ensuring equivalent wikitext output. (ex dom: ..</li>\n\n</li>..)
 * ********************************************************************* */
WSP.initialState = {
	listStack: [],
	onNewline: true,
	onStartOfLine : true,
	availableNewlineCount: 0,
	singleLineMode: 0
};

WSP.escapeWikiText = function ( state, text ) {
	// tokenize the text
	var p = new PegTokenizer( state.env ),
		tokens = [];
	p.on('chunk', function ( chunk ) { 
		//console.warn( JSON.stringify(chunk));
		tokens.push.apply( tokens, chunk );
	});
	p.on('end', function(){ 
		//console.warn( JSON.stringify('end'));
	});
	// this is synchronous for now, will still need sync version later, or
	// alternatively make text processing in the serializer async
	var prefixedText = text;
	var inNewlineContext = WSP._inNewLineContext( state );
	if ( ! inNewlineContext ) {
		// Prefix '_' so that no start-of-line wiki syntax matches. Strip it from
		// the result.
		prefixedText = '_' + text;
	}

	if ( state.inIndentPre ) {
		prefixedText = prefixedText.replace(/(\r?\n)/g, '$1_');
	}

	// FIXME: parse using 
	p.process( prefixedText );


	if ( ! inNewlineContext ) {
		// now strip the leading underscore.
		if ( tokens[0] === '_' ) {
			tokens.shift();
		} else {
			tokens[0] = tokens[0].substr(1);
		}
	}

	// state.inIndentPre is handled on the complete output

	//
	// wrap any run of non-text tokens into <nowiki> tags using the source
	// offsets of top-level productions
	// return the updated text
	var outTexts = [],
		nonTextTokenAccum = [],
		cursor = 0;
	function wrapNonTextTokens () {
		if ( nonTextTokenAccum.length ) {
			var missingRangeEnd = false;
			// TODO: make sure the source positions are always set!
			// The start range
			var startRange = nonTextTokenAccum[0].dataAttribs.tsr,
				rangeStart, rangeEnd;
			if ( ! startRange ) {
				console.warn( 'No tsr on ' + nonTextTokenAccum[0] );
				rangeStart = cursor;
			} else {
				rangeStart = startRange[0];
				if ( ! inNewlineContext ) {
					// compensate for underscore.
					rangeStart--;
				}
				cursor = rangeStart;
			}

			var endRange = nonTextTokenAccum.last().dataAttribs.tsr;
			if ( ! endRange ) {
				// FIXME: improve this!
				//rangeEnd = state.env.tokensToString( tokens ).length;
				// Be conservative and extend the range to the end for now.
				// Alternatives: only extend it to the next token with range
				// info on it.
				missingRangeEnd = true;
				rangeEnd = text.length;
			} else {
				rangeEnd = endRange[1];
				if ( ! inNewlineContext ) {
					// compensate for underscore.
					rangeEnd--;
				}
			}

			var escapedSource = text.substr( rangeStart, rangeEnd - rangeStart ) 
									.replace( /<(\/?nowiki)>/g, '&lt;$1&gt;' );
			outTexts.push( '<nowiki>' );
			outTexts.push( escapedSource );
			outTexts.push( '</nowiki>' );
			cursor += 17 + escapedSource.length;
			if ( missingRangeEnd ) {
				throw 'No tsr on end token: ' + nonTextTokenAccum.last();
			}
			nonTextTokenAccum = [];
		}
	}
	try {
		for ( var i = 0, l = tokens.length; i < l; i++ ) {
			var token = tokens[i];
			switch ( token.constructor ) {
				case String:
					wrapNonTextTokens();
					outTexts.push(
						token
						// Angle brackets forming HTML tags are picked up as
						// tags and escaped with nowiki. Remaining angle
						// brackets can remain unescaped in the wikitext. They
						// are entity-escaped by the HTML5 DOM serializer when
						// outputting the HTML DOM.
						//.replace(/</g, '&lt;').replace(/>/g, '&gt;')
					);
					cursor += token.length;
					break;
				case NlTk:
					wrapNonTextTokens();
					outTexts.push( '\n' );
					cursor++;
					break;
				case EOFTk:
					wrapNonTextTokens();
					break;
				case TagTk:
					if ( token.attribs[0] && 
							token.attribs[0].k === 'data-mw-gc' &&
							token.attribs[0].v === 'both' &&
							// XXX: move the decision whether to escape or not
							// into individual handlers!
							token.dataAttribs.src ) 
					{
						wrapNonTextTokens();
						// push out the original source
						// XXX: This assumes the content was not
						// modified for now.
						outTexts.push( token.dataAttribs.src );
						// skip generated tokens
						for ( ; i < l; i ++) {
							var tk = tokens[i];
							if ( tk.constructor === EndTagTk &&
									tk.name === token.name ) {
										break;
									}
						}
					} else {
						nonTextTokenAccum.push(token);
					}
					break;
				default:
					//console.warn('pushing ' + token);
					nonTextTokenAccum.push(token);
					break;
			}
		}
	} catch ( e ) {
		console.warn( e );
	}
	//console.warn( 'escaped wikiText: ' + outTexts.join('') );
	var res = outTexts.join('');
	if ( state.inIndentPre ) {
		return res.replace(/\n_/g, '\n');
	} else {
		return res;
	}
};

var id = function(v) { 
	return function( state ) { 
		return v; 
	}; 
};

WSP._inStartOfLineContext = function(state) {
	return	state.onStartOfLine || 
		state.emitNewlineOnNextToken ||
		(state.availableNewlineCount > 0);
};

WSP._inNewLineContext = function(state) {
	return	state.onNewline || 
		state.emitNewlineOnNextToken ||
		(state.availableNewlineCount > 0);
};

WSP._listHandler = function( handler, bullet, state, token ) {
	function isListItem(token) {
		if (token.constructor !== TagTk) return false;

		var tokenName = token.name;
		return (tokenName === 'li' || tokenName === 'dt' || tokenName === 'dd');
	}
	if ( state.singleLineMode ) {
		state.singleLineMode--;
	}

	var bullets, res;
	var stack = state.listStack;
	if (stack.length === 0) {
		bullets = bullet;
		res     = bullets;
		handler.startsNewline = true;
	} else {
		var curList = stack.last();
		//console.warn(JSON.stringify( stack ));
		bullets = curList.bullets + curList.itemBullet + bullet;
		curList.itemCount++;
		if (	// deeply nested list
				//( curList.itemCount > 1 &&
				//	token.name === 'dd' &&
				//	state.prevTagToken.constructor === EndTagTk &&
				//	state.prevTagToken.name === 'dt' &&
				//	! state.onStartOfLine ) ||
				// A nested list, not directly after a list item
				curList.itemCount > 1 && !isListItem(state.prevToken)) {
			res = bullets;
			handler.startsNewline = true;
		} else {
			res = bullet;
			handler.startsNewline = false;
		}
	}
	stack.push({ itemCount: 0, bullets: bullets, itemBullet: ''});
	state.env.dp('lh res', bullets, res, handler );
	return res;
};

WSP._listEndHandler = function( state, token ) {
	state.listStack.pop();
	return '';
};

WSP._listItemHandler = function ( handler, bullet, state, token ) { 

	function isRepeatToken(state, token) {
		return	state.prevToken.constructor === EndTagTk && 
				state.prevToken.name === token.name;
	}

	function isMultiLineDtDdPair(state, token) {
		return	token.name === 'dd' && 
				token.dataAttribs.stx !== 'row' &&
				state.prevTagToken.constructor === EndTagTk &&
				state.prevTagToken.name === 'dt';
	}

	var stack   = state.listStack;
	var curList = stack[stack.length - 1];
	curList.itemCount++;
	curList.itemBullet = bullet;

	// Output bullet prefix only if:
	// - this is not the first list item
	// - we are either in:
	//    * a new line context, 
	//    * seeing an identical token as the last one (..</li><li>...)
	//      (since we are in this handler on encountering a list item token,
	//       this means we are the 2nd or later item in the list, BUT without
	//       any intervening new lines or other tokens in between)
	//    * on the dd part of a multi-line dt-dd pair
	//      (The dd on a single-line dt-dd pair sticks to the dt.
	//       which means it won't get the bullets that the dt already got).
	//
	// SSS FIXME: This condition could be rephrased as:
	//
	// if (isRepeatToken(state, token) ||
	//     (curList.itemCount > 1 && (inStartOfLineContext(state) || isMultiLineDtDdPair(state, token))))
	//
	var res;
	if (curList.itemCount > 1 && 
		(	WSP._inStartOfLineContext(state) ||
			isRepeatToken(state, token) ||
			isMultiLineDtDdPair(state, token)
		)
	)
	{
		handler.startsNewline = true;
		res = curList.bullets + bullet;
	} else {
		handler.startsNewline = false;
		res = bullet;
	}
	state.env.dp( 'lih', token, res, handler );
	return res;
};

WSP._serializeTableTag = function ( symbol, optionEndSymbol, state, token ) {
	if ( token.attribs.length ) {
		return symbol + ' ' + WSP._serializeAttributes( token.attribs ) + optionEndSymbol;
	} else {
		return symbol;
	}
};

WSP._emptyTags = { br: true, meta: true };

WSP._serializeHTMLTag = function ( state, token ) {
	var close = '';
	if ( WSP._emptyTags[ token.name ] ) {
		close = '/';
	}

	if ( token.name === 'pre' ) {
		// html-syntax pre is very similar to nowiki
		state.inHTMLPre = true;
	}

	// Swallow required newline from previous token on encountering a HTML tag
	//state.emitNewlineOnNextToken = false;

	if ( token.attribs.length ) {
		return '<' + token.name + ' ' + 
			WSP._serializeAttributes( token.attribs ) + close + '>';
	} else {
		return '<' + token.name + close + '>';
	}
};

WSP._serializeHTMLEndTag = function ( state, token ) {
	if ( token.name === 'pre' ) {
		state.inHTMLPre = false;
	}
	if ( ! WSP._emptyTags[ token.name ] ) {
		return '</' + token.name + '>';
	} else {
		return '';
	}
};

WSP._linkHandler =  function( state, token ) {
	//return '[[';
	// TODO: handle internal/external links etc using RDFa and dataAttribs
	// Also convert unannotated html links to external wiki links for html
	// import. Might want to consider converting relative links without path
	// component and file extension to wiki links.
	
	var env = state.env;
	var attribDict = env.KVtoHash( token.attribs );
	if ( attribDict.rel && attribDict.href !== undefined ) {
		var tokenData = token.dataAttribs;
		if ( attribDict.rel === 'mw:wikiLink' ) {
			var base   = env.wgScriptPath;
			var href   = attribDict.href;
			var prefix = href.substr(0, base.length);
			var target = (prefix === base) ? href.substr(base.length) : href;
			target = decodeURIComponent(target);

			var tail   = tokenData.tail;
			if ( tail && tail.length ) {
				state.dropTail = tail;
				target = tokenData.gc ? tokenData.sHref : target.replace( /_/g, ' ' );
			} else {
				var origLinkTgt = tokenData.sHref;
				if (origLinkTgt) {
					// Normalize the source target so that we can compare it
					// with href.
					var normalizedOrigLinkTgt =  env.normalizeTitle( env.tokensToString(origLinkTgt) );
					if ( normalizedOrigLinkTgt === target ) {
						// Non-standard capitalization
						target = origLinkTgt;
					}
				} else {
					target = target.replace( /_/g, ' ' );
				}
			}

			// FIXME: Properly handle something like [[{{Foo}}]]s
			target = env.tokensToString( target );

			if ( tokenData.gc ) {
				state.dropContent = true;
				return '[[' + target;
			} else {
				return '[[' + target + '|';
			}
		} else if ( attribDict.rel === 'mw:extLink' ) {
			if ( tokenData.stx === 'urllink' ) {
				state.dropContent = true;
				return attribDict.href;
			} else if ( tokenData.gc ) {
				state.dropContent = true;
				return '[' + attribDict.href;
			} else {
				return '[' + attribDict.href + ' ';
			}
		} else {
			// TODO: default to extlink for simple links without rel set, and
			// switch to html only when needed to support attributes
			return WSP._serializeHTMLTag( state, token );
		}
	} else {
		return WSP._serializeHTMLTag( state, token );
	}
					
	//if ( rtinfo.type === 'wikilink' ) {
	//	return '[[' + rtinfo.target + ']]';
	//} else {
	//	// external link
	//	return '[' + rtinfo.
};
WSP._linkEndHandler = function( state, token ) {
	var attribDict = state.env.KVtoHash( token.attribs );
	if ( attribDict.rel && attribDict.href !== undefined ) {
		if ( attribDict.rel === 'mw:wikiLink' ) {
			state.dropContent = false;
			state.dropTail    = false;
			return "]]" + (token.dataAttribs.tail ? token.dataAttribs.tail : "");
		} else if ( attribDict.rel === 'mw:extLink' ) {
			state.dropContent = false;
			return (token.dataAttribs.stx === 'urllink') ? '' : ']';
		} else {
			return WSP._serializeHTMLEndTag( state, token );
		}
	} else {
		return WSP._serializeHTMLEndTag( state, token );
	}
};

/* *********************************************************************
 * startsNewline
 *     if true, the wikitext for the dom subtree rooted
 *     at this html tag requires a new line context.
 *
 * endsLine
 *     if true, the wikitext for the dom subtree rooted
 *     at this html tag ends the line.
 *
 * pairsSepNlCount
 *     # of new lines required between wikitext for dom siblings
 *     of the same tag type (..</p><p>.., etc.)
 *
 * newlineTransparent
 *     if true, this token does not change the newline status
 *     after it is emitted.
 *
 * singleLine
 *     if 1, the wikitext for the dom subtree rooted at this html tag
 *     requires all content to be emitted on the same line without 
 *     any line breaks. +1 sets the single-line mode (on descending
 *     the dom subtree), -1 clears the single-line mod (on exiting
 *     the dom subtree).
 *
 * ignore
 *     if true, the serializer pretends as if it never saw this token.
 * ********************************************************************* */
WSP.tagHandlers = {
	body: {
		start: {
			handle: function(state, token) {
				// swallow trailing new line
				state.emitNewlineOnNextToken = false;
				return '';
			}
		}
	},
	ul: { 
		start: {
			startsNewline : true,
			handle: function ( state, token ) {
					return WSP._listHandler( this, '*', state, token );
			},
			pairSepNLCount: 2,
			newlineTransparent: true
		},
		end: {
			endsLine: true,
			handle: WSP._listEndHandler
		}
	},
	ol: { 
		start: {
			startsNewline : true,
			handle: function ( state, token ) {
					return WSP._listHandler( this, '#', state, token );
			},
			pairSepNLCount: 2,
			newlineTransparent: true
		},
		end: {
			endsLine      : true,
			handle: WSP._listEndHandler
		}
	},
	dl: { 
		start: {
			startsNewline : true,
			handle: function ( state, token ) {
					return WSP._listHandler( this, '', state, token );
			},
			pairSepNLCount: 2
		},
		end: {
			endsLine: true,
			handle: WSP._listEndHandler
		}
	},
	li: { 
		start: {
			handle: function ( state, token ) {
				return WSP._listItemHandler( this, '', state, token );
			},
			singleLine: 1,
			pairSepNLCount: 1
		},
		end: {
			singleLine: -1
		}
	},
	// XXX: handle single-line vs. multi-line dls etc
	dt: { 
		start: {
			singleLine: 1,
			handle: function ( state, token ) {
				return WSP._listItemHandler( this, ';', state, token );
			},
			pairSepNLCount: 1,
			newlineTransparent: true
		},
		end: {
			singleLine: -1
		}
	},
	dd: { 
		start: {
			singleLine: 1,
			handle: function ( state, token ) {
				return WSP._listItemHandler( this, ':', state, token );
			},
			pairSepNLCount: 1,
			newlineTransparent: true
		},
		end: {
			endsLine: true,
			singleLine: -1
		}
	},
	// XXX: handle options
	table: { 
		start: {
			handle: WSP._serializeTableTag.bind(null, "{|", '')
		},
		end: {
			handle: function(state, token) {
				if ( state.prevTagToken && state.prevTagToken.name === 'tr' ) {
					this.startsNewline = true;
				} else {
					this.startsNewline = false;
				}
				return "|}";
			}
		}
	},
	tbody: { start: { ignore: true }, end: { ignore: true } },
	th: { 
		start: {
			handle: function ( state, token ) {
				if ( token.dataAttribs.stx_v === 'row' ) {
					this.startsNewline = false;
					return WSP._serializeTableTag("!!", ' |', state, token);
				} else {
					this.startsNewline = true;
					return WSP._serializeTableTag( "!", ' |', state, token);
				}
			}
		}
	},
	tr: { 
		start: {
			handle: function ( state, token ) {
				if ( state.prevToken.constructor === TagTk && state.prevToken.name === 'tbody' ) {
					// Omit for first row in a table. XXX: support optional trs
					// for first line (in source wikitext) too using some flag in
					// data-mw (stx: 'wikitext' ?)
					return '';
				} else {
					return WSP._serializeTableTag("|-", '', state, token );
				}
			},
			startsNewline: true
		}
	},
	td: { 
		start: {
			handle: function ( state, token ) {
				if ( token.dataAttribs.stx_v === 'row' ) {
					this.startsNewline = false;
					return WSP._serializeTableTag("||", ' |', state, token);
				} else {
					this.startsNewline = true;
					return WSP._serializeTableTag("|", ' |', state, token);
				}
			}
		}
	},
	caption: { 
		start: {
			startsNewline: true,
			handle: WSP._serializeTableTag.bind(null, "|+", ' |')
		}
	},
	p: { 
		make: function(state, token) {
			// Special case handling in a list context
			// VE embeds list content in paragraph tags
			return state.singleLineMode ? WSP.defaultHTMLTagHandler : this;
		},
		start: {
			startsNewline : true,
			pairSepNLCount: 2
		},
		end: {
			endsLine: true
		}
	},
	// XXX: support indent variant instead by registering a newline handler?
	pre: { 
		start: {
			startsNewline: true,
			handle: function( state, token ) {
				state.inIndentPre = true;
				state.textHandler = function( t ) { 
					return t.replace(/\n/g, '\n ' ); 
				};
				return ' ';
			}
		},
		end: {
			endsLine: true,
			handle: function( state, token) { 
				state.inIndentPre = false;
				state.textHandler = null; 
				return ''; 
			}
		}
	},
	meta: { 
		start: {
			handle: function ( state, token ) {
				var argDict = state.env.KVtoHash( token.attribs );
				if ( argDict['typeof'] === 'mw:tag' ) {
					// we use this currently for nowiki and noinclude & co
					this.newlineTransparent = true;
					if ( argDict.content === 'nowiki' ) {
						state.inNoWiki = true;
					} else if ( argDict.content === '/nowiki' ) {
						state.inNoWiki = false;
					} else {
						console.warn( JSON.stringify( argDict ) );
					}
					return '<' + argDict.content + '>';
				} else if ( argDict['typeof'] === 'mw:noinclude' ) {
					this.newlineTransparent = true;
					if ( token.dataAttribs.src === '<noinclude>' ) {
						return '<noinclude>';
					} else {
						return '</noinclude>';
					}
				} else {
					this.newlineTransparent = false;
					return WSP._serializeHTMLTag( state, token );
				}
			}
		}
	},
	span: {
		start: {
			handle: function( state, token ) {
				var argDict = state.env.KVtoHash( token.attribs );
				if ( argDict['data-mw-gc'] === 'both' && 
						token.dataAttribs.src ) {
					// FIXME: compare content with original content
					state.dropContent = true;
					return token.dataAttribs.src;
				} else if ( argDict['data-mw-gc'] === 'wrapper' ) {
					if ( argDict['typeof'] === 'mw:nowiki' ) {
						this.inNoWiki = true;
					}
					return '<nowiki>';
				} else {
					// Fall back to plain HTML serialization for spans created
					// by the editor
					return WSP._serializeHTMLTag( state, token );
				}
			}
		},
		end: {
			handle: function ( state, token ) { 
				var argDict = state.env.KVtoHash( token.attribs );
				if ( argDict['data-mw-gc'] === 'both' && 
						token.dataAttribs.src ) {
					state.dropContent = false; 
					return '';
				} else if ( argDict['data-mw-gc'] === 'wrapper' ) {
					if ( argDict['typeof'] === 'mw:nowiki' ) {
						this.inNoWiki = false;
					}
					return '</nowiki>';
				} else {
					// Fall back to plain HTML serialization for spans created
					// by the editor
					return WSP._serializeHTMLEndTag( state, token );
				}
			}
		}
	},
	hr: { 
		start: { 
			startsNewline: true, 
			endsLine: true,
			handle: id("----") 
		}
	},
	h1: { 
		start: { startsNewline: true, handle: id("=") },
		end: { endsLine: true, handle: id("=") }
	},
	h2: { 
		start: { startsNewline: true, handle: id("==") },
		end: { endsLine: true, handle: id("==") }
	},
	h3: { 
		start: { startsNewline: true, handle: id("===") },
		end: { endsLine: true, handle: id("===") }
	},
	h4: { 
		start: { startsNewline: true, handle: id("====") },
		end: { endsLine: true, handle: id("====") }
	},
	h5: { 
		start: { startsNewline: true, handle: id("=====") },
		end: { endsLine: true, handle: id("=====") }
	},
	h6: { 
		start: { startsNewline: true, handle: id("======") },
		end: { endsLine: true, handle: id("======") }
	},
	br: { 
		start: { 
			startsNewline: true,
			endsLine: true,
			handle: id("") 
		}
	},
	b:  { 
		start: { handle: id("'''") },
		end: { handle: id("'''") }
	},
	i:  { 
		start: { handle: id("''") },
		end: { handle: id("''") }
	},
	a:  { 
		start: { handle: WSP._linkHandler },
		end: { handle: WSP._linkEndHandler }
	}
};


WSP._serializeAttributes = function ( attribs ) {
	var out = [];
	for ( var i = 0, l = attribs.length; i < l; i++ ) {
		var kv = attribs[i];
		if (kv.k.length) {
			if ( kv.v.length ) {
				out.push( kv.k + '=' + 
						'"' + kv.v.replace( '"', '&quot;' ) + '"');
			} else {
				out.push( kv.k );
			}
		} else if ( kv.v.length ) {
			// not very likely..
			out.push( kv.v );
		}
	}
	// XXX: round-trip optional whitespace / line breaks etc
	return out.join(' ');
};

/**
 * Serialize a chunk of tokens
 */
WSP.serializeTokens = function( tokens, chunkCB ) {
	var state = $.extend({}, this.initialState, this.options),
		i, l;
	if ( chunkCB === undefined ) {
		var out = [];
		state.chunkCB = out.push.bind(out);
		for ( i = 0, l = tokens.length; i < l; i++ ) {
			this._serializeToken( state, tokens[i] );
		}
		return out;
	} else {
		state.chunkCB = chunkCB;
		for ( i = 0, l = tokens.length; i < l; i++ ) {
			this._serializeToken( state, tokens[i] );
		}
	}
};

WSP.defaultHTMLTagHandler = { 
	start: { handle: WSP._serializeHTMLTag }, 
	end  : { handle: WSP._serializeHTMLEndTag } 
};

WSP._getTokenHandler = function(state, token) {
	var handler;
	if (token.dataAttribs.stx === 'html') {
		handler = this.defaultHTMLTagHandler;
	} else {
		var tname = token.name;
		handler = this.tagHandlers[tname];
		if ( handler && handler.make ) {
			handler = handler.make(state, token);
		}
	}
	
	if ( ! handler ) {
		handler = this.defaultHTMLTagHandler;
	}
	if ( token.constructor === TagTk || token.constructor === SelfclosingTagTk ) {
		return handler.start || {};
	} else {
		return handler.end || {};
	}
};

/**
 * Serialize a token.
 */
WSP._serializeToken = function ( state, token ) {
	var handler = {}, 
		res = '', 
		dropContent = state.dropContent;

	state.prevToken = state.curToken;
	state.curToken  = token;


	switch( token.constructor ) {
		case TagTk:
		case SelfclosingTagTk:
			handler = WSP._getTokenHandler( state, token );
			if ( ! handler.ignore ) {
				state.prevTagToken = state.currTagToken;
				state.currTagToken = token;
				res = handler.handle ? handler.handle( state, token ) : '';
			}
			break;
		case EndTagTk:
			handler = WSP._getTokenHandler( state, token );
			if ( ! handler.ignore ) {
				state.prevTagToken = state.currTagToken;
				state.currTagToken = token;
				if ( handler.singleLine < 0 && state.singleLineMode ) {
					state.singleLineMode--;
				}
				res = handler.handle ? handler.handle( state, token ) : '';
			}
			break;
		case String:
			res = ( state.inNoWiki || state.inHTMLPre ) ? token 
				: this.escapeWikiText( state, token );
			res = state.textHandler ? state.textHandler( res ) : res;
			break;
		case CommentTk:
			res = '<!--' + token.value + '-->';
			// don't consider comments for changes of the onStartOfLine status
			// XXX: convert all non-tag handlers to a similar handler
			// structure as tags?
			handler = { newlineTransparent: true }; 
			break;
		case NlTk:
			res = '\n';
			res = state.textHandler ? state.textHandler( res ) : res;
			break;
		case EOFTk:
			res = '';
			for ( var i = 0, l = state.availableNewlineCount; i < l; i++ ) {
				res += '\n';
			}
			state.chunkCB(res);
			break;
		default:
			res = '';
			console.warn( 'Unhandled token type ' + JSON.stringify( token ) );
			break;
	}


	if (! dropContent || ! state.dropContent ) {

		var newNLCount = 0;
		if (res !== '') {
			// Strip leading or trailing newlines from the returned string
			var match = res.match( /^((?:\r?\n)*)((?:.*?|[\r\n]+[^\r\n])*?)((?:\r?\n)*)$/ ),
				leadingNLs = match[1],
				trailingNLs = match[3];

			if (leadingNLs === res) {
				// all newlines, accumulate count, and clear output
				state.availableNewlineCount += leadingNLs.replace(/\r\n/g, '\n').length;
				res = "";
			} else {
				newNLCount = trailingNLs.replace(/\r\n/g, '\n').length;
				if ( leadingNLs !== '' ) {
					state.availableNewlineCount += leadingNLs.replace(/\r\n/g, '\n').length;
				}
				// strip newlines
				res = match[2];
			}
		}

		// Check if we have a pair of identical tag tokens </p><p>; </ul><ul>; etc. 
		// that have to be separated by extra newlines and add those in.
		if (handler.pairSepNLCount && state.prevTagToken && 
				state.prevTagToken.constructor === EndTagTk && 
				state.prevTagToken.name === token.name ) 
		{
			if ( state.availableNewlineCount < handler.pairSepNLCount) {
				state.availableNewlineCount = handler.pairSepNLCount;
			}
		}

		if ( state.env.debug ) {
			console.warn(token + " -> " + JSON.stringify( res ) + 
					"\n   onnl: " + state.onNewline + 
					", #nl: is" + state.availableNewlineCount + '/new' + newNLCount +
					', emitOnNext:' + state.emitNewlineOnNextToken);
		}
		if (res !== '' ) {
			var out = '';
			// Prev token's new line token
			if ( !state.singleLineMode &&
					( ( !res.match(/^\s*$/) && state.emitNewlineOnNextToken ) ||
					( handler.startsNewline && !state.onStartOfLine ) ) ) 
			{
				// Emit new line, if necessary
				if ( ! state.availableNewlineCount ) {
					state.availableNewlineCount++;
				}
				state.emitNewlineOnNextToken = false;
			}

			if ( state.availableNewlineCount ) {
				state.onNewline = true;
				state.onStartOfLine = true;
			}

			// Add required # of new lines in the beginning
			for (; state.availableNewlineCount; state.availableNewlineCount--) {
				out += '\n';
			}

			state.availableNewlineCount = newNLCount;

			// FIXME: This might modify not just the last content token in a
			// link, which would be wrong. We'll likely have to collect tokens
			// between a tags instead, and strip only the last content token.
			if (state.dropTail && res.substr(- state.dropTail.length) === state.dropTail) {
				res = res.substr(0, res.length - state.dropTail.length);
			}

			if ( state.singleLineMode ) {
				res = res.replace(/\n/g, ' ');
			}
			out += res;
			if ( res !== '' ) {
				state.onNewline = false;
				if ( !handler.newlineTransparent ) {
					state.onStartOfLine = false;
				}
			}
			state.env.dp(' =>', out);
			state.chunkCB( out );
		} else {
			state.availableNewlineCount += newNLCount;
			if ( handler.startsNewline && ! state.onStartOfLine ) {
				state.emitNewlineOnNextToken = true;
			}
		}
		/* else {
			console.warn("SILENT: tok: " + token + ", res: <" + res + ">" + ", onnl: " + state.onNewline + ", # nls: " + state.availableNewlineCount);
		}
		*/

		if (handler.endsLine) {
			// Record end of line
			state.emitNewlineOnNextToken = true;
		}
		if ( handler.singleLine > 0 ) {
			state.singleLineMode += handler.singleLine;
		}
	}
};

/**
 * Serialize an HTML DOM document.
 */
WSP.serializeDOM = function( node, chunkCB ) {
	try {
		var state = $.extend({}, this.initialState, this.options);
		//console.warn( node.innerHTML );
		if ( ! chunkCB ) {
			var out = [];
			state.chunkCB = out.push.bind( out );
			this._serializeDOM( node, state );
			this._serializeToken( state, new EOFTk() );
			return out.join('');
		} else {
			state.chunkCB = chunkCB;
			this._serializeDOM( node, state );
			this._serializeToken( state, new EOFTk() );
		}
	} catch (e) {
		console.warn(e.stack);
	}
};

/**
 * Internal worker. Recursively serialize a DOM subtree by creating tokens and
 * calling _serializeToken on each of these.
 */
WSP._serializeDOM = function( node, state ) {
	// serialize this node
	switch( node.nodeType ) {
		case Node.ELEMENT_NODE:
			//console.warn( node.nodeName.toLowerCase() );
			var children = node.childNodes,
				name = node.nodeName.toLowerCase(),
				tkAttribs = this._getDOMAttribs(node.attributes),
				tkRTInfo = this._getDOMRTInfo(node.attributes);

			// Serialize the start token
			this._serializeToken(state, new TagTk(name, tkAttribs, tkRTInfo));

			// then children
			for ( var i = 0, l = children.length; i < l; i++ ) {
				this._serializeDOM( children[i], state );
			}

			// then the end token
			this._serializeToken(state, new EndTagTk(name, tkAttribs, tkRTInfo));
			break;
		case Node.TEXT_NODE:
			this._serializeToken( state, node.data );
			break;
		case Node.COMMENT_NODE:
			// delay the newline creation until after the comment
			var savedEmitNewlineOnNextToken = state.emitNewlineOnNextToken;
			state.emitNewlineOnNextToken = false;
			this._serializeToken( state, new CommentTk( node.data ) );
			state.emitNewlineOnNextToken = savedEmitNewlineOnNextToken;
			break;
		default:
			console.warn( "Unhandled node type: " + 
					node.outerHTML );
			break;
	}
};

WSP._getDOMAttribs = function( attribs ) {
	// convert to list fo key-value pairs
	var out = [];
	for ( var i = 0, l = attribs.length; i < l; i++ ) {
		var attrib = attribs.item(i);
		if ( attrib.name !== 'data-mw' ) {
			out.push( { k: attrib.name, v: attrib.value } );
		}
	}
	return out;
};

WSP._getDOMRTInfo = function( attribs ) {
	if ( attribs['data-mw'] ) {
		return JSON.parse( attribs['data-mw'].value || '{}' );
	} else {
		return {};
	}
};


// Quick HACK: define Node constants locally
// https://developer.mozilla.org/en/nodeType
var Node = {
	ELEMENT_NODE: 1,
    ATTRIBUTE_NODE: 2,
    TEXT_NODE: 3,
    CDATA_SECTION_NODE: 4,
    ENTITY_REFERENCE_NODE: 5,
    ENTITY_NODE: 6,
    PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE: 8,
    DOCUMENT_NODE: 9,
    DOCUMENT_TYPE_NODE: 10,
    DOCUMENT_FRAGMENT_NODE: 11,
    NOTATION_NODE: 12
};


if (typeof module == "object") {
	module.exports.WikitextSerializer = WikitextSerializer;
}
