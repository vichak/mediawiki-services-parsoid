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

 + --------------+-----------------+---------------+--------------------------+
 | Start state   |     Token       | End state     |  Action                  |
 + --------------+-----------------+---------------+--------------------------+
 | SOL           | --- nl      --> | SOL           | purge                    |
 | SOL           | --- eof     --> | SOL           | purge                    |
 | SOL           | --- ws      --> | PRE           | -- nothing to do --      |
 | SOL           | --- sol-tr  --> | SOL           | TOKS << tok              |
 | SOL           | --- other   --> | IGNORE        | purge                    |
 + --------------+-----------------+---------------+--------------------------+
 | PRE           | --- nl      --> | SOL           | purge   if |TOKS| == 0   |
 |               |                 |               | gen-pre if |TOKS| > 0    |
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
 | MULTILINE_PRE | --- ws      --> | PRE           | pop saved nl token       |
 | MULTILINE_PRE | --- sol-tr  --> | MULTILINE_PRE | SOL-TR-TOKS << tok       |
 | MULTILINE_PRE | --- any     --> | IGNORE        | gen-pre                  |
 + --------------+-----------------+---------------+--------------------------+
 | IGNORE        | --- nl      --> | SOL           | purge                    |
 | IGNORE        | --- eof     --> | SOL           | purge                    |
 + --------------+-----------------+---------------+--------------------------+

 * --------------------------------------------------------------------------*/

var Util = require('./mediawiki.Util.js').Util;

// Constructor
function PreHandler( manager, options ) {
	this.manager = manager;
	this.manager.addTransform(this.onNewline.bind(this),
		"PreHandler:onNewline", this.nlRank, 'newline');
	this.manager.addTransform(this.onEnd.bind(this),
		"PreHandler:onEnd", this.endRank, 'end');
	init(this, true);
}

// Handler ranks
PreHandler.prototype.nlRank   = 2.01;
PreHandler.prototype.anyRank  = 2.02;
PreHandler.prototype.endRank  = 2.03;
PreHandler.prototype.skipRank = 2.04; // should be higher than all other ranks above

// FSM states
PreHandler.STATE_SOL = 1;
PreHandler.STATE_PRE = 2;
PreHandler.STATE_PRE_COLLECT = 3;
PreHandler.STATE_MULTILINE_PRE = 4;
PreHandler.STATE_IGNORE = 5;

function init(handler, addAnyHandler) {
	handler.state  = PreHandler.STATE_SOL;
	handler.lastNLTk = null;
	handler.tokens = [];
	handler.solTransparentTokens = [];
	if (addAnyHandler) {
		handler.manager.addTransform(handler.onAny.bind(handler),
			"PreHandler:onAny", handler.anyRank, 'any');
	}
}

function isSolTransparent(token) {
	var tc = token.constructor;
	if (tc === String) {
		if (token.match(/[^\s]/)) {
			return false;
		}
	} else if (tc !== CommentTk && (tc !== SelfclosingTagTk || token.name !== 'meta')) {
		return false;
	}

	return true;
}

PreHandler.prototype.moveToIgnoreState = function() {
	this.state = PreHandler.STATE_IGNORE;
	this.manager.removeTransform(this.anyRank, 'any');
};

PreHandler.prototype.popLastNL = function(ret) {
	if (this.lastNlTk) {
		ret.push(this.lastNlTk);
		this.lastNlTk = null;
	}
}

PreHandler.prototype.getResultAndReset = function(token) {
	this.popLastNL(this.tokens);

	var ret = this.tokens;
	if (this.solTransparentTokens.length > 0) {
		// sol-transparent tokens can only follow a white-space token
		// which we ignored earlier (in PRE and MULTILINE_PRE states).
		// Recover it now.
		ret.push(' ');
		ret = ret.concat(this.solTransparentTokens);
		this.solTransparentTokens = [];
	}
	ret.push(token);
	this.tokens = [];

	ret.rank = this.skipRank; // prevent this from being processed again
	return ret;
};

PreHandler.prototype.processPre = function(token) {
	var ret = [];
	if (this.tokens.length === 0) {
		this.popLastNL(ret);
		var stToks = this.solTransparentTokens;
		ret = stToks.length > 0 ? [' '].concat(stToks) : stToks;
	} else {
		ret = [ new TagTk('pre') ].concat(this.tokens);
		ret.push(new EndTagTk('pre'));
		this.popLastNL(ret);
		ret = ret.concat(this.solTransparentTokens);
	}

	// push the the current token
	ret.push(token);

	// reset!
	this.solTransparentTokens = [];
	this.tokens = [];

	ret.rank = this.skipRank; // prevent this from being processed again
	return ret;
};

PreHandler.prototype.onNewline = function (token, manager, cb) {
/*
	console.warn("----------");
	console.warn("ST: " + this.state + "; NL: " + JSON.stringify(token));
*/

	var ret = null;
	switch (this.state) {
		case PreHandler.STATE_SOL:
			ret = this.getResultAndReset(token);
			break;

		case PreHandler.STATE_PRE:
			if (this.tokens.length > 0) {
				// we got here from a multiline-pre
				ret = this.processPre(token);
			} else {
				ret = this.getResultAndReset(token);
			}
			this.state = PreHandler.STATE_SOL;
			break;

		case PreHandler.STATE_PRE_COLLECT:
			this.lastNlTk = token;
			this.state = PreHandler.STATE_MULTILINE_PRE;
			break;

		case PreHandler.STATE_MULTILINE_PRE:
			ret = this.processPre(token);
			this.state = PreHandler.STATE_SOL;
			break;

		case PreHandler.STATE_IGNORE:
			ret = [token];
			ret.rank = this.skipRank; // prevent this from being processed again
			init(this, true); // Reset!
			break;
	}

/*
	console.warn("TOKS: " + JSON.stringify(this.tokens));
	console.warn("RET:  " + JSON.stringify(ret));
*/
	return { tokens: ret };
};

PreHandler.prototype.onEnd = function (token, manager, cb) {
	if (this.state !== PreHandler.STATE_IGNORE) {
		console.error("!ERROR! Not IGNORE! Cannot get here: " + this.state + "; " + JSON.stringify(token));
		init(this, false);
		return {tokens: [token]};
	}

	init(this, true);
	return {tokens: [token]};
};

PreHandler.prototype.onAny = function ( token, manager, cb ) {
/*
	console.warn("----------");
	console.warn("ST: " + this.state + "; T: " + JSON.stringify(token));
*/

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
		init(this, false);
	} else {
		switch (this.state) {
			case PreHandler.STATE_SOL:
				if ((tc === String) && token.match(/^\s/)) {
					ret = this.tokens;
					this.tokens = [];
					this.state = PreHandler.STATE_PRE;
				} else if (isSolTransparent(token)) { // continue watching
					this.tokens.push(token);
				} else {
					ret = this.getResultAndReset(token);
					this.moveToIgnoreState();
				}
				break;

			case PreHandler.STATE_PRE:
				if (isSolTransparent(token)) { // continue watching
					this.solTransparentTokens.push(token);
				} else {
					this.tokens = this.tokens.concat(this.solTransparentTokens);
					this.tokens.push(token);
					this.solTransparentTokens = [];
					this.state = PreHandler.STATE_PRE_COLLECT;
				}
				break;

			case PreHandler.STATE_PRE_COLLECT:
				if (token.isHTMLTag() && Util.isBlockTag(token.name)) {
					ret = this.processPre(token);
					this.moveToIgnoreState();
				} else {
					// nothing to do .. keep collecting!
					this.tokens.push(token);
				}
				break;

			case PreHandler.STATE_MULTILINE_PRE:
				if ((tc === String) && token.match(/^\s/)) {
					this.popLastNL(this.tokens);
					this.state = PreHandler.STATE_PRE;
					// Ignore white-space token. It will be recovered, if needed,
					// in getResultAndReset
				} else if (isSolTransparent(token)) { // continue watching
					this.solTransparentTokens.push(token);
				} else {
					ret = this.processPre(token);
					this.moveToIgnoreState();
				}
				break;
		}
	}

/*
	console.warn("TOKS: " + JSON.stringify(this.tokens));
	console.warn("RET:  " + JSON.stringify(ret));
*/

	return { tokens: ret };
};

if (typeof module === "object") {
	module.exports.PreHandler = PreHandler;
}
