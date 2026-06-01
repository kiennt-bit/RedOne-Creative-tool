// RedOne Auth Helper — Shakker.ai content script.
//
// Runs on every shakker.ai page. Reads the user's auth state straight from
// the page (cookies + localStorage) and forwards it to the background
// service worker, which POSTs it to the RedOne backend bridge.
//
// State we extract:
//   • cookie `usertoken`             → 44-char hex API token (sent as `token:` header)
//   • cookie `webid`                 → shakker client identifier (used as `cid` in payloads)
//   • localStorage `liblibai_userinfo` (JSON) → {id, uuid, email, activeAccounts[0].accountId}
//
// Why content script (not background polling cookies):
//   • document.cookie is the simplest source — works without the cookies API
//   • localStorage is content-script-only (background can't reach it directly)
//   • We re-sync periodically (60s) so token rotations and credit changes
//     get picked up even if the user keeps the tab open for hours

(function () {
    'use strict';

    function parseCookies() {
        const out = {};
        document.cookie.split(';').forEach(c => {
            const eq = c.indexOf('=');
            if (eq <= 0) return;
            const k = c.slice(0, eq).trim();
            const v = c.slice(eq + 1).trim();
            if (k) out[k] = v;
        });
        return out;
    }

    function readUserInfo() {
        // localStorage stores `liblibai_userinfo` as JSON of either {value: <userObj>}
        // or directly <userObj>. We handle both shapes.
        try {
            const raw = localStorage.getItem('liblibai_userinfo');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const u = parsed && typeof parsed === 'object' && 'value' in parsed
                ? parsed.value
                : parsed;
            if (!u || typeof u !== 'object') return null;
            return u;
        } catch (_) {
            return null;
        }
    }

    function readShakkerState() {
        const cookies = parseCookies();
        // Two cookies hold the same value — prefer the explicit `usertoken`
        // (newer naming) but fall back to legacy `liblibai_usertoken`.
        const token = cookies.usertoken || cookies.liblibai_usertoken;
        if (!token) return null;

        const u = readUserInfo();
        if (!u || !u.uuid) {
            // Without uuid we can't dedupe accounts in the backend DB —
            // skip rather than create orphaned rows.
            return null;
        }

        let accountId = null;
        if (Array.isArray(u.activeAccounts) && u.activeAccounts.length > 0) {
            accountId = u.activeAccounts[0].accountId || null;
        }

        return {
            user_uuid: String(u.uuid),
            token: String(token),
            email: u.email ? String(u.email) : null,
            user_id: typeof u.id === 'number' ? u.id : null,
            account_id: typeof accountId === 'number' ? accountId : null,
            webid: cookies.webid || null,
        };
    }

    let _lastSyncedToken = null;

    async function syncToBackground() {
        const state = readShakkerState();
        if (!state) return;
        // Tiny dedupe: if the token hasn't changed since last sync within
        // this tab session, still re-sync every ~5 min so the backend's
        // last_check_at stays fresh.
        const now = Date.now();
        if (state.token === _lastSyncedToken &&
            window._redoneShakkerLastSync &&
            now - window._redoneShakkerLastSync < 5 * 60 * 1000) {
            return;
        }
        try {
            const res = await chrome.runtime.sendMessage({
                type: 'SHAKKER_SYNC',
                state,
            });
            if (res && res.ok) {
                _lastSyncedToken = state.token;
                window._redoneShakkerLastSync = now;
            }
        } catch (_) {
            // Background SW may be asleep — alarm will retry. Silent.
        }
    }

    // Initial sync after page settles. Shakker is a SPA so localStorage
    // and cookies are usually populated within ~1s of document_idle.
    setTimeout(syncToBackground, 2000);

    // Re-sync periodically. Catches: token rotation, credit changes from
    // gens elsewhere, user switching shakker accounts, etc.
    setInterval(syncToBackground, 60 * 1000);

    // Re-sync on visibility (user comes back to tab)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            setTimeout(syncToBackground, 500);
        }
    });
})();
