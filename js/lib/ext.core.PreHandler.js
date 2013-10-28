"use strict";
/* --------------------------------------------------------------------------

 PRE-handling relies on the following 5-state FSM.

 ------
 States
 ------
 SOL           -- start-of-line
                  (white-space, comments, meta-tags are all SOL transparent)
 PRE           -- we might need a pre-block
                  (if we enter the PRE_COLLECT state)
 PRE_COLLECT   -- we will need to generate a pre-block and are collecting
                  content for it.
 MULTILINE_PRE -- we might need to extend the pre-block to multiple lines.
                  (depending on whether we see a white-space tok or not)
 IGNORE        -- nothing to do for the rest of the line.

 -----------
 Transitions
 -----------

 In the transition table below, purge is just a shortcut for:
 "pass on collected tokens to the callback and reset (getResultAndReset)"

 + --------------+-----------------+---------------+--------------------------+
 | Start state   |     Token       | End state     |  Action                  |
 + --------------+-----------------+---------------+--------------------------+
 | SOL           | --- nl      --> | SOL           | purge                    |
 | SOL           | --- eof     --> | SOL           | purge                    |
 | SOL           | --- ws      --> | PRE|SOL       | save ws token|purge(#,##)|
 | SOL           | --- sol-tr  --> | SOL           | TOKS << tok              |
 | SOL           | --- other   --> | IGNORE        | purge                    |
 + --------------+-----------------+---------------+--------------------------+
 | PRE           | --- nl      --> | SOL           | purge                    |
 | PRE           |  html-blk tag   | IGNORE        | purge                    |
 |               |  wt-table tag   |               |                          |
 | PRE           | --- eof     --> | SOL           | purge                    |
 | PRE           | --- sol-tr  --> | PRE           | SOL-TR-TOKS << tok       |
 | PRE           | --- other   --> | PRE_COLLECT   | TOKS = SOL-TR-TOKS + tok |
 + --------------+-----------------+---------------+--------------------------+
 | PRE_COLLECT   | --- nl      --> | MULTILINE_PRE | save nl token            |
 | PRE_COLLECT   | --- eof     --> | SOL           | gen-pre                  |
 | PRE_COLLECT   | --- blk tag --> | IGNORE        | gen-pre                  |
 | PRE_COLLECT   | --- any     --> | PRE_COLLECT   | TOKS << tok              |
 + --------------+-----------------+---------------+--------------------------+
 | MULTILINE_PRE | --- nl      --> | SOL           | gen-pre                  |
 | MULTILINE_PRE | --- eof     --> | SOL           | gen-pre                  |
 | MULTILINE_PRE | --- ws      --> | PRE_COLLECT   | pop saved nl token (##)  |
 |               |                 |               | TOKS = SOL-TR-TOKS + tok |
 | MULTILINE_PRE | --- sol-tr  --> | MULTILINE_PRE | SOL-TR-TOKS << tok       |
 | MULTILINE_PRE | --- any     --> | IGNORE        | gen-pre                  |
 + --------------+-----------------+---------------+--------------------------+
 | IGNORE        | --- nl      --> | SOL           | purge                    |
 | IGNORE        | --- eof     --> | SOL           | purge                    |
 + --------------+-----------------+---------------+--------------------------+

 # We're being careful to avoid a situation where we generate a pre when we're
   already inside a pre. If we've seen an open pre tag (marked as inPre), stay
   in SOL and purge. Otherwise, save the whitespace token and transition to PRE.

 ## In these states, check if the whitespace token is a single space or has
   additional chars (white-space or non-whitespace) -- if yes, slice it off
   and pass it through the FSM

 * --------------------------------------------------------------------------*/

var Util = require('./mediawiki.Util.js').Util,
    defines = require('./mediawiki.parser.defines.js');
// define some constructor shortcuts
var CommentTk = defines.CommentTk,
    EOFTk = defines.EOFTk,
    TagTk = defines.TagTk,
    SelfclosingTagTk = defines.SelfclosingTagTk,
    EndTagTk = defines.EndTagTk;

var init; // forward declaration.

function isPre( token, tag ) {
	return token.constructor === tag && token.isHTMLTag() && token.name.toUpperCase() === "PRE";
}

// Constructor
function PreHandler( manager, options ) {
	this.manager = manager;
	var env = manager.env;
	this.debug = env.conf.parsoid.debug || (env.conf.parsoid.traceFlags && (env.conf.parsoid.traceFlags.indexOf("pre_debug") !== -1));
	this.trace = this.debug || (env.conf.parsoid.traceFlags && (env.conf.parsoid.traceFlags.indexOf("pre") !== -1));

	if (!options.noPre) {
		this.manager.addTransform(this.onNewline.bind(this),
			"PreHandler:onNewline", this.nlRank, 'newline');
		this.manager.addTransform(this.onEnd.bind(this),
			"PreHandler:onEnd", this.endRank, 'end');
		init(this, true);
	}
}

// Handler ranks
PreHandler.prototype.nlRank   = 2.051;
PreHandler.prototype.anyRank  = 2.052;
PreHandler.prototype.endRank  = 2.053;
PreHandler.prototype.skipRank = 2.054; // should be higher than all other ranks above

// FSM states
PreHandler.STATE_SOL = 1;
PreHandler.STATE_PRE = 2;
PreHandler.STATE_PRE_COLLECT = 3;
PreHandler.STATE_MULTILINE_PRE = 4;
PreHandler.STATE_IGNORE = 5;

// debug string output of FSM states
PreHandler.STATE_STR = {
	1: 'sol        ',
	2: 'pre        ',
	3: 'pre_collect',
	4: 'multiline  ',
	5: 'ignore     '
};

init = function(handler, addAnyHandler) {
	handler.state  = PreHandler.STATE_SOL;
	handler.lastNlTk = null;
	// Initialize to zero to deal with indent-pre
	// on the very first line where there is no
	// preceding newline to initialize this.
	handler.preTSR = 0;
	handler.tokens = [];
	handler.preWSToken = null;
	handler.multiLinePreWSToken = null;
	handler.solTransparentTokens = [];
	if (addAnyHandler) {
		handler.manager.addTransform(handler.onAny.bind(handler),
			"PreHandler:onAny", handler.anyRank, 'any');
	}
};

PreHandler.prototype.moveToIgnoreState = function() {
	this.state = PreHandler.STATE_IGNORE;
	this.manager.removeTransform(this.anyRank, 'any');
};

PreHandler.prototype.popLastNL = function(ret) {
	if (this.lastNlTk) {
		ret.push(this.lastNlTk);
		this.lastNlTk = null;
	}
};

PreHandler.prototype.getResultAndReset = function(token) {
	this.popLastNL(this.tokens);

	var ret = this.tokens;
	if (this.preWSToken) {
		ret.push(this.preWSToken);
		this.preWSToken = null;
	}
	if (this.solTransparentTokens.length > 0) {
		ret = ret.concat(this.solTransparentTokens);
		this.solTransparentTokens = [];
	}
	ret.push(token);
	this.tokens = [];
	this.multiLinePreWSToken = null;

	ret.rank = this.skipRank; // prevent this from being processed again
	return ret;
};

PreHandler.prototype.processPre = function(token) {
	var ret = [];

	// pre only if we have tokens to enclose
	if (this.tokens.length > 0) {
		var da = null;
		if (this.preTSR !== -1) {
			da = { tsr: [this.preTSR, this.preTSR+1] };
		}
		ret = [ new TagTk('pre', [], da) ].concat(ret).concat(this.tokens);
		ret.push(new EndTagTk('pre'));
	}

	// emit multiline-pre WS token
	if (this.multiLinePreWSToken) {
		ret.push(this.multiLinePreWSToken);
		this.multiLinePreWSToken = null;
	}

	this.popLastNL(ret);

	// sol-transparent toks
	ret = ret.concat(this.solTransparentTokens);

	// push the the current token
	ret.push(token);

	// reset!
	this.solTransparentTokens = [];
	this.tokens = [];

	ret.rank = this.skipRank; // prevent this from being processed again
	return ret;
};

PreHandler.prototype.onNewline = function (token, manager, cb) {
	function initPreTSR(nltk) {
		var da = nltk.dataAttribs;
		// tsr[1] can never be zero, so safe to use da.tsr[1] to check for null/undefined
		return (da && da.tsr && da.tsr[1]) ? da.tsr[1] : -1;
	}

	if (this.trace) {
		if (this.debug) { console.warn("----------"); }
		console.warn("T:pre:nl : " + PreHandler.STATE_STR[this.state] + " : " + JSON.stringify(token));
	}

	// Whenever we move into SOL-state, init preTSR to
	// the newline's tsr[1].  This will later be  used
	// to assign 'tsr' values to the <pre> token.

	var ret = null;
	switch (this.state) {
		case PreHandler.STATE_SOL:
			ret = this.getResultAndReset(token);
			this.preTSR = initPreTSR(token);
			break;

		case PreHandler.STATE_PRE:
			ret = this.getResultAndReset(token);
			this.preTSR = initPreTSR(token);
			this.state = PreHandler.STATE_SOL;
			break;

		case PreHandler.STATE_PRE_COLLECT:
			this.lastNlTk = token;
			this.state = PreHandler.STATE_MULTILINE_PRE;
			break;

		case PreHandler.STATE_MULTILINE_PRE:
			ret = this.processPre(token);
			this.preTSR = initPreTSR(token);
			this.state = PreHandler.STATE_SOL;
			break;

		case PreHandler.STATE_IGNORE:
			ret = [token];
			ret.rank = this.skipRank; // prevent this from being processed again
			init(this, true); // Reset!
			this.preTSR = initPreTSR(token);
			break;
	}

	if (this.debug) {
		console.warn("saved: " + JSON.stringify(this.tokens));
		console.warn("ret  : " + JSON.stringify(ret));
	}

	return { tokens: ret };
};

PreHandler.prototype.onEnd = function (token, manager, cb) {
	this.inPre = false;

	if (this.state !== PreHandler.STATE_IGNORE) {
		console.error("!ERROR! Not IGNORE! Cannot get here: " + this.state + "; " + JSON.stringify(token));
		init(this, false);
		return {tokens: [token]};
	}

	init(this, true);
	return {tokens: [token]};
};

function getUpdatedPreTSR(tsr, token) {
	var tc = token.constructor;
	if (tc === CommentTk) {
		tsr = token.dataAttribs.tsr ? token.dataAttribs.tsr[1] : (tsr === -1 ? -1 : token.value.length + 7 + tsr);
	} else if (tc === SelfclosingTagTk) {
		// meta-tag (cannot compute)
		tsr = -1;
	} else if (tsr !== -1) {
		// string
		tsr = tsr + token.length;
	}

	return tsr;
}

PreHandler.prototype.onAny = function ( token, manager, cb ) {

	if ( isPre( token, TagTk ) ) {
		this.inPre = true;
	} else if ( isPre( token, EndTagTk ) ) {
		this.inPre = false;
	}

	if (this.trace) {
		if (this.debug) { console.warn("----------"); }
		console.warn("T:pre:any: " + PreHandler.STATE_STR[this.state] + " : " + JSON.stringify(token));
	}

	if (this.state === PreHandler.STATE_IGNORE) {
		console.error("!ERROR! IGNORE! Cannot get here: " + JSON.stringify(token));
		return {tokens: null};
	}

	var ret = null;
	var tc = token.constructor;
	if (tc === EOFTk) {
		switch (this.state) {
			case PreHandler.STATE_SOL:
			case PreHandler.STATE_PRE:
				ret = this.getResultAndReset(token);
				break;

			case PreHandler.STATE_PRE_COLLECT:
			case PreHandler.STATE_MULTILINE_PRE:
				ret = this.processPre(token);
				break;
		}

		// reset for next use of this pipeline!
		this.inPre = false;
		init(this, false);
	} else {
		switch (this.state) {
			case PreHandler.STATE_SOL:
				if ((tc === String) && token.match(/^ /) && !this.inPre) {
					ret = this.tokens;
					this.tokens = [];
					this.preWSToken = token[0];
					this.state = PreHandler.STATE_PRE;
					if (!token.match(/^ $/)) {
						// Treat everything after the first space
						// as a new token
						this.onAny(token.slice(1), manager, cb);
					}
				} else if (Util.isSolTransparent(token)) {
					// continue watching ...
					// update pre-tsr since we haven't transitioned to PRE yet
					this.preTSR = getUpdatedPreTSR(this.preTSR, token);
					this.tokens.push(token);
				} else {
					ret = this.getResultAndReset(token);
					this.moveToIgnoreState();
				}
				break;

			case PreHandler.STATE_PRE:
				if (Util.isSolTransparent(token)) { // continue watching
					this.solTransparentTokens.push(token);
				} else if (Util.isTableTag(token) ||
					(token.isHTMLTag() && Util.isBlockTag(token.name)))
				{
					ret = this.getResultAndReset(token);
					this.moveToIgnoreState();
				} else {
					this.tokens = this.tokens.concat(this.solTransparentTokens);
					this.tokens.push(token);
					this.solTransparentTokens = [];
					// discard pre/multiline-pre ws tokens that got us here
					this.preWSToken = null;
					this.multiLinePreWSToken = null;
					this.state = PreHandler.STATE_PRE_COLLECT;
				}
				break;

			case PreHandler.STATE_PRE_COLLECT:
				if (token.isHTMLTag && token.isHTMLTag() && Util.isBlockTag(token.name)) {
					ret = this.processPre(token);
					this.moveToIgnoreState();
				} else {
					// discard pre/multiline-pre ws tokens that got us here
					this.preWSToken = null;
					this.multiLinePreWSToken = null;
					// nothing to do .. keep collecting!
					this.tokens.push(token);
				}
				break;

			case PreHandler.STATE_MULTILINE_PRE:
				if ((tc === String) && token.match(/^ /)) {
					this.popLastNL(this.tokens);
					this.state = PreHandler.STATE_PRE_COLLECT;

					// Pop buffered sol-transparent tokens
					this.tokens = this.tokens.concat(this.solTransparentTokens);
					this.solTransparentTokens = [];

					// check if token is single-space or more
					this.multiLinePreWSToken = token[0];
					if (!token.match(/^ $/)) {
						// Treat everything after the first space as a new token
						this.onAny(token.slice(1), manager, cb);
					}
				} else if (Util.isSolTransparent(token)) { // continue watching
					this.solTransparentTokens.push(token);
				} else {
					ret = this.processPre(token);
					this.moveToIgnoreState();
				}
				break;
		}
	}

	if (this.debug) {
		console.warn("saved: " + JSON.stringify(this.tokens));
		console.warn("ret  : " + JSON.stringify(ret));
	}

	return { tokens: ret };
};

if (typeof module === "object") {
	module.exports.PreHandler = PreHandler;
}
