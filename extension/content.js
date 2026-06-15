// Minimal content script — injected into every labs.google tab.
//
// For v1 we don't put a floating button on the page. The extension popup
// (click extension icon) is enough UI. This file exists mainly so future
// versions can add an in-page status FAB without re-shipping the manifest.
//
// Currently we just signal "page loaded" so background.js can re-poll
// quickly when a labs.google tab finishes navigating.

try {
    chrome.runtime.sendMessage({ type: "LABS_TAB_READY", url: location.href });
} catch (_) { /* extension may not be fully alive yet */ }
