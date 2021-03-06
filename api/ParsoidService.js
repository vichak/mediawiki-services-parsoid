/*
 * Simple Parsoid web service.
 */
"use strict";

/**
 * @class ParserServiceModule
 * @singleton
 * @private
 */

// global includes
var express = require('express'),
	domino = require('domino'),
	hbs = require('handlebars'),
	// memwatch = require('memwatch'),
	childProc = require('child_process'),
	cluster = require('cluster'),
	fs = require('fs'),
	path = require('path'),
	util = require('util'),
	pkg = require('../package.json'),
	Diff = require('../lib/mediawiki.Diff.js').Diff,
	LogData = require('../lib/LogData.js').LogData;

// local includes
var mp = '../lib/';


function ParsoidService(options) {
	/**
	 * The name of this instance.
	 * @property {string}
	 */
	var instanceName = cluster.isWorker ? 'worker(' + process.pid + ')' : 'master';

	console.log( ' - ' + instanceName + ' loading...' );

	var WikitextSerializer = require(mp + 'mediawiki.WikitextSerializer.js').WikitextSerializer,
		SelectiveSerializer = require( mp + 'mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
		Util = require( mp + 'mediawiki.Util.js' ).Util,
		DU = require( mp + 'mediawiki.DOMUtils.js' ).DOMUtils,
		libtr = require(mp + 'mediawiki.ApiRequest.js'),
		ParsoidConfig = require( mp + 'mediawiki.ParsoidConfig' ).ParsoidConfig,
		MWParserEnvironment = require( mp + 'mediawiki.parser.environment.js' ).MWParserEnvironment,
		TemplateRequest = libtr.TemplateRequest;


/**
	 * Set header, but only if response hasn't been sent.
	 *
	 * @method
	 * @param {MWParserEnvironment} env
	 * @param {Response} res The response object from our routing function.
	 * @property {Function} Serializer
	 */
	function setHeader (res, env) {
		if (env.responseSent) {
			return;
		} else {
			res.setHeader.apply(res, Array.prototype.slice.call(arguments, 2));
		}
	}

	/**
	 * End response, but only if response hasn't been sent.
	 *
	 * @method
	 * @param {MWParserEnvironment} env
	 * @param {Response} res The response object from our routing function.
	 * @property {Function} Serializer
	 */
	function endResponse (res, env) {
		if (env.responseSent) {
			return;
		} else {
			env.responseSent = true;
			res.end.apply(res, Array.prototype.slice.call(arguments, 2));
			env.log("end/response");
		}
	}

	/**
	 * Send response, but only if response hasn't been sent.
	 *
	 * @method
	 * @param {MWParserEnvironment} env
	 * @param {Response} res The response object from our routing function.
	 * @property {Function} Serializer
	 */
	function sendResponse (res, env) {
		if (env.responseSent) {
			return;
		} else {
			env.responseSent = true;
			res.send.apply(res, Array.prototype.slice.call(arguments, 2));
		}
	}

	/**
	 * Render response, but only if response hasn't been sent.
	 */

	function renderResponse(res, env) {
		if (env.responseSent) {
			return;
		} else {
			env.responseSent = true;
			res.render.apply(res, Array.prototype.slice.call(arguments, 2));
		}
	}

	/**
	 * The global parsoid configuration object.
	 * @property {ParsoidConfig}
	 */
	var parsoidConfig = new ParsoidConfig( options, null );

	/**
	 * The serializer to use for the web requests.
	 * @property {Function} Serializer
	 */
	var Serializer = parsoidConfig.useSelser ? SelectiveSerializer : WikitextSerializer;

	/**
	 * Get the interwiki regexp.
	 *
	 * @method
	 * @returns {RegExp} The regular expression that matches to all interwikis accepted by the API.
	 */
	var interwikiRE;
	function getInterwikiRE() {
		// this RE won't change -- so, cache it
		if (!interwikiRE) {
			interwikiRE = parsoidConfig.interwikiRegexp;
		}
		return interwikiRE;
	}

	var htmlSpecialChars = function ( s ) {
		return s.replace(/&/g,'&amp;')
			.replace(/</g,'&lt;')
			.replace(/"/g,'&quot;')
			.replace(/'/g,'&#039;');
	};

	var roundTripDiff = function ( selser, req, res, env, document ) {
		var out = [];

		var finalCB =  function () {
			var i;
			out = out.join('');

			// Strip selser trigger comment
			out = out.replace(/<!--rtSelserEditTestComment-->\n*$/, '');

			// Emit base href so all relative urls resolve properly
			var hNodes = document.body.firstChild.childNodes;
			var headNodes = "";
			for (i = 0; i < hNodes.length; i++) {
				if (hNodes[i].nodeName.toLowerCase() === 'base') {
					headNodes += DU.serializeNode(hNodes[i]);
					break;
				}
			}

			var bNodes = document.body.childNodes;
			var bodyNodes = "";
			for (i = 0; i < bNodes.length; i++) {
				bodyNodes += DU.serializeNode(bNodes[i]);
			}

			var htmlSpeChars = htmlSpecialChars(out);

			var src = env.page.src.replace(/\n(?=\n)/g, '\n ');
			out = out.replace(/\n(?=\n)/g, '\n ');

			var patch = Diff.convertChangesToXML( Diff.diffLines(src, out) );

			setHeader(res, env, 'X-Parsoid-Performance', env.getPerformanceHeader());

			renderResponse(res, env, "roundtrip", {
				headers: headNodes,
				bodyNodes: bodyNodes,
				htmlSpeChars: htmlSpeChars,
				patch: patch,
				reqUrl: req.url
			});

			env.log("info", "completed parsing in", env.performance.duration, "ms");
		};

		// Re-parse the HTML to uncover foster-parenting issues
		document = domino.createDocument(document.outerHTML);

		var Serializer = selser ? SelectiveSerializer : WikitextSerializer;
		new Serializer({ env: env }).serializeDOM(
			document.body,
			function( chunk ) { out.push(chunk); },
			finalCB
		);
	};

	function handleCacheRequest( env, req, res, cb, src, cacheErr, cacheSrc ) {
		var errorHandlingCB = function ( src, err, doc ) {
			if ( err ) {
				env.log("fatal/request", err);
				return;
			}
			cb( req, res, src, doc );
		};

		if ( cacheErr ) {
			// No luck with the cache request, just proceed as normal.
			Util.parse(env, errorHandlingCB, null, src);
			return;
		}
		// Extract transclusion and extension content from the DOM
		var expansions = DU.extractExpansions(DU.parseHTML(cacheSrc));

		// Figure out what we can reuse
		var parsoidHeader = JSON.parse(req.headers['x-parsoid'] || '{}');
		if (parsoidHeader.cacheID) {
			if (parsoidHeader.mode === 'templates') {
				// Transclusions need to be updated, so don't reuse them.
				expansions.transclusions = {};
			} else if (parsoidHeader.mode === 'files') {
				// Files need to be updated, so don't reuse them.
				expansions.files = {};
			}
		}

		// pass those expansions into Util.parse to prime the caches.
		//console.log('expansions:', expansions);
		Util.parse(env, errorHandlingCB, null, src, expansions);
	}

	var parse = function ( env, req, res, cb, err, src_and_metadata ) {
		if ( err ) {
			env.log("fatal/request", err);
			return;
		}

		// Set the source
		env.setPageSrcInfo( src_and_metadata );

		// Now env.page.meta.title has the canonical title, and
		// env.page.meta.revision.parentid has the predecessor oldid

		// See if we can reuse transclusion or extension expansions.
		if (env.conf.parsoid.parsoidCacheURI &&
				// And don't parse twice for recursive parsoid requests
				! req.headers['x-parsoid-request'])
		{
			// Try to retrieve a cached copy of the content so that we can recycle
			// template and / or extension expansions.
			var parsoidHeader = JSON.parse(req.headers['x-parsoid'] || '{}'),
				// If we get a prevID passed in in X-Parsoid (from our PHP
				// extension), use that explicitly. Otherwise default to the
				// parentID.
				cacheID = parsoidHeader.cacheID ||
					env.page.meta.revision.parentid,
				cacheRequest = new libtr.ParsoidCacheRequest(env,
					env.page.meta.title, cacheID);
			cacheRequest.once('src',
					handleCacheRequest.bind(null, env, req, res, cb, env.page.src));
		} else {
			handleCacheRequest(env, req, res, cb, env.page.src, "Recursive request", null);
		}
	};


	/**
	 * Send a redirect response with optional code and a relative URL
	 *
	 * (Returns if a response has already been sent.)
	 * This is not strictly HTTP spec conformant, but works in most clients. More
	 * importantly, it works both behind proxies and on the internal network.
	 */
	function relativeRedirect(args) {
		if (!args.code) {
			args.code = 302; // moved temporarily
		}

		if (args.res && args.env && args.env.responseSent ) {
			return;
		} else {
			args.res.writeHead(args.code, {
				'Location': args.path
			});
			args.res.end();
		}
	}

	/* -------------------- web app access points below --------------------- */

	var app = express.createServer();

	// view engine
	app.set('views', path.join(__dirname, '/views'));
	app.set('view engine', 'html');
	app.register('html', hbs);

	// block helper to reference js files in page head.
	hbs.registerHelper('jsFiles', function(options){
		this.javascripts = options.fn(this);
	});

	// serve static files
	app.use("/static", express.static(path.join(__dirname, "/static")));

	// favicon
	app.use(express.favicon(path.join(__dirname, "favicon.ico")));

	// Increase the form field size limit from the 2M default.
	app.use(express.bodyParser({maxFieldsSize: 15 * 1024 * 1024}));

	// Support gzip / deflate transfer-encoding
	app.use(express.compress());

	// limit upload file size
	app.use(express.limit('15mb'));

	app.get('/', function(req, res){
		res.render('home');
	});

	function interParams( req, res, next ) {
		res.local('iwp', req.params[0] || parsoidConfig.defaultWiki || '');
		res.local('pageName', req.params[1] || '');
		next();
	}

	function parserEnvMw( req, res, next ) {
		MWParserEnvironment.getParserEnv( parsoidConfig, null, res.local('iwp'), res.local('pageName'), req.headers.cookie, function ( err, env ) {

			function errCB ( res, env, logData, callback ) {
				try {
					if ( !env.responseSent ) {
						setHeader(res, env, 'Content-Type', 'text/plain; charset=UTF-8' );
						sendResponse(res, env, logData.fullMsg(), logData.code || 500);
						if ( typeof callback === 'function' ) {
							res.on('finish', callback);
						}
						return;
					}
				} catch (e) {
					console.log( e.stack || e );
					res.end();
				}
				if ( typeof callback === 'function' ) {
					callback();
				}
			}

			if ( err ) {
				return errCB(res, {}, new LogData(null, "error", err));
			}

			env.logger.registerBackend(/fatal(\/.*)?/, errCB.bind(this, res, env));
			res.local("env", env);
			next();
		});
	}

	// robots.txt: no indexing.
	app.get(/^\/robots.txt$/, function ( req, res ) {
		res.end("User-agent: *\nDisallow: /\n" );
	});

	// Redirects for old-style URL compatibility
	app.get( new RegExp( '^/((?:_rt|_rtve)/)?(' + getInterwikiRE() +
					'):(.*)$' ), function ( req, res ) {
		if ( req.params[0] ) {
			relativeRedirect({"path" : '/' + req.params[0] + req.params[1] + '/' + req.params[2], "res" : res, "code" : 301});
		} else {
			relativeRedirect({"path" : '/' + req.params[1] + '/' + req.params[2], "res" : res, "code": 301});
		}
		res.end();
	});

	function action( res ) {
		return [ "", res.local('iwp'), res.local('pageName') ].join( "/" );
	}

	// Form-based HTML DOM -> wikitext interface for manual testing
	app.get( new RegExp('/_html/(?:(' + getInterwikiRE() + ')/(.*))?'), interParams, parserEnvMw, function ( req, res ) {
		var env = res.local('env');
		renderResponse(res, env, "form", {
			title: "Your HTML DOM:",
			action: action(res),
			name: "html"
		});
	});

	// Form-based wikitext -> HTML DOM interface for manual testing
	app.get( new RegExp('/_wikitext/(?:(' + getInterwikiRE() + ')/(.*))?'), interParams, parserEnvMw, function ( req, res ) {
		var env = res.local('env');
		renderResponse(res, env, "form", {
			title: "Your wikitext:",
			action: action(res),
			name: "wt"
		});
	});

	// Round-trip article testing
	app.get( new RegExp('/_rt/(?:(' + getInterwikiRE() + ')/(.*))?'), interParams, parserEnvMw, function(req, res) {
		var env = res.local('env');
		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		req.connection.setTimeout(300 * 1000);
		env.log('info', 'starting parsing');

		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		var tpr = new TemplateRequest( env, target, oldid );
		tpr.once('src', parse.bind( tpr, env, req, res, roundTripDiff.bind( null, false ) ));
	});

	// Round-trip article testing with newline stripping for editor-created HTML
	// simulation
	app.get( new RegExp('/_rtve/(' + getInterwikiRE() + ')/(.*)'), interParams, parserEnvMw, function(req, res) {
		var env = res.local('env');
		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		env.log('info', 'starting parsing');
		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		var tpr = new TemplateRequest( env, target, oldid ),
			cb = function ( req, res, src, document ) {
				// strip newlines from the html
				var html = document.innerHTML.replace(/[\r\n]/g, ''),
					newDocument = DU.parseHTML(html);
				roundTripDiff( false, req, res, src, newDocument );
			};

		tpr.once('src', parse.bind( tpr, env, req, res, cb ));
	});

	// Round-trip article testing with selser over re-parsed HTML.
	app.get( new RegExp('/_rtselser/(' + getInterwikiRE() + ')/(.*)'), interParams, parserEnvMw, function (req, res) {
		var env = res.local('env');
		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		env.log('info', 'starting parsing');
		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		var tpr = new TemplateRequest( env, target, oldid ),
			tprCb = function ( req, res, src, document ) {
				var newDocument = DU.parseHTML( DU.serializeNode(document) ),
					newNode = newDocument.createComment('rtSelserEditTestComment');
				newDocument.body.appendChild(newNode);
				roundTripDiff( true, req, res, src, newDocument );
			};

		tpr.once( 'src', parse.bind( tpr, env, req, res, tprCb ) );
	});

	// Form-based round-tripping for manual testing
	app.get( new RegExp('/_rtform/(?:(' + getInterwikiRE() + ')/(.*))?'), interParams, parserEnvMw, function ( req, res ) {
		var env = res.local('env');
		renderResponse(res, env, "form", {
			title: "Your wikitext:",
			action: "/_rtform/" + res.local('pageName'),
			name: "content"
		});
	});

	app.post( new RegExp('/_rtform/(?:(' + getInterwikiRE() + ')/(.*))?'), interParams, parserEnvMw, function ( req, res ) {
		var env = res.local('env');
		setHeader(res, env, 'Content-Type', 'text/html; charset=UTF-8');
		// we don't care about \r, and normalize everything to \n
		parse( env, req, res, roundTripDiff.bind( null, false ), null, {
			revision: { '*': req.body.content.replace(/\r/g, '') }
		});
	});

	function html2wt( req, res, html ) {
		var env = res.local('env');
		env.page.id = req.body.oldid || null;

		if ( env.conf.parsoid.allowCORS ) {
			// allow cross-domain requests (CORS) so that parsoid service
			// can be used by third-party sites
			setHeader(res, env, 'Access-Control-Allow-Origin',
						   env.conf.parsoid.allowCORS );
		}

		var html2wtCb = function () {
			var doc;
			try {
				doc = DU.parseHTML( html.replace( /\r/g, '' ) );
			} catch ( e ) {
				env.log("fatal", e, "There was an error in the HTML5 parser!");
				return;
			}

			try {
				var out = [];
				new Serializer( { env: env, oldid: env.page.id } ).serializeDOM(
					doc.body,
					function ( chunk ) {
						out.push( chunk );
					}, function () {
						setHeader(res, env, 'Content-Type', 'text/x-mediawiki; charset=UTF-8' );
						setHeader(res, env, 'X-Parsoid-Performance', env.getPerformanceHeader() );
						endResponse(res, env,  out.join( '' ) );
					} );
			} catch ( e ) {
				env.log("fatal", e);
				return;
			}
		};

		if ( env.conf.parsoid.fetchWT ) {
			var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );
			var tpr = new TemplateRequest( env, target, env.page.id );
			tpr.once( 'src', function ( err, src_and_metadata ) {
				if ( err ) {
					env.log("error", "There was an error fetching the original wikitext for", target, err);
				} else {
					env.setPageSrcInfo( src_and_metadata );
				}
				html2wtCb();
			} );
		} else {
			html2wtCb();
		}
	}

	function wt2html( req, res, wt ) {
		var env = res.local('env');
		var prefix = res.local('iwp');
		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		// Set the timeout to 600 seconds..
		req.connection.setTimeout( 600 * 1000 );

		if ( env.conf.parsoid.allowCORS ) {
			// allow cross-domain requests (CORS) so that parsoid service
			// can be used by third-party sites
			setHeader(res, env, 'Access-Control-Allow-Origin',
						   env.conf.parsoid.allowCORS );
		}

		var tmpCb,
			oldid = req.query.oldid || null;
		if ( wt ) {
			wt = wt.replace( /\r/g, '' );
			env.log('info', 'starting parsing');

			// clear default page name
			if ( !res.local('pageName') ) {
				env.page.name = '';
			}

			var parser = env.pipelineFactory.getPipeline('text/x-mediawiki/full');
			parser.once( 'document', function ( document ) {
				// Don't cache requests when wt is set in case somebody uses
				// GET for wikitext parsing
				setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0' );
				sendRes( req.body.body ? document.body : document );
			});

			tmpCb = function ( err, src_and_metadata ) {
				if ( err ) {
					env.log("fatal/request", err);
					return;
				}

				// Set the source
				env.setPageSrcInfo( src_and_metadata );

				try {
					parser.processToplevelDoc( wt );
				} catch ( e ) {
					env.log("fatal", e);
					return;
				}
			};

			if ( !res.local('pageName') || !oldid ) {
				// no pageName supplied; don't fetch the page source
				tmpCb( null, wt );
				return;
			}

		} else {
			if ( oldid ) {
				env.log('info', 'starting parsing');

				if ( !req.headers.cookie ) {
					setHeader(res, env, 'Cache-Control', 's-maxage=2592000' );
				} else {
					// Don't cache requests with a session
					setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0' );
				}
				tmpCb = parse.bind( null, env, req, res, function ( req, res, src, doc ) {
					sendRes( doc.documentElement );
				});
			} else {
				// Don't cache requests with no oldid
				setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0' );
				tmpCb = function ( err, src_and_metadata ) {
					if ( err ) {
						env.log("fatal/request", err);
						return;
					}

					// Set the source
					env.setPageSrcInfo( src_and_metadata );
					var url = [ "", prefix,
								encodeURIComponent( target ) +
								"?oldid=" + env.page.meta.revision.revid
							].join( "/" );

					// Redirect to oldid
					relativeRedirect({"path" : url, "res" : res, "env" : env});
					env.log("info", "redirected to revision", env.page.meta.revision.revid);
				};
			}
		}

		var tpr = new TemplateRequest( env, target, oldid );
		tpr.once( 'src', tmpCb );

		function sendRes( doc ) {
			var out = DU.serializeNode( doc );
			try {
				setHeader(res, env, 'X-Parsoid-Performance', env.getPerformanceHeader());
				setHeader(res, env, 'Content-Type', 'text/html; charset=UTF-8' );
				endResponse(res, env,  out );
				env.log("info", "completed parsing in", env.performance.duration, "ms");
			} catch (e) {
				env.log("fatal/request", e);
			}
		}
	}

	// Regular article parsing
	app.get( new RegExp( '/(' + getInterwikiRE() + ')/(.*)' ), interParams, parserEnvMw, function(req, res) {
		wt2html( req, res );
	});

	// Regular article serialization using POST
	app.post( new RegExp( '/(' + getInterwikiRE() + ')/(.*)' ), interParams, parserEnvMw, function ( req, res ) {
		// parse html or wt
		if ( req.body.wt ) {
			wt2html( req, res, req.body.wt );
		} else {
			html2wt( req, res, req.body.html || req.body.content || '' );
		}
	});

	var version = {
		name: pkg.name,
		version: pkg.version
	};

	function gitVersion( cb ) {
		fs.exists( path.join( __dirname, '/../.git' ), function ( exists ) {
			if ( !exists ) {
				cb();
				return;
			}
			childProc.exec(
				'git rev-parse HEAD',
				function ( error, stdout, stderr ) {
					if ( !error ) {
						version.sha = stdout.slice(0, -1);
					}
					cb();
			});
		});
	}

	/**
	* Return Parsoid version based on package.json + git sha1 if available
	*/
	app.get( "/_version", function ( req, res ) {
		res.json( version );
	});

	// Get host and port from the environment, if available
	// VCAP_APP_PORT is for appfog.com support
	var port = parsoidConfig.serverPort ||
		process.env.VCAP_APP_PORT || process.env.PORT || 8000;
	// default bind all
	var host = parsoidConfig.serverInterface || process.env.INTERFACE;

	app.on( 'error', function( err ) {
		if ( err.errno === "EADDRINUSE" ) {
			console.error( "Port %d is already in use. Exiting.", port );
			cluster.worker.disconnect();
		} else {
			console.error( err.message );
		}
	});

	gitVersion( function () {
		app.listen( port, host );
		console.log( ' - ' + instanceName + ' ready on ' +
		             (host||'') + ':' + port );
	});

}

module.exports = {
	ParsoidService: ParsoidService
};
