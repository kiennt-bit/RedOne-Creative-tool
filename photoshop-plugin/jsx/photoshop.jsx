// ExtendScript for Photoshop — runs in PS scripting engine
// Called by the HTML panel via CSInterface.evalScript()

// ── JSON polyfill for ExtendScript (older PS versions) ──────
if (typeof JSON === "undefined") {
    JSON = {};
    JSON.stringify = function(obj) {
        if (obj === null) return "null";
        if (typeof obj === "undefined") return undefined;
        if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
        if (typeof obj === "string") {
            return '"' + obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                             .replace(/\n/g, "\\n").replace(/\r/g, "\\r")
                             .replace(/\t/g, "\\t") + '"';
        }
        if (obj instanceof Array) {
            var arr = [];
            for (var i = 0; i < obj.length; i++) arr.push(JSON.stringify(obj[i]));
            return "[" + arr.join(",") + "]";
        }
        if (typeof obj === "object") {
            var parts = [];
            for (var k in obj) {
                if (obj.hasOwnProperty(k)) {
                    parts.push('"' + k + '":' + JSON.stringify(obj[k]));
                }
            }
            return "{" + parts.join(",") + "}";
        }
        return String(obj);
    };
    JSON.parse = function(str) {
        return eval("(" + str + ")");
    };
}

/**
 * Check if the active document has a selection.
 * Returns "true" or "false" as a string.
 */
function hasActiveSelection() {
    try {
        var doc = app.activeDocument;
        // Accessing selection.bounds throws if no selection
        var bounds = doc.selection.bounds;
        return "true";
    } catch (e) {
        return "false";
    }
}

/**
 * Get active document info.
 * Returns JSON string: { width, height, name, resolution }
 */
function getDocumentInfo() {
    try {
        var doc = app.activeDocument;
        var info = {
            width: Math.round(doc.width.as("px")),
            height: Math.round(doc.height.as("px")),
            name: doc.name,
            resolution: Math.round(doc.resolution)
        };
        return JSON.stringify(info);
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

/**
 * Export the active document as a flattened PNG to a temp file.
 * Returns the file path as a string.
 */
/**
 * Normalize the document to 1376:768 aspect ratio and export.
 * - Center-crops to the target ratio (no downscale if source is larger)
 * - Creates a Smart Object layer in the original doc showing the crop
 * - Exports the cropped version as PNG
 *
 * Returns JSON: { path, cropX, cropY, cropW, cropH, origW, origH }
 */
function normalizeAndExport() {
    try {
        var doc = app.activeDocument;
        var origRulerUnits = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;

        var docW = Math.round(doc.width.as("px"));
        var docH = Math.round(doc.height.as("px"));

        // Target aspect ratio from Flow output
        var TARGET_W = 1376;
        var TARGET_H = 768;
        var targetRatio = TARGET_W / TARGET_H; // ~1.7917
        var currentRatio = docW / docH;

        var cropW, cropH, cropX, cropY;

        if (Math.abs(currentRatio - targetRatio) < 0.01) {
            // Already the right ratio (within 1%)
            cropW = docW;
            cropH = docH;
            cropX = 0;
            cropY = 0;
        } else if (currentRatio > targetRatio) {
            // Image is wider → crop width (keep full height)
            cropH = docH;
            cropW = Math.round(docH * targetRatio);
            cropX = Math.round((docW - cropW) / 2);
            cropY = 0;
        } else {
            // Image is taller → crop height (keep full width)
            cropW = docW;
            cropH = Math.round(docW / targetRatio);
            cropX = 0;
            cropY = Math.round((docH - cropH) / 2);
        }

        // ── Step 1: Duplicate doc, flatten, crop, export ────────────
        var dupDoc = doc.duplicate("_redone_norm_", false);
        dupDoc.flatten();

        // Convert to RGB if needed
        if (dupDoc.mode !== DocumentMode.RGB) {
            dupDoc.changeMode(ChangeMode.RGB);
        }

        // Crop to target ratio
        if (cropX > 0 || cropY > 0 || cropW < docW || cropH < docH) {
            dupDoc.crop([
                new UnitValue(cropX, "px"),
                new UnitValue(cropY, "px"),
                new UnitValue(cropX + cropW, "px"),
                new UnitValue(cropY + cropH, "px")
            ]);
        }

        // Resize exactly to target dimensions to prevent AI model from cropping
        dupDoc.resizeImage(new UnitValue(TARGET_W, "px"), new UnitValue(TARGET_H, "px"), null, ResampleMethod.BICUBIC);

        // Save as PNG
        var tempFolder = Folder.temp;
        var tempFile = new File(tempFolder + "/redone_genfill_source.png");
        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        pngOpts.interlaced = false;
        dupDoc.saveAs(tempFile, pngOpts, true, Extension.LOWERCASE);
        dupDoc.close(SaveOptions.DONOTSAVECHANGES);

        app.activeDocument = doc;

        app.preferences.rulerUnits = origRulerUnits;

        return JSON.stringify({
            path: tempFile.fsName,
            cropX: cropX,
            cropY: cropY,
            cropW: cropW,
            cropH: cropH,
            origW: docW,
            origH: docH
        });
    } catch (e) {
        return "ERROR:" + e.message;
    }
}

/**
 * Legacy: Export without normalization (kept for compatibility).
 */
function exportDocumentToTemp() {
    try {
        var doc = app.activeDocument;
        var tempFolder = Folder.temp;
        var tempFile = new File(tempFolder + "/redone_genfill_source.png");
        var dupDoc = doc.duplicate("_redone_temp_", false);
        dupDoc.flatten();
        if (dupDoc.mode !== DocumentMode.RGB) {
            dupDoc.changeMode(ChangeMode.RGB);
        }
        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        pngOpts.interlaced = false;
        dupDoc.saveAs(tempFile, pngOpts, true, Extension.LOWERCASE);
        dupDoc.close(SaveOptions.DONOTSAVECHANGES);
        return tempFile.fsName;
    } catch (e) {
        return "ERROR:" + e.message;
    }
}

/**
 * Export the current selection as a black/white mask PNG.
 * White = selected area (to fill), Black = unselected (keep).
 *
 * Uses Alpha Channel approach to avoid clipboard issues.
 */
function exportSelectionMask() {
    try {
        var doc = app.activeDocument;

        // Check for selection
        try {
            var bounds = doc.selection.bounds;
        } catch (e) {
            return "ERROR:No selection";
        }

        var docW = Math.round(doc.width.as("px"));
        var docH = Math.round(doc.height.as("px"));

        // Save current state
        var originalState = doc.activeHistoryState;
        var originalRulerUnits = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;

        // Method: Create mask document via selection fill (no clipboard)
        // 1. Create new grayscale document (white), then fill black
        //    Note: DocumentFill.BLACK does NOT exist in ExtendScript
        var maskDoc = app.documents.add(
            docW, docH, doc.resolution,
            "_redone_mask_",
            NewDocumentMode.GRAYSCALE,
            DocumentFill.WHITE
        );
        // Fill entire doc with black
        app.activeDocument = maskDoc;
        maskDoc.selection.selectAll();
        var blackColor = new SolidColor();
        blackColor.gray.gray = 100; // 100% gray = black
        maskDoc.selection.fill(blackColor);
        maskDoc.selection.deselect();

        // 2. Go back to source doc, save selection as alpha channel
        app.activeDocument = doc;

        // Store selection into a temporary alpha channel
        var tempChannel = doc.channels.add();
        tempChannel.name = "_redone_sel_temp_";
        doc.selection.store(tempChannel);

        // 3. Get selection data by duplicating the channel to the mask doc
        //    Instead of copy/paste (clipboard), use channel duplicate
        tempChannel.duplicate(maskDoc);

        // 4. Clean up temp channel in source doc
        tempChannel.remove();

        // 5. Restore source doc state
        doc.activeHistoryState = originalState;

        // 6. Process mask document
        app.activeDocument = maskDoc;

        // The duplicated channel appears as Alpha 1 in maskDoc
        // We need to apply it as the visible content
        // Select all from the alpha channel and fill the background

        if (maskDoc.channels.length > 1) {
            // There's the Gray channel + the duplicated alpha
            var alphaChannel = maskDoc.channels[maskDoc.channels.length - 1];

            // Load the alpha channel as a selection
            maskDoc.selection.load(alphaChannel);

            // Fill selection with white on the Gray channel
            maskDoc.activeChannels = [maskDoc.channels[0]];
            var whiteColor = new SolidColor();
            whiteColor.gray.gray = 0; // 0% gray = white in Grayscale
            maskDoc.selection.fill(whiteColor);

            // Deselect
            maskDoc.selection.deselect();

            // Remove the alpha channel
            alphaChannel.remove();
        }

        // Flatten
        maskDoc.flatten();

        // Save mask as PNG
        var tempFolder = Folder.temp;
        var maskFile = new File(tempFolder + "/redone_genfill_mask.png");
        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        pngOpts.interlaced = false;
        maskDoc.saveAs(maskFile, pngOpts, true, Extension.LOWERCASE);
        maskDoc.close(SaveOptions.DONOTSAVECHANGES);

        app.preferences.rulerUnits = originalRulerUnits;
        return maskFile.fsName;
    } catch (e) {
        return "ERROR:" + e.message;
    }
}

/**
 * Alternative mask export using Action Manager (more robust).
 * Fallback if the channel-based approach fails.
 */
function exportSelectionMaskAM() {
    try {
        var doc = app.activeDocument;

        try {
            var bounds = doc.selection.bounds;
        } catch (e) {
            return "ERROR:No selection";
        }

        var docW = Math.round(doc.width.as("px"));
        var docH = Math.round(doc.height.as("px"));

        var originalRulerUnits = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;

        // Create mask doc - start white, then fill black
        var maskDoc = app.documents.add(
            docW, docH, doc.resolution,
            "_redone_mask_",
            NewDocumentMode.GRAYSCALE,
            DocumentFill.WHITE
        );
        app.activeDocument = maskDoc;
        maskDoc.selection.selectAll();
        var blackFill = new SolidColor();
        blackFill.gray.gray = 100;
        maskDoc.selection.fill(blackFill);
        maskDoc.selection.deselect();

        // Go back to source
        app.activeDocument = doc;

        // Save selection bounds
        var selBounds = doc.selection.bounds;
        var selLeft = selBounds[0].as("px");
        var selTop = selBounds[1].as("px");
        var selRight = selBounds[2].as("px");
        var selBottom = selBounds[3].as("px");

        // Switch to mask doc
        app.activeDocument = maskDoc;

        // Create selection matching the original bounds
        var selRegion = [[selLeft, selTop], [selRight, selTop],
                         [selRight, selBottom], [selLeft, selBottom]];
        maskDoc.selection.select(selRegion);

        // Fill with white
        var white = new SolidColor();
        white.gray.gray = 0; // 0% gray = white
        maskDoc.selection.fill(white);
        maskDoc.selection.deselect();

        // Save
        var maskFile = new File(Folder.temp + "/redone_genfill_mask.png");
        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        pngOpts.interlaced = false;
        maskDoc.saveAs(maskFile, pngOpts, true, Extension.LOWERCASE);
        maskDoc.close(SaveOptions.DONOTSAVECHANGES);

        app.preferences.rulerUnits = originalRulerUnits;
        return maskFile.fsName;
    } catch (e) {
        return "ERROR:" + e.message;
    }
}

function exportNormalizedMask(cropX, cropY, cropW, cropH) {
    try {
        var doc = app.activeDocument;
        var originalRulerUnits = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;

        // Check if there is a selection
        try {
            var bounds = doc.selection.bounds;
        } catch (e) {
            app.preferences.rulerUnits = originalRulerUnits;
            return "ERROR:No selection";
        }

        // 1. Duplicate the document (preserves selection shape!)
        var maskDoc = doc.duplicate("_redone_mask_temp_", false);

        // 2. Crop it to match the normalized crop area
        if (cropX > 0 || cropY > 0 || cropW < doc.width.as("px") || cropH < doc.height.as("px")) {
            maskDoc.crop([
                new UnitValue(cropX, "px"),
                new UnitValue(cropY, "px"),
                new UnitValue(cropX + cropW, "px"),
                new UnitValue(cropY + cropH, "px")
            ]);
        }

        // Resize exactly to target dimensions
        maskDoc.resizeImage(new UnitValue(1376, "px"), new UnitValue(768, "px"), null, ResampleMethod.NEARESTNEIGHBOR);

        // 3. Check if selection survived the crop
        try {
            var newBounds = maskDoc.selection.bounds;
        } catch (e) {
            maskDoc.close(SaveOptions.DONOTSAVECHANGES);
            app.preferences.rulerUnits = originalRulerUnits;
            return "ERROR:Selection outside crop area";
        }

        // 4. Fill the mask
        // First save the selection path
        var tempChannel = maskDoc.channels.add();
        maskDoc.selection.store(tempChannel);
        
        // Add a solid black layer for the background
        var bgLayer = maskDoc.artLayers.add();
        bgLayer.isBackgroundLayer = true;
        maskDoc.selection.selectAll();
        var blackFill = new SolidColor();
        blackFill.gray.gray = 100; // Black
        maskDoc.selection.fill(blackFill);
        
        // Load the selection back
        maskDoc.selection.load(tempChannel);
        
        // Fill selection with white
        var whiteFill = new SolidColor();
        whiteFill.gray.gray = 0; // White
        maskDoc.selection.fill(whiteFill);
        
        maskDoc.selection.deselect();
        maskDoc.flatten();
        maskDoc.changeMode(ChangeMode.RGB);

        // 5. Save as PNG
        var maskFile = new File(Folder.temp + "/redone_genfill_mask.png");
        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        pngOpts.interlaced = false;
        maskDoc.saveAs(maskFile, pngOpts, true, Extension.LOWERCASE);
        maskDoc.close(SaveOptions.DONOTSAVECHANGES);

        app.preferences.rulerUnits = originalRulerUnits;
        return maskFile.fsName;
    } catch (e) {
        app.preferences.rulerUnits = originalRulerUnits;
        return "ERROR:" + e.message;
    }
}

/**
 * Apply a result image as a new layer in the active document.
 * @param {string} filePath - Path to the result image file
 */
function applyResultAsLayer(filePath, cropX, cropY, cropW, cropH, promptName) {
    try {
        var doc = app.activeDocument;
        var file = new File(filePath);

        if (!file.exists) {
            return "ERROR:File not found: " + filePath;
        }

        var originalRulerUnits = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;

        // Save current selection to an alpha channel (Place often clears selection)
        var savedChannel = null;
        try {
            var tempBounds = doc.selection.bounds; // Throws if no selection
            savedChannel = doc.channels.add();
            savedChannel.name = "_temp_redone_mask_";
            doc.selection.store(savedChannel);
            doc.selection.deselect();
        } catch (selErr) {
            // No selection active
        }

        // Place embedded
        try {
            var idPlc = charIDToTypeID("Plc ");
            var desc = new ActionDescriptor();
            desc.putPath(charIDToTypeID("null"), file);
            desc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
            executeAction(idPlc, desc, DialogModes.NO);

            // Rename the placed layer
            var layer = doc.activeLayer;
            if (promptName && promptName.length > 0) {
                // Photoshop layer names have a max length, though it's quite large, we truncate if needed
                layer.name = promptName.substring(0, 50);
            } else {
                layer.name = "GenFill Result";
            }

            // If crop parameters are provided, resize and translate the layer to match exactly
            if (cropW > 0 && cropH > 0) {
                var bounds = layer.bounds;
                var layerWidth = bounds[2].as("px") - bounds[0].as("px");
                var layerHeight = bounds[3].as("px") - bounds[1].as("px");

                if (layerWidth > 0 && layerHeight > 0) {
                    // Calculate scale percentages
                    var scaleX = (cropW / layerWidth) * 100;
                    var scaleY = (cropH / layerHeight) * 100;

                    // Resize the layer
                    layer.resize(scaleX, scaleY, AnchorPosition.TOPLEFT);
                    
                    // After resize, the top-left corner might have moved. Calculate new translation.
                    var newBounds = layer.bounds;
                    var newLeft = newBounds[0].as("px");
                    var newTop = newBounds[1].as("px");

                    var deltaX = cropX - newLeft;
                    var deltaY = cropY - newTop;

                    // Translate to final position
                    layer.translate(deltaX, deltaY);
                }
            }

            // Restore selection and create Layer Mask
            if (savedChannel !== null) {
                try {
                    doc.selection.load(savedChannel);

                    var idMk = charIDToTypeID( "Mk  " );
                    var descMk = new ActionDescriptor();
                    var idNw = charIDToTypeID( "Nw  " );
                    var idChnl = charIDToTypeID( "Chnl" );
                    descMk.putClass( idNw, idChnl );
                    var idAt = charIDToTypeID( "At  " );
                    var refMsk = new ActionReference();
                    refMsk.putEnumerated( charIDToTypeID( "Chnl" ), charIDToTypeID( "Chnl" ), charIDToTypeID( "Msk " ) );
                    descMk.putReference( idAt, refMsk );
                    var idUsng = charIDToTypeID( "Usng" );
                    var idUsrM = charIDToTypeID( "UsrM" );
                    var idRvlS = charIDToTypeID( "RvlS" );
                    descMk.putEnumerated( idUsng, idUsrM, idRvlS );
                    executeAction( idMk, descMk, DialogModes.NO );
                } catch (maskErr) {
                    // Ignore if mask creation failed
                }

                // Delete temp channel
                try {
                    savedChannel.remove();
                } catch (e) {}
            }

            app.preferences.rulerUnits = originalRulerUnits;
            return "OK";
        } catch (placeErr) {
            // Fallback: open, copy, paste
            var resultDoc = app.open(file);
            resultDoc.selection.selectAll();
            resultDoc.selection.copy();
            resultDoc.close(SaveOptions.DONOTSAVECHANGES);

            app.activeDocument = doc;
            var newLayer = doc.paste();
            newLayer.name = "GenFill Result";

            return "OK";
        }
    } catch (e) {
        return "ERROR:" + e.message;
    }
}

/**
 * Save base64 data to a temp file.
 * @param {string} base64Data - Base64-encoded image data
 * @returns {string} Path to saved file
 */
function saveBase64ToTemp(base64Data) {
    try {
        var tempFolder = Folder.temp;
        var outFile = new File(tempFolder + "/redone_genfill_result.png");

        var binary = _base64Decode(base64Data);
        outFile.encoding = "BINARY";
        outFile.open("w");
        outFile.write(binary);
        outFile.close();

        return outFile.fsName;
    } catch (e) {
        return "ERROR:" + e.message;
    }
}

/**
 * Base64 decode helper for ExtendScript.
 */
function _base64Decode(str) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var output = "";
    var i = 0;
    str = str.replace(/[^A-Za-z0-9\+\/\=]/g, "");
    while (i < str.length) {
        var e1 = chars.indexOf(str.charAt(i++));
        var e2 = chars.indexOf(str.charAt(i++));
        var e3 = chars.indexOf(str.charAt(i++));
        var e4 = chars.indexOf(str.charAt(i++));
        var c1 = (e1 << 2) | (e2 >> 4);
        var c2 = ((e2 & 15) << 4) | (e3 >> 2);
        var c3 = ((e3 & 3) << 6) | e4;
        output += String.fromCharCode(c1);
        if (e3 !== 64) output += String.fromCharCode(c2);
        if (e4 !== 64) output += String.fromCharCode(c3);
    }
    return output;
}
