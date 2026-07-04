WRMCB=function(e){var c=console;if(c&&c.log&&c.error){c.log('Error running batched script.');c.error(e);}}
;
try {
/* module-key = 'com.atlassian.plugins.atlassian-connect-plugin:confluence-request-marshal-v5', location = 'v5/js/confluence/request-marshal/request-marshal.js' */
define("ac/confluence/request-marshal",(function(){var n=["/api/","/rest/","/rpc/","/download/","/images/","/plugins/"];return{getWhitelist:function(){return n},marshal:function(t){var e=!1;n.forEach((function(n){0===t.url.indexOf(AJS.contextPath()+n)&&(e=!0)}),this);if(!e){let n="";try{n=new window.URL(t.url,window.location.origin).pathname}catch(n){}window.connectHost.trackAnalyticsEvent("jsapi.request.filter",{value:e,url:n})}return!0}}}));
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.plugins.atlassian-connect-plugin:confluence-request-marshal-v5', location = 'v5/js/confluence/request-marshal/request-marshal-loader.js' */
require(["ac/confluence/request-marshal"],(function(e){connectHostRequest.addRequestMarshal(e.marshal)}));
}catch(e){WRMCB(e)};