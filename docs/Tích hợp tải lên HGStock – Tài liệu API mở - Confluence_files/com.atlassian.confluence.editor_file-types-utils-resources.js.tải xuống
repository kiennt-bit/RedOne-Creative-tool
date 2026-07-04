WRMCB=function(e){var c=console;if(c&&c.log&&c.error){c.log('Error running batched script.');c.error(e);}}
;
try {
/* module-key = 'com.atlassian.confluence.editor:file-types-utils-resources', location = 'com/atlassian/confluence/tinymceplugin/utils/file-types-utils.js' */
define('confluence-editor/utils/file-types-utils', [
], function(
) {
    "use strict";

    var FileTypesUtils = {
        getAUIIconFromMime: function (mime) {
            return mimeToAUIIconMap[mime] || DEFAULT_ICON;
        },

        // If it's supported and started with "/image"
        isImage: function (mime) {
            return mimeToAUIIconMap[mime] && mime.indexOf("image/") === 0;
        }
    };

    var DEFAULT_ICON = "content-type-attachment-file";

    var AUI_ICON_TO_MIMES_MAP = {
        "content-type-attachment-image": [
            "image/gif",
            "image/jpeg",
            "image/pjpeg",
            "image/png",
            "image/tiff",
            "image/bmp"
        ],

        "content-type-attachment-pdf": ["application/pdf"],

        "content-type-attachment-multimedia-video": [
            "audio/mpeg",
            "audio/x-wav",
            "audio/mp3",
            "audio/mp4",
            "video/mpeg",
            "video/quicktime",
            "video/mp4",
            "video/x-m4v",
            "video/x-flv",
            "video/x-ms-wmv",
            "video/avi",
            "video/webm",
            "video/vnd.rn-realvideo"
        ],

        "content-type-attachment-code": [
            "text/html",
            "text/xml",
            "text/javascript",
            "application/javascript",
            "application/x-javascript",
            "text/css",
            "text/x-java-source"
        ],

        "content-type-attachment-text": [
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "text/plain"
        ],

        "content-type-attachment-spreadsheet": [
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ],

        "content-type-attachment-powerpoint": [
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        ],

        "content-type-attachment-zip": [
            "application/zip",
            "application/java-archive"
        ]
    };

    var mimeToAUIIconMap = {};
    var buildMimeToAUIIconMap = function () {
        for (var key in AUI_ICON_TO_MIMES_MAP) {
            var mimes = AUI_ICON_TO_MIMES_MAP[key];
            for (var i = 0, length = mimes.length; i < length; i++) {
                mimeToAUIIconMap[mimes[i]] = key;
            }
        }
    };

    buildMimeToAUIIconMap();

    return FileTypesUtils;
});

require('confluence/module-exporter').exportModuleAsGlobal('confluence-editor/utils/file-types-utils', 'AJS.Confluence.FileTypesUtils');
}catch(e){WRMCB(e)};