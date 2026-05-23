// RedOne Auth Helper — background service worker.
//
// Bridge protocol (talks to backend FastAPI on port 8000):
//   GET  /sync/status            heartbeat
//   GET  /sync/next-task         pull next task to perform (recaptcha / proxy-fetch)
//   POST /sync/task-result       submit task result
//   GET  /sync/accounts-probe    backend asks ext to scan logged-in labs tabs
//
// Payload envelope is `{ d: <xor_hex> }` where the inner is JSON XOR'd with
// 0x5A. This is just lightweight obfuscation, NOT security — keeps the
// protocol from being trivially fingerprinted on the wire.
//
// Task kinds:
//   - "recaptcha": harvest grecaptcha.enterprise.execute(site_key, action)
//                  from a labs.google tab. Returns token string.
//   - "proxy_fetch": run `fetch(url, {credentials: "include", ...})` from
//                    inside a labs.google tab so the request inherits the
//                    user's real Chrome session cookies. Returns
//                    {status, headers, body|base64}.
//
// Design choices vs G-Labs original:
//   - Single-account first iteration: picks the FIRST labs.google tab.
//     Multi-tab routing comes later.
//   - Same XOR key (0x5A) for protocol parity in case we ever want to
//     reuse G-Labs server code.
//   - Strips Grok integration entirely.

const BRIDGE_HOST = "http://127.0.0.1:8000";
const POLL_INTERVAL_MS = 1500;
const XOR_KEY = 0x5A;

let _polling = false;
let _connected = false;
let _tokenCount = 0;
let _lastSuccessAt = null;

// Restore counters
chrome.storage.local.get(["tokenCount", "lastSuccessAt"], (data) => {
    _tokenCount = data.tokenCount || 0;
    _lastSuccessAt = data.lastSuccessAt || null;
});

// Keep the service worker alive via alarms (MV3 service workers auto-suspend
// otherwise). Three different alarm intervals to cover edge cases.
chrome.alarms.create("poll", { periodInMinutes: 0.5 });
chrome.alarms.create("heartbeat", { periodInMinutes: 0.25 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === "poll" && !_polling) {
        _pollLoop();
    }
    if (alarm.name === "heartbeat") {
        try {
            await fetch(`${BRIDGE_HOST}/sync/status`, {
                signal: AbortSignal.timeout(3000),
            });
        } catch (_) { /* ignore — backend may be off */ }
    }
});

chrome.runtime.onInstalled.addListener(() => _pollLoop());
chrome.runtime.onStartup.addListener(() => _pollLoop());

// Restart poll loop when any labs.google tab completes load (might be a
// new login).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (
        changeInfo.status === "complete" &&
        tab.url &&
        tab.url.includes("labs.google") &&
        !_polling
    ) {
        _pollLoop();
    }
});


// ── XOR codec ────────────────────────────────────────────────────────

function _encode(plaintext) {
    // Force ASCII via \uXXXX escapes for any non-ASCII chars, then XOR
    // each byte and hex-encode. Matches G-Labs's _serializeTheme exactly.
    const ascii = plaintext.replace(/[-￿]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    let result = "";
    for (let i = 0; i < ascii.length; i++) {
        result += (ascii.charCodeAt(i) ^ XOR_KEY).toString(16).padStart(2, "0");
    }
    return result;
}

function _decode(hexString) {
    let result = "";
    for (let i = 0; i < hexString.length; i += 2) {
        result += String.fromCharCode(parseInt(hexString.substr(i, 2), 16) ^ XOR_KEY);
    }
    return result;
}


// ── Bridge HTTP helpers ──────────────────────────────────────────────

async function _bridgeGet(path) {
    const res = await fetch(`${BRIDGE_HOST}${path}`, {
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`bridge ${path} → HTTP ${res.status}`);
    const raw = await res.json();
    // Server can either send envelope `{d: xor}` or plaintext JSON. Accept both.
    if (raw && typeof raw.d === "string") {
        return JSON.parse(_decode(raw.d));
    }
    return raw;
}

async function _bridgePost(path, payload) {
    const body = JSON.stringify({ d: _encode(JSON.stringify(payload)) });
    const res = await fetch(`${BRIDGE_HOST}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`bridge ${path} → HTTP ${res.status}`);
    const raw = await res.json();
    if (raw && typeof raw.d === "string") {
        return JSON.parse(_decode(raw.d));
    }
    return raw;
}


// ── Tab discovery ────────────────────────────────────────────────────

/**
 * Find the first labs.google tab that's signed in (not on accounts.google.com).
 * Returns { tabId, url, accountEmail } or null.
 *
 * Account email is best-effort scraped from page DOM — Google Labs renders
 * the email in the top-right menu when signed in.
 */
async function _findLabsTab() {
    try {
        const tabs = await chrome.tabs.query({});
        const labsTabs = tabs.filter(t =>
            t.url
            && t.url.includes("labs.google")
            && !t.url.includes("accounts.google.com")
        );
        if (labsTabs.length === 0) return null;
        // Prefer /fx/tools/flow tabs since they have reCAPTCHA loaded
        const ranked = labsTabs.sort((a, b) => {
            const aw = a.url.includes("/fx/tools/flow") ? 0 : 1;
            const bw = b.url.includes("/fx/tools/flow") ? 0 : 1;
            return aw - bw;
        });
        return ranked[0];
    } catch (_) {
        return null;
    }
}

/**
 * Verify the user is actually logged into Google in this Chrome instance.
 * We trust the presence of certain auth cookies — same heuristic G-Labs uses.
 */
async function _isSignedIn() {
    try {
        const cookies = await chrome.cookies.getAll({ domain: ".google.com" });
        return cookies.some(c =>
            c.name === "SID" || c.name === "__Secure-3PSID" || c.name === "SAPISID"
        );
    } catch (_) {
        return false;
    }
}


// ── Task: reCAPTCHA harvest ──────────────────────────────────────────

async function _doRecaptchaTask(task) {
    const { site_key = "", action = "" } = task.payload || {};
    const tab = await _findLabsTab();
    if (!tab) {
        return { token: null, error: "no labs.google tab open" };
    }
    if (!(await _isSignedIn())) {
        return { token: null, error: "user not signed into Google" };
    }
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: async (siteKeyArg, actionArg) => {
                try {
                    if (typeof grecaptcha === "undefined" || !grecaptcha.enterprise) {
                        return { token: null, error: "grecaptcha.enterprise not loaded" };
                    }
                    let key = siteKeyArg;
                    if (!key) {
                        // Try the internal grecaptcha config — most reliable source
                        try {
                            // eslint-disable-next-line no-undef
                            if (typeof ___grecaptcha_cfg !== "undefined" && ___grecaptcha_cfg.clients) {
                                // eslint-disable-next-line no-undef
                                const clients = ___grecaptcha_cfg.clients;
                                const keys = Object.keys(clients);
                                if (keys.length > 0) {
                                    const client = clients[keys[0]];
                                    for (const p of Object.keys(client)) {
                                        const v = client[p];
                                        if (v && typeof v === "object") {
                                            for (const p2 of Object.keys(v)) {
                                                const v2 = v[p2];
                                                if (v2 && typeof v2 === "object" && v2.sitekey) {
                                                    key = v2.sitekey;
                                                    break;
                                                }
                                            }
                                        }
                                        if (key) break;
                                    }
                                }
                            }
                        } catch (_) { /* fall through */ }
                        // Fallback: scrape `?render=<sitekey>` from script tag
                        if (!key) {
                            const scripts = document.querySelectorAll('script[src*="recaptcha"]');
                            for (const el of scripts) {
                                const m = el.src.match(/[?&]render=([^&]+)/);
                                if (m && m[1] !== "explicit") {
                                    key = m[1];
                                    break;
                                }
                            }
                        }
                    }
                    if (!key) return { token: null, error: "no sitekey found in page" };
                    await new Promise(resolve => grecaptcha.enterprise.ready(resolve));
                    const token = await grecaptcha.enterprise.execute(key, { action: actionArg });
                    return { token, error: null, sitekey: key };
                } catch (err) {
                    return { token: null, error: err.message || String(err) };
                }
            },
            args: [site_key, action],
        });
        const r = results && results[0] && results[0].result;
        if (r && r.token) {
            _tokenCount++;
            _lastSuccessAt = Date.now();
            chrome.storage.local.set({
                tokenCount: _tokenCount,
                lastSuccessAt: _lastSuccessAt,
            });
        }
        return r || { token: null, error: "no script result" };
    } catch (e) {
        return { token: null, error: "executeScript: " + String(e) };
    }
}


// ── Task: proxy fetch (run fetch from inside labs.google tab) ────────

async function _doProxyFetchTask(task) {
    const p = task.payload || {};
    const url = String(p.url || "");
    const method = String(p.method || "GET").toUpperCase();
    const headers = (p.headers && typeof p.headers === "object") ? p.headers : {};
    const body = (p.body === null || p.body === undefined) ? null : String(p.body);
    const responseMode = String(p.response_mode || "json"); // "json" | "text" | "arraybuffer"
    const timeoutMs = Math.max(1000, Math.min(600000, Number(p.timeout_ms) || 60000));

    if (!url) return { status: 0, error: "missing url" };

    const tab = await _findLabsTab();
    if (!tab) return { status: 0, error: "no labs.google tab" };

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: async (specJson, bodyStr) => {
                const s = JSON.parse(specJson);
                const ac = new AbortController();
                const timer = setTimeout(() => ac.abort(), s.timeoutMs);
                try {
                    const opts = {
                        method: s.method,
                        headers: s.headers,
                        // Use default credentials mode = "same-origin".
                        // Critical: forcing "include" makes CORS preflight require
                        // `Access-Control-Allow-Credentials: true` from the target
                        // server. aisandbox-pa.googleapis.com (cross-origin from
                        // labs.google) does NOT return that header for our custom
                        // headers → preflight fails → "Failed to fetch".
                        //
                        // With "same-origin":
                        //   - labs.google → labs.google calls (e.g. /fx/api/auth/session,
                        //     trpc media redirect) still send cookies (same-origin)
                        //   - labs.google → aisandbox-pa calls omit cookies, which
                        //     is what we want — Bearer token in Authorization header
                        //     is the actual auth mechanism.
                        // Matches the original Playwright FlowClient behavior exactly.
                        signal: ac.signal,
                    };
                    if (bodyStr) opts.body = bodyStr;
                    const res = await fetch(s.url, opts);
                    const status = res.status;
                    const respHeaders = {};
                    try {
                        for (const [k, v] of res.headers.entries()) respHeaders[k] = v;
                    } catch (_) { /* not iterable in some envs */ }

                    if (s.responseMode === "arraybuffer") {
                        const buf = await res.arrayBuffer();
                        const bytes = new Uint8Array(buf);
                        let bin = "";
                        // Build base64 in chunks to avoid stack overflow on large bodies
                        const CHUNK = 0x8000;
                        for (let i = 0; i < bytes.length; i += CHUNK) {
                            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                        }
                        clearTimeout(timer);
                        return {
                            status,
                            headers: respHeaders,
                            body_b64: btoa(bin),
                            content_type: respHeaders["content-type"] || "",
                        };
                    }
                    if (s.responseMode === "text") {
                        const txt = await res.text();
                        clearTimeout(timer);
                        return { status, headers: respHeaders, body: txt };
                    }
                    // Default: json (with text fallback)
                    let txt = "";
                    try { txt = await res.text(); } catch (_) { /* empty body */ }
                    let data = null;
                    try { data = txt ? JSON.parse(txt) : null; } catch (_) { /* not json, return as text */ }
                    clearTimeout(timer);
                    return {
                        status,
                        headers: respHeaders,
                        body: data,
                        body_text: data === null ? txt : null,
                    };
                } catch (err) {
                    clearTimeout(timer);
                    return { status: 0, error: "fetch: " + (err.message || String(err)) };
                }
            },
            args: [
                JSON.stringify({ url, method, headers, responseMode, timeoutMs }),
                body || "",
            ],
        });
        return (results && results[0] && results[0].result) || { status: 0, error: "no script result" };
    } catch (e) {
        return { status: 0, error: "executeScript: " + String(e) };
    }
}


// ── Poll loop ────────────────────────────────────────────────────────

async function _pollLoop() {
    if (_polling) return;
    _polling = true;
    while (_polling) {
        try {
            // Tell the backend what we currently can/can't do so it can
            // surface meaningful errors instead of hanging.
            const tab = await _findLabsTab();
            const signedIn = await _isSignedIn();
            const status = !tab ? "no_tab" : !signedIn ? "no_login" : "ready";

            const params = new URLSearchParams({
                tab_status: status,
                tab_url: tab && tab.url ? tab.url : "",
            }).toString();

            const data = await _bridgeGet(`/sync/next-task?${params}`);
            _connected = true;

            const task = data && data.task;
            if (task && task.id && task.kind) {
                let result = null;
                if (task.kind === "recaptcha") {
                    result = await _doRecaptchaTask(task);
                } else if (task.kind === "proxy_fetch") {
                    result = await _doProxyFetchTask(task);
                } else {
                    result = { error: `unknown task kind: ${task.kind}` };
                }
                try {
                    await _bridgePost("/sync/task-result", {
                        task_id: task.id,
                        kind: task.kind,
                        result,
                    });
                } catch (_) { /* best effort */ }
            }
        } catch (_) {
            _connected = false;
        }
        await _delay(POLL_INTERVAL_MS);
    }
}

function _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


// ── Popup / content script message handlers ──────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "GET_METRICS") {
        (async () => {
            // Active probe — re-verify backend reachability before
            // reporting status. Without this, a freshly-woken service
            // worker would still have `_connected = false` (its initial
            // value) and the popup would falsely show "Mất kết nối" for
            // up to one poll interval (~1.5s) after each wake.
            try {
                const r = await fetch(`${BRIDGE_HOST}/sync/status`, {
                    signal: AbortSignal.timeout(3000),
                });
                _connected = r.ok;
            } catch (_) {
                _connected = false;
            }
            // While we have the SW awake, also ensure the poll loop is
            // running. After a SW restart, the poll alarm doesn't fire
            // for up to 30s — kicking off pollLoop here closes that gap.
            if (!_polling) _pollLoop();

            const tab = await _findLabsTab();
            const signedIn = await _isSignedIn();
            sendResponse({
                connected: _connected,
                tokenCount: _tokenCount,
                lastSuccessAt: _lastSuccessAt,
                hasTab: !!tab,
                signedIn,
                tabUrl: tab ? tab.url : null,
            });
        })();
        return true;
    }
    if (msg && msg.type === "RESET_METRICS") {
        _tokenCount = 0;
        _lastSuccessAt = null;
        chrome.storage.local.set({ tokenCount: 0, lastSuccessAt: null });
        sendResponse({ ok: true });
        return true;
    }
    return false;
});

// ── Initial poll on every service worker wake ─────────────────────────
// MV3 service workers go idle when not processing events. Each wake-up
// re-evaluates this file from the top — kick off the poll loop here so
// the connection is restored immediately, rather than waiting up to 30s
// for the first alarm tick. The `if (_polling) return` guard inside
// _pollLoop prevents duplicate loops.
_pollLoop();
