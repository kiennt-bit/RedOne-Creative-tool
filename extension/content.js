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

function autoClickSignIn() {
    if (!location.href.includes("labs.google")) return;
    
    const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
    const signInBtn = buttons.find(el => {
        const txt = el.textContent.trim().toLowerCase();
        return txt === 'sign in' || 
               txt === 'đăng nhập' || 
               txt.includes('sign in') || 
               txt.includes('đăng nhập') ||
               txt.includes('login') ||
               txt.includes('sign in to labs');
    });
    
    if (signInBtn) {
        console.log("RedOne Auto-clicker: Found Sign In button on Google Labs, clicking...");
        signInBtn.click();
    }
}

setTimeout(autoClickSignIn, 1500);
setTimeout(autoClickSignIn, 3000);
setTimeout(autoClickSignIn, 5000);
