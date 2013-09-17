"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

/* ------------------------------------------------------------------------
 * Non-IEW (inter-element-whitespace) can only be found in <td> <th> and
 * <caption> tags in a table.  If found elsewhere within a table, such
 * content will be moved out of the table and be "adopted" by the table's
 * sibling ("foster parent"). The content that gets adopted is "fostered
 * content".
 *
 * http://dev.w3.org/html5/spec-LC/tree-construction.html#foster-parenting
 * ------------------------------------------------------------------------ */

// cleans up transclusion shadows, keeping track of fostered transclusions
function removeTransclusionShadows( node ) {
	var sibling, fosteredTransclusions = false;
	if ( DU.isElt( node ) ) {
		if ( DU.isMarkerMeta( node, "mw:TransclusionShadow" ) ) {
			DU.deleteNode( node );
			return true;
		} else if ( node.data.parsoid.inTransclusion ) {
			fosteredTransclusions = true;
			delete node.data.parsoid.inTransclusion;
		}
		node = node.firstChild;
		while ( node ) {
			sibling = node.nextSibling;
			if ( removeTransclusionShadows( node ) ) {
				fosteredTransclusions = true;
			}
			node = sibling;
		}
	}
	return fosteredTransclusions;
}

// inserts metas around the fosterbox and table
function insertTransclusionMetas( env, fosterBox, table ) {

	// skip if foster box itself is in transclusion
	// avoid unnecessary insertions and case where table doesn't have tsr info
	if ( fosterBox.data.parsoid.inTransclusion ) {
		return;
	}

	// find tsr[1] and end-boundary
	var tsr1, sibling = table.nextSibling;
	while ( sibling ) {
		if ( sibling.data.parsoid.tsr ) {
			tsr1 = sibling.data.parsoid.tsr[ 1 ];
			break;
		}
		sibling = sibling.nextSibling;
	}
	if ( typeof tsr1 !== "number" ) {
		tsr1 = table.parentNode.data.parsoid.tsr[ 1 ];
	}

	// get a new about id
	var aboutId = env.newAboutId();

	//  create start-meta and insert
	var s = DU.createNodeWithAttributes( fosterBox.ownerDocument, "meta", {
		"about": aboutId,
		"id": aboutId.substring( 1 ),
		"typeof": "mw:Transclusion",
		"data-parsoid": JSON.stringify({
			"tsr": [ table.data.parsoid.tsr[ 0 ], tsr1 ]
		})
	});
	fosterBox.parentNode.insertBefore( s, fosterBox );

	// create end-meta, find insertion-point, and insert
	var e = DU.createNodeWithAttributes( table.ownerDocument, "meta", {
		"about": aboutId,
		"typeof": "mw:Transclusion/End"
	});

	// skip table end mw:shadow
	if ( sibling && DU.isMarkerMeta( sibling, "mw:EndTag" ) ) {
		sibling = sibling.nextSibling;
	}

	// special case where the table end and inner transclusion coincide
	if ( sibling && DU.isMarkerMeta( sibling, "mw:Transclusion/End" ) ) {
		sibling = sibling.nextSibling;
	}

	table.parentNode.insertBefore( e, sibling );

}

// Searches for FosterBoxes and does two things when it hits one:
// * Marks all nextSiblings as fostered until the accompanying table.
// * Wraps the whole thing (table + fosterbox) with transclusion metas if
//   there is any fostered transclusion content.
function markFosteredContent( node, env ) {
	var span, sibling, next, fosteredTransclusions, c = node.firstChild;

	while ( c ) {
		sibling = c.nextSibling;
		fosteredTransclusions = false;

		if ( DU.isMarkerMeta( c, "mw:FosterBox" ) ) {

			// mark as fostered until we hit the table
			while ( !DU.isElt( sibling ) || !DU.hasNodeName( sibling, "table" ) ) {
				next = sibling.nextSibling;
				if ( DU.isElt( sibling ) ) {
					sibling.data.parsoid.fostered = true;
					if ( removeTransclusionShadows( sibling ) ) {
						fosteredTransclusions = true;
					}
				} else {
					span = sibling.ownerDocument.createElement( "span" );
					span.data = { parsoid: { fostered: true } };
					sibling.parentNode.insertBefore( span, sibling );
					span.appendChild( sibling );
				}
				sibling = next;
			}

			// we have fostered transclusions
			// wrap the whole thing in a transclusion
			if ( fosteredTransclusions ) {
				insertTransclusionMetas( env, c, sibling );
			}

			// remove the foster box
			DU.deleteNode( c );

		} else if ( DU.isMarkerMeta( c, "mw:TransclusionShadow" ) ) {
			DU.deleteNode( c );
		} else if ( c.childNodes.length > 0 ) {
			markFosteredContent( c, env );
		}

		c = sibling;
	}

}

if ( typeof module === "object" ) {
	module.exports.markFosteredContent = markFosteredContent;
}