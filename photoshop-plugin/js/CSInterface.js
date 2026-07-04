/**
 * CSInterface.js — Minimal shim for Adobe CEP panels.
 *
 * In production, this file should be replaced with the official CSInterface.js
 * from Adobe's CEP-Resources repository:
 *   https://github.com/Adobe-CEP/CEP-Resources
 *
 * This shim provides the essential subset used by the RedOne GenFill panel
 * so the plugin can load. Download the full version for production use.
 *
 * @version 11.x compatible
 */

/* global cep */

/**
 * CSInterface class — bridge between HTML panel and host application.
 * @constructor
 */
function CSInterface() {
  // In a real CEP environment, __adobe_cep__ is injected by the host
  this._hostEnvironment = null;
  try {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      this._hostEnvironment = JSON.parse(window.__adobe_cep__.getHostEnvironment());
    }
  } catch (e) {
    // Not running in CEP host — debug mode
  }
}

/**
 * Evaluate an ExtendScript expression in the host application.
 * @param {string} script - The ExtendScript to evaluate.
 * @param {function} [callback] - Optional callback receiving the result string.
 */
CSInterface.prototype.evalScript = function (script, callback) {
  try {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      if (callback) {
        window.__adobe_cep__.evalScript(script, callback);
      } else {
        window.__adobe_cep__.evalScript(script);
      }
    } else {
      // Debug fallback
      console.log('[CSInterface.evalScript]', script.substring(0, 80));
      if (callback) callback('EvalScript cycled');
    }
  } catch (e) {
    console.error('evalScript error:', e);
    if (callback) callback('ERROR:' + e.message);
  }
};

/**
 * Get the host environment info.
 * @returns {object} Host environment data.
 */
CSInterface.prototype.getHostEnvironment = function () {
  return this._hostEnvironment;
};

/**
 * Retrieve the file system path of the extension.
 * @returns {string} The extension root path.
 */
CSInterface.prototype.getSystemPath = function (type) {
  try {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      return window.__adobe_cep__.getSystemPath(type);
    }
  } catch (e) { /* ignore */ }
  return '';
};

/**
 * Register interest in a specific CEP event.
 * @param {string} type - The event type.
 * @param {function} listener - The handler function.
 */
CSInterface.prototype.addEventListener = function (type, listener) {
  try {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      window.__adobe_cep__.addEventListener(type, listener);
    }
  } catch (e) { /* ignore */ }
};

/**
 * Remove a CEP event listener.
 * @param {string} type - The event type.
 * @param {function} listener - The handler function.
 */
CSInterface.prototype.removeEventListener = function (type, listener) {
  try {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      window.__adobe_cep__.removeEventListener(type, listener);
    }
  } catch (e) { /* ignore */ }
};

/**
 * Dispatch a CEP event.
 * @param {object} event - Event to dispatch.
 */
CSInterface.prototype.dispatchEvent = function (event) {
  try {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      window.__adobe_cep__.dispatchEvent(event);
    }
  } catch (e) { /* ignore */ }
};

/**
 * Close the extension panel.
 */
CSInterface.prototype.closeExtension = function () {
  try {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      window.__adobe_cep__.closeExtension();
    }
  } catch (e) { /* ignore */ }
};

/**
 * Request to open a URL in the default browser.
 * @param {string} url - The URL to open.
 */
CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  try {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      window.__adobe_cep__.openURLInDefaultBrowser(url);
    } else if (typeof cep !== 'undefined' && cep.util) {
      cep.util.openURLInDefaultBrowser(url);
    }
  } catch (e) { /* ignore */ }
};

// System path type constants
CSInterface.prototype.EXTENSION = 'extension';
CSInterface.prototype.USER_DATA = 'userData';
CSInterface.prototype.HOST_DATA = 'hostData';
CSInterface.prototype.COMMON_FILES = 'commonFiles';
CSInterface.prototype.MY_DOCUMENTS = 'myDocuments';
