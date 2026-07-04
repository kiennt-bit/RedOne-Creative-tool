WRMCB=function(e){var c=console;if(c&&c.log&&c.error){c.log('Error running batched script.');c.error(e);}}
;
try {
/* module-key = 'com.atlassian.confluence.plugins.confluence-highlight-actions:highlighting-experiment-resources', location = '/js/doctheme-utils.js' */
/**
 * Utility functions for working with the Documentation Theme
 * TO DO: This needs to live somewhere else, maybe the Confluence Core JS library
 */
define('confluence-highlight-actions/js/doctheme-utils', ['jquery'], function($) {
    'use strict';

    function appendAbsolutePositionedElement(node) {
        var $node = $(node);
        $(node).appendTo($('body'));
        return $node;
    }

    function getMainContentScrollTop() {
        return $(document).scrollTop();
    }

    function getMainContentScrollLeft() {
        return $(document).scrollLeft();
    }

    return {
        appendAbsolutePositionedElement: appendAbsolutePositionedElement,
        getMainContentScrollTop: getMainContentScrollTop,
        getMainContentScrollLeft: getMainContentScrollLeft
    };
});


require('confluence/module-exporter').exportModuleAsGlobal('confluence-highlight-actions/js/doctheme-utils', 'Confluence.DocThemeUtils');
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.confluence.plugins.confluence-highlight-actions:highlighting-experiment-resources', location = '/js/scrolling-inline-dialog.js' */
/**
 * An improved version of the inline dialog that scrolls correctly when using documentation theme
 * Because documentation theme uses a scrollable, fixed-height container, inline dialogs in documentation theme
 * would not scroll with the content. This fixes that issue
 *
 * Call this exactly as you would call AJS.InlineDialog()
 * https://developer.atlassian.com/display/AUI/Inline+Dialog
 *
 * @param items The elements that will trigger the inline-dialog, use a jQuery Selector to select items
 * @param identifier A unique identifier for the inline-dialog
 * @param url can be a url with dialog contents or a function to generate the dialog contents dynamically
 * @param options A number of different options may be passed in as an associative array
 * @returns the inline dialog
 */

define('confluence-highlight-actions/js/scrolling-inline-dialog', [
    'ajs',
    'jquery'
], function(
    AJS,
    $
) {
    'use strict';

    return function(items, identifier, url, options) {
        options = options || {};

        /**
         * This method is copied from Inline Dialog and MODIFIED to work with documentation theme
         *
         * Modifications:
         * Use position() instead of offset(), this returns the targetPosition coordinates relative to containing element
         *     and not the viewport
         * Adjust top values for scroll in docTheme
         * Use either window for the container or the docThemeContainer
         * has an extra isActionPanelDialog parameter to help position that dialog accordingly
         */
        var calculatePositions = function(popup, targetPosition, mousePosition, opts) {
            var popupLeft;    //position of the left edge of popup box from the left of the screen
            var popupRight = "auto";   //position of the right edge of the popup box fron the right edge of the screen
            var popupTop;   //position of the top edge of popup box
            var arrowOffsetY = -7;    //the offsets of the arrow from the top edge of the popup, default is the height of the arrow above the popup
            var arrowOffsetX;
            var displayAbove;   //determines if popup should be displayed above the the trigger or not
            var containerWidth = $(window).width();

            var targetOffset = targetPosition.target.position();
            var triggerWidth = targetPosition.target.outerWidth(); //The total width of the trigger (including padding)
            var middleOfTrigger = targetOffset.left + triggerWidth / 2;    //The absolute x position of the middle of the Trigger

            var bottomOfViewablePage = (window.pageYOffset || document.documentElement.scrollTop) + $(window).height();

            //CONSTANTS
            var SCREEN_PADDING = 10; //determines how close to the edge the dialog needs to be before it is considered offscreen
            var SCREEN_TOP_PADDING = 20; //keep the bottom of inline-dialog enough far from the bottom of browser.

            popupTop = targetOffset.top + targetPosition.target.outerHeight() + opts.offsetY;
            var arrowWidth = popup.find(".arrow").outerWidth();
            var popupOuterWidth = popup.outerWidth();
            var targetOuterWidth = targetPosition.target.outerWidth();
            if (opts.centerOnHighlight) {
                // if action panel is wider that the selection, center the arrow and the dialog above the selection
                if (popupOuterWidth > targetOuterWidth) {
                    popupLeft = targetOffset.left - (popupOuterWidth - targetOuterWidth) / 2;
                    arrowOffsetX = middleOfTrigger - popupLeft - arrowWidth / 2;
                } else {
                    // align left to selection and place arrow in the center of dialog
                    popupLeft = targetOffset.left + opts.offsetX;
                    arrowOffsetX = (popupOuterWidth - arrowWidth) / 2;
                }
            } else {
                // if not action panel, always align left the dialog to the selection
                popupLeft = targetOffset.left + opts.offsetX;
                // if the create issue popup is wider than the selection, center the arrow on the selection
                if (popupOuterWidth > targetOuterWidth) {
                    arrowOffsetX = middleOfTrigger - popupLeft - arrowWidth / 2;
                } else {
                    // if create issue popup is narrow then selection, place the arrow in the enter of the dialog
                    arrowOffsetX = (popupOuterWidth - arrowWidth) / 2;
                }
            }
            // arrow always needs to have a positive offset
            arrowOffsetX = (arrowOffsetX < 0) ? 0 : arrowOffsetX;

            // Fix default behavior of original inline-dialog code.
            var distanceToTopOfViewablePage = (targetOffset.top - (window.pageYOffset || document.documentElement.scrollTop));

            var popupMaxHeight = opts.maxHeight || 0;
            var popupHeight = popup.height();
            var enoughRoomAbove = distanceToTopOfViewablePage > Math.max(popupHeight, popupMaxHeight);
            var enoughRoomBelow = (popupTop + popup.height()) < bottomOfViewablePage;
            //Check if the popup should be displayed above the trigger or not (if the user has set opts.onTop to true and if theres enough room)
            displayAbove = (!enoughRoomBelow && enoughRoomAbove) || opts.onTop;

            // opts is a reference to the original options that we used at init config
            // Assign displayAbove value into onTop property to prevent dialog is flipped after call refresh()
            opts.onTop = displayAbove;

            //calculate if the popup will be offscreen
            var diff = containerWidth - (popupLeft + popupOuterWidth + SCREEN_PADDING);

            //check if the popup should be displayed above or below the trigger
            if (displayAbove) {
                popupTop = targetOffset.top - popupHeight - 8; //calculate the flipped position of the popup (the 8 allows for room for the arrow
                arrowOffsetY = popupHeight;
            }

            // We have to make sure inline-dialog never clipped by the viewport
            if (displayAbove === false && enoughRoomBelow === false) {
                var clippedHeight = (popupTop + popupHeight) - bottomOfViewablePage;
                var optimalScrollTop = (window.pageYOffset || document.documentElement.scrollTop) + clippedHeight + SCREEN_TOP_PADDING;
                var $container = $('html, body');
                $container.stop().animate({
                    scrollTop: optimalScrollTop
                }, 500);
            }

            //check if the popup should show up relative to the mouse
            if (opts.isRelativeToMouse) {
                if (diff < 0) {
                    popupRight = SCREEN_PADDING;
                    popupLeft = "auto";
                    arrowOffsetX = mousePosition.x - ($(window).width() - opts.width);
                } else {
                    popupLeft = mousePosition.x - 20;
                    arrowOffsetX = mousePosition.x - popupLeft;
                }
            } else {
                if (diff < 0) {
                    popupRight = SCREEN_PADDING;
                    popupLeft = "auto";

                    var popupRightEdge = containerWidth - popupRight;
                    var popupLeftEdge = popupRightEdge - popupOuterWidth;
                    //arrow's position must be relative to the popup's position and not of the screen.
                    arrowOffsetX = middleOfTrigger - popupLeftEdge - arrowWidth / 2;
                }
            }
            return {
                displayAbove: displayAbove,
                popupCss: {
                    left: popupLeft,
                    right: popupRight,
                    top: popupTop
                },
                arrowCss: {
                    position: "absolute",
                    left: arrowOffsetX,
                    right: "auto",
                    top: arrowOffsetY
                }
            };
        };

        // still allow the user to override our custom calculatePositions if needed
        if (!options.calculatePositions) {
            options.calculatePositions = calculatePositions;
        }

        return AJS.InlineDialog.call(this, items, identifier, url, options);
    };
});


require('confluence/module-exporter').exportModuleAsGlobal('confluence-highlight-actions/js/scrolling-inline-dialog', 'Confluence.ScrollingInlineDialog');
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.confluence.plugins.confluence-highlight-actions:highlighting-experiment-resources', location = 'js/highlight-ranger-helper.js' */
/**
 * Provide a useful method to interact with Range
 */
define('confluence-highlight-actions/js/highlight-ranger-helper', [
    'ajs',
    'jquery',
    'confluence/legacy',
    'confluence-highlight-actions/js/doctheme-utils'
], function(
    AJS,
    $,
    Confluence,
    docThemeUtils
) {
    'use strict';

    /**
     * Convert all non-break spaces <code>u00a0</code> to normal spaces <code>u0020</code>
     * @param {string} str string to be converted
     * @returns {string} result string
     */
    function convertSpaces(str) {
        return str.replace(/\u00a0/g,'\u0020');
    }

    /*
     * Given a selectionRange object and clientRects representing the highlighted text, return the first and last
     * clientRect containing text accounting for browser incompatibilities
     *
     * @param selectionRange selected text range object
     * @param clientRects browser clientRects representing the highlighted text
     * @return an object containing the first and last clientRect of the highlighted text
     */
    function getFirstAndLastSelectionRect(selectionRange, clientRects) {
        // In Chrome triple clicking text will cause all the text in an element to be selected. When calling
        // getClientRects after a triple click, the array will contain rects for each line of highlighted text
        // in the highlighted element and also a clientRects for the adjacent sibling element even though no text
        // is highlighted inside it. If the endOffset is zero, we ignore this final clientRect because no text
        // is highlighted inside of it.
        //
        // Also, in Chrome, Safari and Firefox, get client rects return a clientRects representing each inline element
        // including rectangles for all nested elements. IE8 return many less rects, maybe just one for the ancestor
        // element containing the highlight or a clientRects for each line of highlight without individual rects for each
        // inline element
        var rects = {};
        rects.first = clientRects[0];
        rects.last = clientRects[clientRects.length - 1];
        if (selectionRange.endOffset !== 'undefined') {
            //In IE, if we highlight on resolved inline comment, we will length of clientRects is 1
            if (selectionRange.endOffset === 0 && clientRects.length > 1) {
                rects.last = clientRects[clientRects.length - 2];
            }
        }
        return rects;
    }

    /*
     * Returns an object representing a rectangle. the rectangle coordinates are as follows
     * left: start of the text highlight
     * right: either the end of the highlight of the first line or the end of the highlight of the last line, whichever is greater
     * top: top of highlighted text
     * bottom: bottom of highlighted text
     *
     * @param selectionRange range object representing the selected text
     * @return rect object or false if error occurs
     */
    function getSelectionRects(selectionRange) {
        // if using documentation theme, get scrolltop of documentation theme content which is fixed size
        // certain browsers give the scrollTop on html element, some give it on the body element. this works in both.
        var scrollTop = docThemeUtils.getMainContentScrollTop();
        var scrollLeft = docThemeUtils.getMainContentScrollLeft();

        var clientRects = selectionRange.getClientRects();
        // IE fails to provide client rects when highlighting a paragraph containing only an image or triple clicking to
        // highlight any paragraph containing content other than plain text. In this case, it is safe to assume parent
        // element dimensions will represent the highlighted area
        if (!clientRects.length && selectionRange.parentElement()) {
            var $parentElement = $(selectionRange.parentElement());
            var parentOffset = $parentElement.offset();
            clientRects = [{
                top: parentOffset.top - scrollTop,
                left: parentOffset.left - scrollLeft,
                bottom: parentOffset.top + $parentElement.height(),
                right: parentOffset.left + $parentElement.width()
            }];
        }
        var rects = getFirstAndLastSelectionRect(selectionRange, clientRects);

        /*
         * Calculates Create Issue dialog target area
         */
        var getOverlap = function(firstRect, lastRect) {
            var overlap = {};
            overlap.top = firstRect.top;
            overlap.left = firstRect.left + scrollLeft;
            overlap.bottom = lastRect.bottom;

            if (firstRect.left >= lastRect.right) {
                overlap.right = firstRect.right;
            } else {
                overlap.right = lastRect.right;
            }
            overlap.right = overlap.right + scrollLeft;
            // adjust top for doc theme
            overlap.top = overlap.top + scrollTop;
            overlap.bottom = overlap.bottom + scrollTop;
            // set width and height
            overlap.width = overlap.right - overlap.left;
            overlap.height = overlap.bottom - overlap.top;

            return overlap;
        };

        /*
         * Calculates the action panel target area
         */
        var getHighlightStart = function(rect) {
            var highlight = {};
            highlight.width = rect.right - rect.left;
            highlight.height = rect.bottom - rect.top;
            highlight.left = rect.left + scrollLeft;
            highlight.right = rect.right + scrollLeft;
            highlight.top = rect.top + scrollTop;
            highlight.bottom = rect.bottom + scrollTop;
            return highlight;
        };

        var averageRect = getOverlap(rects.first, rects.last);
        var firstRect = getHighlightStart(rects.first);

        // Some Debugging output. Turn on by typing Confluence.HighlightAction.debug = true in console after page loads
        if (Confluence.HighlightAction.debug) {
            var $highlight_debug = $('<div>').attr('id', 'highlight-actions-debug-helper');
            docThemeUtils.appendAbsolutePositionedElement($highlight_debug).css($.extend({position: 'absolute', outline: '1px solid red'}, averageRect));
        }

        return {
            first: firstRect,
            average: averageRect
        };
    }

    /*
     * Return the text contained within the range object
     *
     * @param W3C text range object
     * @return highlighted text stripped of DOM elements
     */
    function getSelectionText(selectionRange) {
        var selectionText = (selectionRange.text !== undefined) ? selectionRange.text : selectionRange.toString();
        /*
         CONF-36789: on IE, selectionRange.toString() always convert all &nbsp; to normal space
         on other browsers, it does not. So we must convert manually to made consistency across all browsers
         */
        return convertSpaces(selectionText);
    }

    /**
     * Return the HTML string contained within the range object
     * @param selectionRange: W3C text range object
     */
    function getSelectionHTML(selectionRange) {
        return (selectionRange.cloneContents) ?
                $('<div>').append(selectionRange.cloneContents()).html() :
                selectionRange.htmlText; // IE8 uses TextRange object with htmlText property
    }

    /*
     * Find deepest common ancestor container of a selection ranges boundary-points
     *
     * @param selectionRange current text selection on the page
     * @return deepest DOM element encompassing the entire selection
     */
    function getContainingElement(selectionRange) {
        if (selectionRange.commonAncestorContainer) {
            var selectRangeElement = selectionRange.commonAncestorContainer;
            if(selectRangeElement.nodeType === 3) {//Is TextNode
                return selectRangeElement.parentNode;
            }
            return selectRangeElement;
        } else if (selectionRange.parentElement) {// IE <= 8
            return selectionRange.parentElement();
        }
    }

    /**
     * Return an Object which provide all available variable for plugins
     * @param selectionRange
     * @returns {{area: *, text: *, html: *, containingElement: *, range: *}}
     */
    function getRangeOption(selectionRange) {
        return {
            area: getSelectionRects(selectionRange),
            text: getSelectionText(selectionRange),
            html: getSelectionHTML(selectionRange),
            containingElement: getContainingElement(selectionRange),
            range: selectionRange
        };
    }

    /**
     * Check if selectionRange is valid inside the Content or not
     * @param $content
     * @param selectionRange
     * @returns True if selectionRange is Content or child of Content.
     */
    function isSelectionInsideContent($content, selectionRange) {
        var selectionContainer = getContainingElement(selectionRange);
        var isContent = function() {
            var isValid = false;
            $.each($content, function(index, element) {
                // may be $element is container
                // or if $element is contained inside $content
                if (element === selectionContainer || $.contains(element, selectionContainer)) {
                    isValid = true;
                    return false; // return false to cancel the loop
                }
            });
            return isValid;
        };

        return isContent();
    }

    /*
     * Return valid W3C range object for the current selection the content, otherwise return false
     *
     * @param content the content element within which a selection must be contained
     * @return W3C range object for the current selection on the page or false if not defined
     */
    function getUserSelectionRange() {
        // no selection made webkit
        if (window.getSelection && window.getSelection().isCollapsed) {
            return false;
        }

        // no selection made IE
        if (document.selection && (document.selection.type === 'None' || document.selection.createRange().htmlText === '')) {
            return false;
        }

        var selectionRange;
        if (window.getSelection) {
            // Firefox support multi range, we should get the last range to support Selenium test
            var range = window.getSelection();
            selectionRange = range.getRangeAt(range.rangeCount - 1);
        } else if (document.selection) {
            selectionRange = document.selection.createRange();
        }

        // don't show the highlight panel if the selection is all whitespaces
        if (/^\s*$/.test(getSelectionText(selectionRange))) {
            var html = getSelectionHTML(selectionRange);
            if (!html) {
                return false;
            }
            // we support to quote image, need to check before return false
            var hasImage = html.toLowerCase().indexOf('<img ') !== -1;
            // case not show return false
            if(!hasImage) {
                return false;
            }
        }

        // verify that selection is inside[data-highlight-actions-target=true]
        if (!isSelectionInsideContent($('.wiki-content, [data-highlight-actions-target=true]'), selectionRange)) {
            return false;
        }
        return selectionRange;
    }

    /*
     * Creates a range containing all text up to the selection text
     *
     * @param $root jQuery element, container of content which can be selected
     * @param selected range object representing the current selection
     * @return range object encompassing all text inside $root up to selected
     */
    function extendRangeToStart($root, selected) {
        var range;
        if (document.createRange) {
            range = document.createRange();
            range.setStart($root.get(0), 0);
            // use originalEndOffset to work around IE issue, since endOffset property of selection object
            // is modified internally by the IE if there's some DOM changes.
            range.setEnd(selected.endContainer, selected.originalEndOffset);
        } else { // IE8
            range = document.body.createTextRange();
            range.moveToElementText($root.get(0));
            range.setEndPoint('EndToEnd', selected);
        }
        return range;
    }

    /*
     * Return the text content of an element and all descendants
     *
     * @param $root jQuery element whose text content we're interested in
     * @return text content of the passed element
     */
    function getTextContent($root) {
        if (document.createRange) {
            return $root.text();
        } else {
            // IE8 $root.text() doesn't count line ending character (\n). IE8 collapses all whitespace (including)
            // line break into a single space so range.text returns a more accurate text
            var range = document.body.createTextRange();
            range.moveToElementText($root.get(0));
            return range.text;
        }
    }

    //Replace all texts in macro same with highlight text by space
    function updatePageContent(selectedText, $root, pageContent) {

        var $macros = $root.find('.user-mention, a[href^="/"]');

        $root.find('.conf-macro[data-hasbody="false"]').each(function() {
            if ($(this).text().indexOf(selectedText) > -1) {
                $macros = $macros.add(this);
            }
        });

        if($macros.length > 0) {
            var replacedText = selectedText.replace(/\S/g, ' ');

            //this regular expression will replace all text same with highlight by space text
            var re = new RegExp(selectedText.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');

            $macros.each(function() {
                var originalText = $(this).text();
                $(this).text(originalText.replace(re,replacedText));
            });

            return getTextContent($root);
        }

        return pageContent;
    }

    /*
     * Finds all occurrences of a substring inside a string
     *
     * @param src the string to search
     * @param sub the substring to find
     * @return array of indexes where the substring occurs
     */
    function findOccurrences(selectedText, $root) {

        var pageContent = getTextContent($root);
        pageContent = updatePageContent(selectedText, $root.clone(), pageContent);

        //CONF-36789: convert &nbsp; to normal space, so compare selectedText with pageContent correctly
        pageContent = convertSpaces(pageContent);

        var start = 0;
        var found = -1;
        var indexes = [];
        while ((found = pageContent.indexOf(selectedText, start)) > -1) {
            indexes.push(found);
            start = found + 1;
        }
        return indexes;
    }

    /*
     * Generates javascript object containing the context of the selected text to help locate in storage format
     *
     * @param $root jQuery element, container of content which can be selected
     * @param selected range object representing the current selection
     * @return object containing metadata about the location of the selected text
     */
    function computeSearchTextObject($root, selected) {
        var fromStart = getSelectionText(extendRangeToStart($root, selected));
        var selectedText = $.trim(getSelectionText(selected));
        var occurrences = findOccurrences(selectedText, $root);

        /*
         CONF-36789: b/c we trim selectedText, fromStart may contains spaces at the end
         we must remove these spaces to make sure fromStart.length is correct
         */
        fromStart = fromStart.replace(/\s*$/, '');

        return {
            pageId: AJS.Meta.get('page-id'),
            selectedText: selectedText,
            index: $.inArray(fromStart.length - selectedText.length, occurrences),
            numMatches: occurrences.length
        };
    }


    return {
        getRangeOption: getRangeOption,
        getUserSelectionRange: getUserSelectionRange,
        getSelectionRects: getSelectionRects,
        getSelectionText: getSelectionText,
        getSelectionHTML: getSelectionHTML,
        getContainingElement: getContainingElement,
        getFirstAndLastSelectionRect: getFirstAndLastSelectionRect,
        isSelectionInsideContent: isSelectionInsideContent,
        computeSearchTextObject: computeSearchTextObject
    };
});


require('confluence/module-exporter').exportModuleAsGlobal('confluence-highlight-actions/js/highlight-ranger-helper', 'Confluence.HighlightAction.RangeHelper');
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.confluence.plugins.confluence-highlight-actions:highlighting-experiment-resources', location = 'js/highlight-actions.js' */
/*
 * Object for registering actions in the highlighted text property panel
 */
define('confluence-highlight-actions/js/highlight-actions', [
    'ajs',
    'jquery',
    'confluence/legacy',
    'confluence-highlight-actions/js/highlight-ranger-helper'
], function(
    AJS,
    $,
    Confluence,
    rangerHelper
) {

    'use strict';
    // dictionary of all event handlers registered
    var handlers = {};

    // Provide Three default behavior, this will be assign to shouldDisplay method
    // which will be call to validate when will the button of plugin will be shown/hidden
    var WORKING_AREA = {
        MAINCONTENT_AND_COMMENT: function(selectionRange) {
            return rangerHelper.isSelectionInsideContent($('.wiki-content, [data-highlight-actions-target=true]'), selectionRange);
        },
        MAINCONTENT_ONLY: function(selectionRange) {
            // Since main content is not static anymore in SPA mode, we always want to query `[data-highlight-actions-target=true]`
            var $mainContent = $('.wiki-content, [data-highlight-actions-target=true]').first();
            return rangerHelper.isSelectionInsideContent($mainContent, selectionRange);
        },
        COMMENT_ONLY: function(selectionRange) {
            return rangerHelper.isSelectionInsideContent($('.comment-content'), selectionRange);
        }
    };

    /*
     * PUBLIC Registers a callback for a specific plugin key
     *
     * @param key plugin specific key to register a callback with (eg. com.atlassian.confluence.plugins.confluence-highlight-actions:quote-comment)
     * @param config option object {onClick} register with the associated key
     */
    function registerButtonHandler(key, option) {
        var defaultOption = {
            onClick: function() {},
            // Return FALSE to prevent this plugin's button show on Action Panel
            // if plugin doesn't provide shouldDisplay method, as default it will able to work on Main Content and Comment Area
            shouldDisplay: WORKING_AREA.MAINCONTENT_AND_COMMENT
        };
        handlers[key] = $.extend(defaultOption, option);
    }

    /*
     * PUBLIC Retrieves handler associated with specific plugin key
     *
     * @param key the key for the handler
     * @return the callback associated with the key
     */
    function getButtonHandler(key) {
        var callback = handlers[key];
        if (!callback) {
            callback = function() {
                AJS.logError('The button with key ' + key + ' doesn\'t have a registered handler');
            };
        }
        return callback;
    }

    /*
     * PUBLIC Inserts an XML fragment at the end of the current selection
     *
     * @param searchTextObject metadata about the text selection and its position in the page
     * @param insertion the XML fragment to insert in the text
     * @return ajax function
     */
    function insertContentAtSelectionEnd(insertionBean) {
        var restUrl = Confluence.getContextPath() + '/rest/highlighting/1.0/insert-storage-fragment';
        return $.ajax({
            type : 'POST',
            contentType : 'application/json',
            url : restUrl,
            data : JSON.stringify(insertionBean)
        });
    }

    /*
     * PUBLIC Inserts XML fragments at the end of the table's cells
     *
     * @param tableInsertionBean metadata about:
     *                  the text selection: pageId, numMatches, index, selectedText
     *                  tableColumnIndex: the column index need update in the table
     *                  cellXmlInsertionBeans: list of xml fragment with rowIndex using for update cells
     * @return ajax function
     */
    function insertContentsInTableColumnCells(tableInsertionBean) {
        var restUrl = Confluence.getContextPath() + '/rest/highlighting/1.0/insert-storage-column-table';
        return $.ajax({
            type : 'POST',
            contentType : 'application/json',
            url : restUrl,
            data : JSON.stringify(tableInsertionBean)
        });
    }

    function createBaseBean(searchText, lastModified) {
        var insertionBean = {};
        var lastModifiedDate = lastModified ? new Date(lastModified).getTime() : null;
        insertionBean.pageId = searchText.pageId;
        insertionBean.selectedText = searchText.selectedText;
        insertionBean.index = searchText.index;
        insertionBean.numMatches = searchText.numMatches;
        // Get last fetch time of current page.
        // This used to be the request time, but this caused problems due to time drift between the server and database.
        // So now try to use the content last modification date on load if that exists, then fallback onto the
        // request time if it's not available.
        insertionBean.lastFetchTime = lastModifiedDate || $('meta[name="confluence-request-time"]').attr('content');
        return insertionBean;
    }

    /*
     * PUBLIC Create tableInsertionBean object use for call
     * insert XML fragments the end of the table's cells
     *
     * @param cellXmlInsertions list of xml fragment with rowIndex using for update cells
     * @param tableColumnIndex the column index need update in the table
     * @param searchText the text selection object received from select text with:
     *                                      pageId, numMatches, index, selectedText
     */
    function createTableInsertionBean(cellXmlInsertions, tableColumnIndex, searchText, lastModified) {
        var tableInsertionBean = createBaseBean(searchText, lastModified);
        tableInsertionBean.tableColumnIndex = tableColumnIndex;
        tableInsertionBean.cellModifications = cellXmlInsertions;
        return tableInsertionBean;
    }

    /*
     * DEPRECATED use createXMLModificationBean
     *
     * PUBLIC Create insertionBean object use for call
     * insert XML fragments the end of the table's cells
     *
     * @param xmlModification xml fragment
     * @param searchText the text selection object received from select text with:
     *                                      pageId, numMatches, index, selectedText
     */
    function createInsertionBean(cellXmlInsertions, searchText, lastModified) {
        var insertionBean = createBaseBean(searchText, lastModified);
        insertionBean.xmlModification = cellXmlInsertions[0].xmlInsertion;
        return insertionBean;
    }

    /*
     * PUBLIC Create insertionBean object use for call
     * insert XML fragments the end of the table's cells
     *
     * @param xmlModification xml fragment
     * @param searchText the text selection object received from select text with:
     *                                      pageId, numMatches, index, selectedText
     */
    function createXMLModificationBean(xml, searchText) {
        var insertionBean = createBaseBean(searchText);
        insertionBean.xmlModification = xml;
        return insertionBean;
    }

    /*
     * PUBLIC Removes the current mouse highlight from the page
     */
    function clearTextSelection() {
        if (window.getSelection) {
            window.getSelection().empty && window.getSelection().empty(); // Chrome
            window.getSelection().removeAllRanges && window.getSelection().removeAllRanges(); //FF
        } else {
            window.document.selection && window.document.selection.empty(); // IE
        }
    }

    return {
        registerButtonHandler: registerButtonHandler,
        getButtonHandler: getButtonHandler,
        insertContentAtSelectionEnd: insertContentAtSelectionEnd,
        insertContentsInTableColumnCells: insertContentsInTableColumnCells,
        createTableInsertionBean: createTableInsertionBean,
        createInsertionBean: createInsertionBean,
        createXMLModificationBean: createXMLModificationBean,
        clearTextSelection: clearTextSelection,
        WORKING_AREA: WORKING_AREA
    };
});


require('confluence/module-exporter').exportModuleAsGlobal('confluence-highlight-actions/js/highlight-actions', 'Confluence.HighlightAction');
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.confluence.plugins.confluence-highlight-actions:highlighting-experiment-resources', location = '/js/highlight-panel.js' */
define('confluence-highlight-actions/js/highlight-panel', [
    'ajs',
    'confluence/meta',
    'skate',
    'jquery',
    'confluence/legacy',
    'confluence-highlight-actions/js/highlight-ranger-helper',
    'confluence-highlight-actions/js/doctheme-utils',
    'confluence-highlight-actions/js/scrolling-inline-dialog',
    'confluence-highlight-actions/js/highlight-actions'
], function(
    AJS,
    meta,
    skate,
    $,
    Confluence,
    rangerHelper,
    docThemeUtils,
    scrollingInlineDialog,
    highlightActions
) {
    'use strict';

    // pushpin object to mark locations where property panel should open
    var $actionDialogTarget = $("<div>").attr("id", "action-dialog-target");

    // inline dialog containing highlight action buttons
    var actionPanel;
    var actionPanelClass = "selection-action-panel";

    var selectionRange;

    var curRects;

    var fetchWebPanelItems = function(pageId) {
        // endpoint for retrieving available highlight actions
        var restUrl = Confluence.getContextPath() + '/rest/highlighting/1.0/panel-items?pageId=' + pageId;

        var promise = $.ajax({
            url: restUrl,
            cache: false,
            success: function(data) {
                if (data.length) {
                    createPropertyPanel(data);
                }
            }
        });

        bindHandlers(promise);
    };

    function init() {
        var isNonSPA = $('#confluence-ui').length === 0;

        // in SPA view page, we don't want to fetch twice.
        if (isNonSPA) {
            // for normal view page and fallback mode
            var pageId = meta.get('page-id');
            if(pageId) {
                fetchWebPanelItems(pageId);
            }
        }

        var clsSPAPlaceHolder = 'spa-highlight-actions-placeholder';
        skate(clsSPAPlaceHolder, {
            type: skate.types.CLASS,

            attributes: {
                'data-content-id': {
                    created: function(el, change) {
                        if (change.newValue) {
                            fetchWebPanelItems(change.newValue);
                        } else {
                            AJS.debug('content-id value is not defined.');
                        }
                    }
                }
            }
        });
    }

    // To be compatible with SPA, we need to use a function to query '[data-highlight-actions-target=true]', instead of storing it in a variable
    var getWikiContentElement = function() {
        // Usable area for the plugin. #main-content was another candidate, but does not appear on all pages
        // We only support on main content
        return $('.wiki-content, [data-highlight-actions-target=true]').first();
    };

    /*
     * Renders the property panel
     *
     * @param data JSON representation of registered highlight actions
     */
    function createPropertyPanel(data) {
        var dialogEventHandlers = getPanelEventHandlers();
        // width of each button in the property panel
        // CONFDEV-19613: On new version, they add one more pixel as margin-right, increase this variable one more pixel to fix icon wrapped problem, we need to get this dynamic in the future
        var ICON_BUTTON_WIDTH = 29;
        var buttonClicked = false;
        var panelContentWidth = data.length * ICON_BUTTON_WIDTH;

        var panelHTML = Confluence.HighlightPanel.Templates.panelContent({webItems: data});
        var panelExists = false;
        var generateDialogContent = function(content, trigger, showPopup) {
            if (!panelExists) {
                content.append(panelHTML);
                //apply chunky tooltips for buttons
                content.find(".aui-button").tooltip({gravity: "s"});
                setPanelUnselectable(content.parent());
                // popup property panel button handler, gathers information about the selection and triggers
                // the registered callback of the button preseed
                content.find("button").click(function(event) {
                    var key = $(this).attr("data-key");
                    var pluginOption = highlightActions.getButtonHandler(key);
                    buttonClicked = true;
                    actionPanel.hide();
                    var argument = rangerHelper.getRangeOption(selectionRange);
                    if ($.trim(argument.text) !== "") {
                        var $wikiContent = getWikiContentElement();
                        argument.searchText = rangerHelper.computeSearchTextObject($wikiContent, selectionRange);
                    }
                    pluginOption.onClick(argument);
                });
            }
            showPopup();

            panelExists = true;

            return false;
        };

        // This function will be call before an icon button is show up on Action Dialog,
        // it will involve shouldDisplay method of each plugin. if this function return false, icon button will be hidden.
        var onBeforeShow = function(popup) {
            var shouldShowPopup = false;

            popup.find("button").each(function(index){
                var $button = $(this);
                var key = $button.attr("data-key");
                var pluginOption = highlightActions.getButtonHandler(key);
                var visible = false;

                if (pluginOption && pluginOption.shouldDisplay) {
                    visible = pluginOption.shouldDisplay(selectionRange);
                }

                $button.css('display', visible ? 'inline-block' : 'none');

                // this buttonVisible variable to determine if there is one button is visible
                shouldShowPopup = shouldShowPopup || visible;
            });
            // what happen if there isn't any button is visible? let hide the dialog
            if (!shouldShowPopup) {
                actionPanel.hide();
            } else {
                // Make sure that the width of dialog is always perfect after show/hide icons
                popup.find('.contents').width('auto');
            }
        };

        var initCallback = function() {
            // Some plugins is limit working scope, check to hide before them are shown
            onBeforeShow(this.popup);
            dialogEventHandlers.bindHideEvents();
            $actionDialogTarget.show();
        };

        var hideCallback = function() {
            dialogEventHandlers.unbindHideEvents();
            $actionDialogTarget.hide();
        };

        var dialogOptions = {
            centerOnHighlight: true,
            onTop: true,
            fadeTime: 0,
            width: panelContentWidth,
            persistent: true,
            // Keep the property panel open unless text is deselected or a panel button is clicked
            // return value of true closes the dialog, return value of false stops the dialog from closing
            initCallback: initCallback,
            hideCallback: hideCallback
        };

        actionPanel = scrollingInlineDialog($actionDialogTarget, actionPanelClass, generateDialogContent, dialogOptions);
    }

    function setPanelUnselectable($panelContent) {
        // makes panel unselectable on IE8
        // prevent dragging event on Chrome
        $panelContent.children().attr('unselectable', 'on').on('selectstart', false);
    }

    /*
     * Bind mouse handlers for highlight actions
     */
    function bindHandlers(actionsPromise) {
        var panelTimeoutId;
        var NO_DELAY = 0;
        var DELAY = 300;

        $(document).on('mouseup', function (e) {
            // Only fire the callback once we have fetched the highlight panels actions using ajax
            actionsPromise.done(function(data) {
                //Panel won't exist if user can't perform any actions on the page
                if (!(data && data.length > 0)) {
                    return;
                }

                var $target = $(e.target);
                // We need to ignore mouseup events that occur in the inline dialogs
                if ($target.closest('.aui-inline-dialog').length !== 0) {
                    return;
                }
                // The following code is wrapped in a setTimeout of 0 because when a user clicks to dismiss highlighted text
                // in Chrome, the mouseup event will fire before the selection is cleared, causing the property panel to
                // remain visible even though the selection is dismissed. The setTimeout gives the browser the needed time
                // to clear selected text before executing the mouseup handler
                setTimeout(function () {
                    clearTimeout(panelTimeoutId);

                    var panelDisplayDelay = DELAY;
                    if ($(actionPanel[0]).is(":visible")) {
                        panelDisplayDelay = NO_DELAY;
                    }
                    panelTimeoutId = setTimeout(function () { // actions dialog appearing for first time, delay then show
                        displayPropertyPanel();
                    }, panelDisplayDelay);
                }, NO_DELAY);
            });
        });

        actionsPromise.done(function() {
            // hide the property panel when invoking quick edit
            AJS.bind('quickedit.success', function () {
                actionPanel.hide();
            });
        });
    }

    function displayPropertyPanel() {
        selectionRange = rangerHelper.getUserSelectionRange();

        var isSelectionContainsText = function (_selectionRange) {
            return $.trim(_selectionRange.toString()) !== '';
        };

        if (selectionRange && selectionRange.endOffset !== undefined) {
            selectionRange.originalEndOffset = selectionRange.endOffset;
        }

        // HightAction.shouldDisplay() is set to return false when in the editor
        var buttonHandler = window.Confluence && window.Confluence.HighlightAction
            ? window.Confluence.HighlightAction.getButtonHandler("com.atlassian.confluence.plugins.confluence-inline-comments:create-inline-comment")
            : null;
        var shouldDisplay = buttonHandler && typeof buttonHandler.shouldDisplay === "function" ? buttonHandler.shouldDisplay(selectionRange) : false;

        if (!shouldDisplay || !selectionRange || !isSelectionContainsText(selectionRange)) {
            actionPanel.hide();
            return;
        }
        var selectionRects = rangerHelper.getSelectionRects(selectionRange);
        if (!selectionRects) {
            return;
        }

        var isInNewPosition = positionDialogTarget(selectionRects);
        if (isInNewPosition || !$(actionPanel[0]).is(":visible")) {
            $(actionPanel[0]).hide();
            actionPanel.show();
        }
    }

    /*
     * Provides event handlers that close the dialog on an external click if no text is selected on the page
     */
    function getPanelEventHandlers() {
        var bindHideEvents = function() {
            bindHideOnExternalClick();
            bindHideOnEscPressed();
        };

        var unbindHideEvents = function() {
            unbindHideOnExternalClick();
            unbindHideOnEscPressed();
        };

        // Be defensive and make sure that we haven't already bound the event
        var hasBoundOnExternalClick = false;
        var externalClickNamespace = actionPanelClass + ".inline-dialog-check";

        /**
         * Catch click events on the body to see if the click target occurs outside of this popup
         * If it does, the popup will be hidden
         */
        var bindHideOnExternalClick = function () {
            if (!hasBoundOnExternalClick) {
                $("body").bind("click." + externalClickNamespace, function(e) {
                    var $target = $(e.target);
                    // hide the popup if the target of the event is not in the dialog
                    if ($target.closest('#inline-dialog-' + actionPanelClass + ' .contents').length === 0) {
                        if (!selectionRange) {
                            actionPanel.hide();
                        }
                    }
                });
                hasBoundOnExternalClick = true;
            }
        };

        var unbindHideOnExternalClick = function () {
            if (hasBoundOnExternalClick) {
                $("body").unbind("click." + externalClickNamespace);
            }
            hasBoundOnExternalClick = false;
        };

        var onKeydown = function(e) {
            if (e.keyCode === 27) {
                actionPanel.hide();
            }
        };

        var bindHideOnEscPressed = function() {
            $(document).on("keydown", onKeydown);
        };

        var unbindHideOnEscPressed = function() {
            $(document).off("keydown", onKeydown);
        };

        return {
            bindHideEvents: bindHideEvents,
            unbindHideEvents: unbindHideEvents
        };
    }

    /*
     * Positions the dialog target relative to the selection
     *
     * @param the rects defining the selection area
     * @return boolean value indicating whether the selection position has changed
     */
    function positionDialogTarget(selectionRects) {
        docThemeUtils.appendAbsolutePositionedElement($actionDialogTarget);
        var posChanged = false;
        if (!curRects || selectionRects.first.top != curRects.first.top || selectionRects.first.height != curRects.first.height ||
            selectionRects.first.left != curRects.first.left || selectionRects.first.width != curRects.first.width) {
            $actionDialogTarget.css({
                top: selectionRects.first.top,
                height: selectionRects.first.height,
                left: selectionRects.first.left,
                width: selectionRects.first.width
            });
            curRects = selectionRects;
            posChanged = true;
        }
        return posChanged;
    }

    return {
        init: init
    };
});

require('confluence/module-exporter').safeRequire('confluence-highlight-actions/js/highlight-panel', function(highlightPanel) {
    highlightPanel.init();
});
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.confluence.plugins.confluence-highlight-actions:highlighting-experiment-resources', location = '/js/quote-in-comment.js' */
/**
 * This is fallback feature when dark feature 'confluence-inline-comments' is disabled
 */
define('confluence-highlight-actions/js/quote-in-comment', [
    'ajs',
    'jquery',
    'confluence-highlight-actions/js/highlight-actions'
], function(
    AJS,
    $,
    highlightActions
) {
    'use strict';

    var IS_NEW_COMMENT = true;
    var editorEmpty = false;

    function moveCursorToEnd(editor) {
        var range = editor.getBody().createTextRange();
        range.moveToElementText(editor.getBody());
        range.collapse(false);
        range.select();
    }

    function scrollWindowToEditor() {
        var MARGIN_ABOVE_COMMENT_EDITOR = 40;
        var commentEditorTop = $("#rte-toolbar").offset().top;
        $(document).scrollTop(commentEditorTop - MARGIN_ABOVE_COMMENT_EDITOR);
    }

    function pasteQuote(editor, selectionObject) {
        var paragraphContent = '<p><br/></p>'; // default behavior of TinyMCE when user insert new paragraph in browsers other than IE
        if ($.browser.msie && !editorEmpty) {
            moveCursorToEnd(editor); // need to move cursor to end of content because IE loses cursor location when editor loses focus
            paragraphContent = '<p></p>';
        }

        var insertContent = "<blockquote><p>" + selectionObject.html + "</p></blockquote>" + paragraphContent;
        editor.execCommand('mceInsertContent', false, insertContent);
        editorEmpty = false;
    }

    function actionCallback(selectionObject) {
        highlightActions.clearTextSelection();

        // Need to place this in a timeout so that the panel actions have a chance to fade out before the
        // window scrolls, otherwise scrolling will break the fadeout behavior
        setTimeout(function() {
            var commentEditor = AJS && AJS.Rte && AJS.Rte.getEditor && AJS.Rte.getEditor();
            if (commentEditor) {
                // If comment editor is already loaded, need to scroll the window to the comment editor when user quotes
                scrollWindowToEditor();
                pasteQuote(commentEditor, selectionObject);
            } else {
                editorEmpty = true;
                // Need to trigger quick edit and paste the text when
                // the quick edit form visible and "quickedit.visible" event fires
                var handler = function() {
                    pasteQuote(AJS.Rte.getEditor(), selectionObject);
                    AJS.unbind('quickedit.visible', handler);
                };
                AJS.bind('quickedit.visible', handler);

                activeEditor(quoteInsideComment(selectionObject.containingElement));
            }
        }, 0);
    }

    /**
     * Return the comment element which contains the text is quoting
     * @param selectionObject
     * @returns {*|jQuery}
     */
    function quoteInsideComment(containingElement) {
        var $commentEl = $(containingElement).closest('div.comment');

        return $commentEl;
    }

    /**
     * Active the correct editor if commentEl is passed. If not, active editor as new comment
     * @param commentEl
     */
    function activeEditor($commentEl) {
        if (!$commentEl.length > 0) {
            // Active new Editor as new comment
            $('.quick-comment-prompt').click();
        } else {
            // Active editor as reply according to commentEl
            $commentEl.find('.comment-actions .action-reply-comment').click();
        }
    }

    return {
        actionCallback: actionCallback
    };
});

require('confluence/module-exporter').safeRequire('confluence-highlight-actions/js/quote-in-comment', function(quoteInComment) {
    var PLUGIN_KEY = "com.atlassian.confluence.plugins.confluence-highlight-actions:quote-comment";
    var ConfluenceHighlightActions = require('confluence-highlight-actions/js/highlight-actions');

    ConfluenceHighlightActions.registerButtonHandler(PLUGIN_KEY, {
        onClick: quoteInComment.actionCallback,
        shouldDisplay: ConfluenceHighlightActions.WORKING_AREA.MAINCONTENT_AND_COMMENT
    });
});
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.confluence.plugins.confluence-highlight-actions:highlighting-experiment-resources', location = '/js/highlight-test-helper.js' */
define('confluence-highlight-actions/js/highlight-test-helper', [
    'ajs',
    'window',
    'confluence-highlight-actions/js/highlight-actions'

], function(
    AJS,
    window,
    HighlightAction
) {
    'use strict';

    function init() {
        HighlightAction.registerButtonHandler("com.atlassian.confluence.plugins.confluence-highlight-actions-test:create-JIRA-issue", {
            onClick: function(sel) {
                var dialog = new AJS.Dialog({
                    id : "hilightext-action-dialog",
                    closeOnOutsideClick : true
                });
                dialog.addHeader(sel.text);
                dialog.show();
            },
            shouldDisplay: function() {
                return true;
            }
        });

        HighlightAction.registerButtonHandler("com.atlassian.confluence.plugins.confluence-highlight-actions-test:append-xxx", {
            onClick: function(sel) {
                var insertionBean = HighlightAction.createXMLModificationBean('<span>XXX</span>', sel.searchText);

                HighlightAction.insertContentAtSelectionEnd(insertionBean)
                    .done(function(data) {
                        if (data) {
                            window.location.reload();
                        } else {
                            var dialog = new AJS.Dialog({
                                id : "hilightext-append-xxx-dialog",
                                closeOnOutsideClick : true
                            });
                            dialog.addHeader("Cannot insert");
                            dialog.show();
                        }
                    });
            },
            shouldDisplay: function() {
                return true;
            }
        });

        HighlightAction.registerButtonHandler("com.atlassian.confluence.plugins.confluence-highlight-actions-test:insert-table-content", {
            onClick: function(sel) {
                // create insert data
                var cellXmlInsertions = [];
                for ( var i = 0; i < 3; i++) {
                    var cellXmlInsertion = {};
                    cellXmlInsertion.rowIndex = i;
                    cellXmlInsertion.xmlInsertion = "Insert content";
                    cellXmlInsertions.push(cellXmlInsertion);
                }

                var tableColumnIndex = 0;
                var tableInsertionBean = HighlightAction.createTableInsertionBean(cellXmlInsertions, tableColumnIndex, sel.searchText);

                HighlightAction.insertContentsInTableColumnCells(tableInsertionBean).done(function(data) {
                    if (data) {
                        window.location.reload();
                    } else {
                        var dialog = new AJS.Dialog({
                            id : "hilightext-insert-table-content-dialog",
                            closeOnOutsideClick : true
                        });
                        dialog.addHeader("Cannot insert");
                        dialog.show();
                    }
                });
            },
            shouldDisplay: function() {
                return true;
            }
        });
    }

    return init;
});

require('confluence/module-exporter').safeRequire('confluence-highlight-actions/js/highlight-test-helper', function(highlightTestHelper) {
    highlightTestHelper();
});
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.confluence.plugins.confluence-highlight-actions:highlighting-experiment-resources', location = '/soy/templates.soy' */
// This file was automatically generated from templates.soy.
// Please don't edit this file by hand.

/**
 * @fileoverview Templates in namespace Confluence.HighlightPanel.Templates.
 */

if (typeof Confluence == 'undefined') { var Confluence = {}; }
if (typeof Confluence.HighlightPanel == 'undefined') { Confluence.HighlightPanel = {}; }
if (typeof Confluence.HighlightPanel.Templates == 'undefined') { Confluence.HighlightPanel.Templates = {}; }


Confluence.HighlightPanel.Templates.panelContent = function(opt_data, opt_ignored) {
  var output = '';
  var webItemList3 = opt_data.webItems;
  var webItemListLen3 = webItemList3.length;
  for (var webItemIndex3 = 0; webItemIndex3 < webItemListLen3; webItemIndex3++) {
    var webItemData3 = webItemList3[webItemIndex3];
    output += (webItemData3['key'] == 'com.atlassian.confluence.plugins.confluence-inline-comments:create-inline-comment') ? '<button data-key="' + soy.$$escapeHtml(webItemData3.key) + '" class="aui-button aui-button-compact aui-button-subtle" style="height: 2.4em;" title="' + soy.$$escapeHtml(webItemData3.tooltip) + '"><span class="aui-icon aui-icon-small ' + soy.$$escapeHtml(webItemData3.styleClass) + '"></span><span style="font-size: 15px; margin-left: 4px;">' + soy.$$escapeHtml(webItemData3.label) + '</span></button>' : (webItemData3['key'] == 'com.atlassian.confluence.plugins.confluence-jira-content:create-JIRA-issue-summary') ? '<button data-key="' + soy.$$escapeHtml(webItemData3.key) + '" class="aui-button aui-button-compact aui-button-subtle" style="height: 2.4em;" title="' + soy.$$escapeHtml(webItemData3.tooltip) + '"><span class="aui-icon aui-icon-small ' + soy.$$escapeHtml(webItemData3.styleClass) + '"></span><span style="font-size: 15px; margin-left: 4px;">' + soy.$$escapeHtml(webItemData3.label) + '</span></button>' : '<button data-key="' + soy.$$escapeHtml(webItemData3.key) + '" class="aui-button aui-button-compact aui-button-subtle" title="' + soy.$$escapeHtml(webItemData3.label) + '"><span class="aui-icon aui-icon-small ' + soy.$$escapeHtml(webItemData3.styleClass) + '"></span></button>';
  }
  return output;
};
if (goog.DEBUG) {
  Confluence.HighlightPanel.Templates.panelContent.soyTemplateName = 'Confluence.HighlightPanel.Templates.panelContent';
}

}catch(e){WRMCB(e)};