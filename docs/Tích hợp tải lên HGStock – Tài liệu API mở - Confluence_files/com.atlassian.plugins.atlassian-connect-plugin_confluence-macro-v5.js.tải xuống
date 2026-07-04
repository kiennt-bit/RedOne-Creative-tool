WRMCB=function(e){var c=console;if(c&&c.log&&c.error){c.log('Error running batched script.');c.error(e);}}
;
try {
/* module-key = 'com.atlassian.plugins.atlassian-connect-plugin:confluence-macro-v5', location = 'v5/js/confluence/macro/bookmark.js' */
!function(o,e){e("ac/confluence/macro/bookmark",["ajs"],(function(o){var e;return{createBookmark:function(){return e=o.Rte.getEditor().selection.getBookmark()},destroyBookmark:function(){if(e){e.keep=!1;o.Rte.getEditor().selection.moveToBookmark(e);e=null}}}}))}(AJS.$,define);
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.plugins.atlassian-connect-plugin:confluence-macro-v5', location = 'v5/js/confluence/macro/editor.js' */
!function(e,t){t("ac/confluence/macro/editor",["ac/confluence/macro","ac/confluence/macro/bookmark","ajs","ac/confluence/utils"],(function(t,o,a,n){var r;return{close:function(){connectHost.dialog.close()},getMacroData:function(e){const o=t.getCurrentMacroParameters();if(o)return e(o);var a=e._context.extension.options.productContext["macro.id"];return e(t.getMacroData(a))},getMacroBody:function(e){return e(r)},openCustomEditor:function(c,i){var d;if(!n.isFabricEditor()){a.Rte.getEditor().focus();var s=a.Rte.getEditor().selection.getNode();d=o.createBookmark();t.setLastSelectedConnectMacroNode(s)}t.setUnsavedMacroData(c.name,c.body?c.body:"",c.params,d);r=c.body;var u=a.Meta.get("page-id")||"undefined";"undefined"===u&&(u="0");var l=e.extend(c.productContext||{},{"page.id":u}),f={addon_key:i.addonKey,key:c.name,options:{productContext:l}},m=i.width||null,g=i.height||null,p={header:c.params?i.editTitle:i.insertTitle,submitText:c.params?"Save":"Insert",width:m,height:g,onHide:function(){o.destroyBookmark();t.clearMacroDataParams()}};"100%"!==m&&"100%"!==g&&(p.chrome=!0);connectHost.dialog.create(f,p)}}}))}(AJS.$,define);
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.plugins.atlassian-connect-plugin:confluence-macro-v5', location = 'v5/js/confluence/macro/property-panel-iframe.js' */
!function(e,n){n("ac/confluence/macro/property-panel-iframe",["ac/confluence/macro","ajs"],(function(n,a){return function(t){return{propertyPanelIFrameInjector:function(o){var c={classifier:"property-panel","page.id":a.Meta.get("page-id")},r=a.Rte.getEditor().selection;n.setLastSelectedConnectMacroNode(r.getNode());e.ajax(t,{data:c}).done((function(n){var a=e(n);a.css("display","none");o.panel.append(a)}))}}}}))}(AJS.$,define);
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.plugins.atlassian-connect-plugin:confluence-macro-v5', location = 'v5/js/confluence/macro/property-panel-controls.js' */
!function(n,t){t("ac/confluence/macro/property-panel-controls",["underscore"],(function(n){return function(t){var c;return{getControls:function(r){r(c=c||function(c){try{return n.first(n.filter(n.pluck(c,t),n.isObject))}catch(n){return null}}(WRM.data.claim("com.atlassian.plugins.atlassian-connect-plugin:confluence-macro.property-panel-controls")))}}}}))}(AJS.$,define);
}catch(e){WRMCB(e)};
;
try {
/* module-key = 'com.atlassian.plugins.atlassian-connect-plugin:confluence-macro-v5', location = 'v5/js/confluence/macro/property-panel-event.js' */
!function(n,e){e("ac/confluence/macro/property-panel-event",[],(function(){var e,t=[],r=function(n,e,t){connectHost.broadcastEvent(n,(function(n){return-1!==n.extension_id.indexOf(e)}));t()};return{waitForPropertyPanelEventBindings:function(){e=!1;t=[]},propertyPanelEventsBound:function(){e=!0;for(;t.length>0;){var n=t.shift();r(n.eventKey,n.macroName,n.doneCallback)}},handlePropertyPanelEvent:function(o,c,a){var i=n.Deferred();if("click"===o){var u=function(n,e){return"click."+n+"."+e+".macro.property-panel"}(c,a);e?r(u,a,i.resolve):function(n,e,r){t.length<10&&t.push({eventKey:n,macroName:e,doneCallback:r})}(u,a,i.resolve)}return i},_getQueueLength:function(){return t.length}}}))}(AJS.$,define);
}catch(e){WRMCB(e)};