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
// Design choices for this bridge:
//   - Single-account first iteration: picks the FIRST labs.google tab.
//     Multi-tab routing comes later.
//   - Same XOR key (0x5A) for protocol parity with the backend.

const BRIDGE_HOSTS = ["http://127.0.0.1:8000", "http://127.0.0.1:8001", "http://127.0.0.1:8099", "http://127.0.0.1:8098"];
const POLL_INTERVAL_MS = 1500;
// When we just claimed a task AND still have spare capacity, poll again
// almost immediately so a batch of N parallel items fans out in a few
// hundred ms instead of N × POLL_INTERVAL_MS. Only used during fan-out.
const FAST_POLL_MS = 150;
// Max tasks the extension runs CONCURRENTLY inside the labs.google tab.
// Previously every task ran strictly one-at-a-time (the poll loop awaited
// each ~27s generation before claiming the next), so the backend's
// "luồng song song" setting had no effect. We now dispatch up to this many
// at once. Kept modest: too many simultaneous generate calls from one
// session looks bot-like to Google → more reCAPTCHA / 429. The backend's
// own batch size (the user's concurrency setting) is the real throttle;
// this is just a safety ceiling so it can actually run in parallel.
const MAX_CONCURRENT = 4;
const XOR_KEY = 0x5A;

let _polling = false;
let _inFlight = 0;          // tasks currently executing (not yet result-posted)
let _connected = false;
let _tokenCount = 0;
let _lastSuccessAt = null;

// Anti-idle mouse jiggle — mimics human cursor activity on labs.google tab
// when tasks are running. Reduces reCAPTCHA risk score accumulation during
// long batch runs. Inspired by G-Labs Automation's grokKeepAlive pattern.
let _lastJiggleAt = 0;

// Automatic tab prefetch — auto-open labs.google tab if none found.
// 60s cooldown prevents spamming tabs on repeated failures.
let _lastPrefetchAt = 0;
const _PREFETCH_COOLDOWN_MS = 60000;

// Shakker bridge state — set when content_shakker.js sends SHAKKER_SYNC.
// Restored from chrome.storage at SW wake so the popup shows correct
// "last seen" info even right after a service worker restart.
let _shakkerEmail = null;
// Short-lived shared Google login request: set when the member clicks
// "Đăng nhập tài khoản chung", consumed by content_accounts.js, then cleared.
// Held only in SW memory (never persisted to storage).
let _pendingGoogleLogin = null;
let _shakkerLastSync = null;
let _targetGoogleEmail = null;

// Restore counters
chrome.storage.local.get(
    ["tokenCount", "lastSuccessAt", "shakkerEmail", "shakkerLastSync", "targetGoogleEmail"],
    (data) => {
        _tokenCount = data.tokenCount || 0;
        _lastSuccessAt = data.lastSuccessAt || null;
        _shakkerEmail = data.shakkerEmail || null;
        _shakkerLastSync = data.shakkerLastSync || null;
        _targetGoogleEmail = data.targetGoogleEmail || null;
    }
);

// Keep the service worker alive via alarms (MV3 service workers auto-suspend
// otherwise). Three different alarm intervals to cover edge cases.
chrome.alarms.create("poll", { periodInMinutes: 0.5 });
chrome.alarms.create("heartbeat", { periodInMinutes: 0.25 });
// Anti-idle: inject mouse/scroll activity every ~2.5min to keep reCAPTCHA
// risk score low during long batch runs.
chrome.alarms.create("antiIdle", { periodInMinutes: 2.5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === "poll" && !_polling) {
        _pollLoop();
    }
    if (alarm.name === "heartbeat") {
        for (const h of BRIDGE_HOSTS) {
            try {
                await fetch(`${h}/sync/status`, {
                    signal: AbortSignal.timeout(3000),
                });
                break; // One successful heartbeat is enough for keep-alive
            } catch (_) { /* ignore */ }
        }
    }
    // Anti-idle mouse jiggle: only when tasks are actively running AND
    // at least 2 minutes since last jiggle (avoids excessive injection).
    if (alarm.name === "antiIdle" && _inFlight > 0) {
        const minInterval = 120000 + Math.floor(Math.random() * 120000);
        if (Date.now() - _lastJiggleAt < minInterval) return;
        _lastJiggleAt = Date.now();
        try {
            const tab = await _findLabsTab();
            if (!tab) return;
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: "MAIN",
                func: () => {
                    try {
                        // Random scroll down then back up
                        const scrollY = Math.floor(200 + Math.random() * 400);
                        window.scrollBy(0, scrollY);
                        setTimeout(() => {
                            try { window.scrollBy(0, -scrollY); } catch (_) { }
                        }, 500 + Math.floor(Math.random() * 1000));
                        // Random mouse move
                        const x = Math.floor(100 + Math.random() * 700);
                        const y = Math.floor(100 + Math.random() * 400);
                        const ev = new MouseEvent("mousemove", {
                            clientX: x, clientY: y,
                            bubbles: true, cancelable: true, view: window,
                        });
                        document.dispatchEvent(ev);
                    } catch (_) { /* best effort */ }
                },
            });
        } catch (_) { /* best effort */ }
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
    // each byte and hex-encode.
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

async function _bridgeGet(host, path) {
    const res = await fetch(`${host}${path}`, {
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

async function _bridgePost(host, path, payload) {
    const body = JSON.stringify({ d: _encode(JSON.stringify(payload)) });
    const res = await fetch(`${host}${path}`, {
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
 * Find the first shakker.ai tab open in this Chrome instance.
 * Returns the tab object or null. Used by the popup to render a
 * "shakker tab open ✓" indicator and decide whether to show the
 * "Mở Shakker.ai" button.
 */
async function _findShakkerTab() {
    try {
        const tabs = await chrome.tabs.query({});
        const matches = tabs.filter(t => t.url && t.url.includes("shakker.ai"));
        return matches[0] || null;
    } catch (_) {
        return null;
    }
}


/**
 * Find the first labs.google tab that's signed in (not on accounts.google.com).
 * Returns { tabId, url, accountEmail } or null.
 *
 * Account email is best-effort scraped from page DOM — Google Labs renders
 * the email in the top-right menu when signed in.
 */
async function _findLabsTab() {
    // Retry a few times: a labs.google tab can momentarily be invisible to
    // chrome.tabs.query while it's navigating/redirecting, freshly discarded by
    // Chrome's Memory Saver, or right when the MV3 service worker wakes up.
    // Returning null too eagerly here makes the backend declare the account's
    // session "dead" on a split-second blip — the intermittent bug.
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const tabs = await chrome.tabs.query({});
            const labsTabs = tabs.filter(t => {
                // During navigation `url` may be empty but `pendingUrl` holds
                // the target — accept either.
                const u = t.url || t.pendingUrl || "";
                return u.includes("labs.google") && !u.includes("accounts.google.com");
            });
            if (labsTabs.length > 0) {
                // Rank: non-discarded first, then a Flow tab (reCAPTCHA loaded).
                // Match "/tools/flow" (locale-agnostic) — real URLs include a
                // locale segment, e.g. /fx/vi/tools/flow, /fx/en/tools/flow.
                const score = (t) => {
                    const u = t.url || t.pendingUrl || "";
                    return (t.discarded ? 2 : 0) + (u.includes("/tools/flow") ? 0 : 1);
                };
                return labsTabs.sort((a, b) => score(a) - score(b))[0];
            }
        } catch (_) { /* fall through to retry */ }
        await new Promise(r => setTimeout(r, 300));
    }

    // ── Automatic Tab Prefetch ────────────────────────────────────────
    // No labs.google tab found after retries. Auto-open one in the
    // background so the next task doesn't fail with "no labs.google tab".
    // 60s cooldown prevents rapid-fire tab creation on repeated failures.
    // IMPORTANT: Only prefetch when backend is connected — otherwise the
    // extension opens phantom tabs even after the user has shut down the
    // tool (reported bug: "extension tự mở tab khi đã tắt tool").
    if (_connected && Date.now() - _lastPrefetchAt > _PREFETCH_COOLDOWN_MS) {
        _lastPrefetchAt = Date.now();
        try {
            const newTab = await chrome.tabs.create({
                url: "https://labs.google/fx/tools/flow",
                active: false,
            });
            // Wait for page to finish loading
            await new Promise((resolve) => {
                const listener = (id, info) => {
                    if (id === newTab.id && info.status === "complete") {
                        chrome.tabs.onUpdated.removeListener(listener);
                        resolve();
                    }
                };
                chrome.tabs.onUpdated.addListener(listener);
                setTimeout(() => {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }, 15000);
            });
            return newTab;
        } catch (_) { /* tab create failed — give up */ }
    }
    return null;
}

/**
 * Verify the user is actually logged into Google in this Chrome instance.
 * We trust the presence of certain auth cookies.
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

// ── Task: read browser cookies for given domains ────────────────────
// Used by the backend to feed yt-dlp YouTube auth without exporting a
// cookies.txt by hand. chrome.cookies returns ALREADY-DECRYPTED cookies, so
// this sidesteps yt-dlp's "could not copy Chrome cookie database" problem
// (which fails while Chrome is running). Requires host_permissions for the
// domains + the "cookies" permission (manifest).
async function _doGetCookiesTask(task) {
    const domains = (task.payload && task.payload.domains) || [".youtube.com", ".google.com"];
    const out = [];
    for (const d of domains) {
        try {
            const cks = await chrome.cookies.getAll({ domain: d });
            for (const c of cks) {
                out.push({
                    domain: c.domain,
                    name: c.name,
                    value: c.value,
                    path: c.path || "/",
                    secure: !!c.secure,
                    hostOnly: !!c.hostOnly,
                    expirationDate: c.expirationDate || 0,
                });
            }
        } catch (_) { /* skip this domain */ }
    }
    return { cookies: out, count: out.length };
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
                    // 15s timeout: grecaptcha.execute can hang indefinitely
                    // when reCAPTCHA is in a bad state. G-Labs uses the same
                    // Promise.race pattern to prevent stuck tasks.
                    const token = await Promise.race([
                        grecaptcha.enterprise.execute(key, { action: actionArg }),
                        new Promise((_, reject) => setTimeout(
                            () => reject(new Error("grecaptcha execute timeout (15s)")),
                            15000,
                        )),
                    ]);
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

// ── Server-driven session commands ──────────────────────────────────
// Backend pushes these to reset session state when 403s cascade.
// Mirrors G-Labs' _applyThemeUpdates command system.
async function _executeSessionCommand(cmd) {
    const command = cmd.cmd || cmd.command;
    const params = cmd.params || {};
    try {
        if (command === "set_target_email") {
            _targetGoogleEmail = params.email || null;
            chrome.storage.local.set({ targetGoogleEmail: _targetGoogleEmail });
            console.log(`[Extension] Set target Google login email: ${_targetGoogleEmail}`);
        } else if (command === "clear_cookies") {
            // Clear ALL labs.google cookies → force session re-login
            const cookies = await chrome.cookies.getAll({ domain: "labs.google" });
            for (const c of cookies) {
                const url = `https://${c.domain.replace(/^\./, "")}${c.path}`;
                await chrome.cookies.remove({ url, name: c.name });
            }
        } else if (command === "reload_tab") {
            // F5 reload the labs.google tab
            const tab = await _findLabsTab();
            if (tab) {
                await chrome.tabs.reload(tab.id);
                await new Promise((resolve) => {
                    const listener = (id, info) => {
                        if (id === tab.id && info.status === "complete") {
                            chrome.tabs.onUpdated.removeListener(listener);
                            resolve();
                        }
                    };
                    chrome.tabs.onUpdated.addListener(listener);
                    setTimeout(() => {
                        chrome.tabs.onUpdated.removeListener(listener);
                        resolve();
                    }, 15000);
                });
            }
        } else if (command === "navigate_toggle") {
            // Toggle between /tools/flow and /fx to reset page session state
            const tab = await _findLabsTab();
            if (tab) {
                const currentUrl = (tab.url || "");
                const nextUrl = currentUrl.includes("/tools/flow")
                    ? "https://labs.google/fx"
                    : "https://labs.google/fx/tools/flow";
                await chrome.tabs.update(tab.id, { url: nextUrl });
                await new Promise((resolve) => {
                    const listener = (id, info) => {
                        if (id === tab.id && info.status === "complete") {
                            chrome.tabs.onUpdated.removeListener(listener);
                            resolve();
                        }
                    };
                    chrome.tabs.onUpdated.addListener(listener);
                    setTimeout(() => {
                        chrome.tabs.onUpdated.removeListener(listener);
                        resolve();
                    }, 15000);
                });
            }
        } else if (command === "delay") {
            const ms = params.ms || 1000;
            await new Promise(r => setTimeout(r, ms));
        }
    } catch (_) { /* best effort — commands are advisory, not critical */ }
}

// Execute ONE task to completion and post its result. Runs detached from
// the poll loop (we don't await it there) so multiple tasks can be in
// flight at once. Always decrements _inFlight via the caller's .finally().
async function _runTask(task) {
    let result = null;
    try {
        if (task.kind === "recaptcha") {
            result = await _doRecaptchaTask(task);
        } else if (task.kind === "proxy_fetch") {
            result = await _doProxyFetchTask(task);
        } else if (task.kind === "get_cookies") {
            result = await _doGetCookiesTask(task);
        } else {
            result = { error: `unknown task kind: ${task.kind}` };
        }
    } catch (e) {
        // Never let a thrown task kill the loop — report it as a result so
        // the awaiting backend future resolves instead of timing out.
        result = { error: String((e && e.message) || e) };
    }
    try {
        await _bridgePost(task.sourceHost || BRIDGE_HOSTS[0], "/sync/task-result", {
            task_id: task.id,
            kind: task.kind,
            result,
        });
    } catch (_) { /* best effort */ }
}

async function _pollLoop() {
    if (_polling) return;
    _polling = true;
    while (_polling) {
        let claimed = false;
        try {
            // Tell the backend what we currently can/can't do so it can
            // surface meaningful errors instead of hanging.
            const tab = await _findLabsTab();
            const signedIn = await _isSignedIn();
            const status = !tab ? "no_tab" : !signedIn ? "no_login" : "ready";

            // How many more tasks we can take right now. When 0 we still
            // poll (to keep tab_status fresh) but the backend hands nothing.
            const capacity = Math.max(0, MAX_CONCURRENT - _inFlight);

            const params = new URLSearchParams({
                tab_status: status,
                tab_url: tab && tab.url ? tab.url : "",
                capacity: String(capacity),
            }).toString();

            let data = null;
            let sourceHost = null;
            let backendReachable = false;
            for (const host of BRIDGE_HOSTS) {
                try {
                    const resData = await _bridgeGet(host, `/sync/next-task?${params}`);
                    backendReachable = true;  // got a response → backend is alive
                    if (!data) data = resData; // keep first valid response (for session_commands)
                    if (resData && resData.task) {
                        data = resData;
                        sourceHost = host;
                        break;
                    }
                    break;  // got valid response, no need to try other hosts
                } catch (_) { }
            }
            _connected = backendReachable;

            // ── Server-driven session commands ──────────────────
            // Execute commands piggybacked on the poll response BEFORE
            // processing any task. This mirrors G-Labs' _applyThemeUpdates.
            if (data && data.session_commands && Array.isArray(data.session_commands)) {
                for (const cmd of data.session_commands) {
                    await _executeSessionCommand(cmd);
                }
            }

            const task = data && data.task;
            if (task && task.id && task.kind) {
                task.sourceHost = sourceHost;
                claimed = true;
                _inFlight++;
                // Fire WITHOUT awaiting → the loop is free to claim more
                // tasks (up to MAX_CONCURRENT). This is what makes the
                // "luồng song song" setting actually run in parallel.
                _runTask(task).finally(() => {
                    _inFlight = Math.max(0, _inFlight - 1);
                });
            }
        } catch (_) {
            _connected = false;
        }
        // Just grabbed one and still have room → poll again right away to
        // fan out the rest of the batch; otherwise idle the normal interval.
        const moreRoom = _inFlight < MAX_CONCURRENT;
        await _delay(claimed && moreRoom ? FAST_POLL_MS : POLL_INTERVAL_MS);
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
                _connected = false;
                for (const h of BRIDGE_HOSTS) {
                    try {
                        const r = await fetch(`${h}/sync/status`, {
                            signal: AbortSignal.timeout(3000),
                        });
                        if (r.ok) {
                            _connected = true;
                            break;
                        }
                    } catch (_) {}
                }
            } catch (_) {
                _connected = false;
            }
            // While we have the SW awake, also ensure the poll loop is
            // running. After a SW restart, the poll alarm doesn't fire
            // for up to 30s — kicking off pollLoop here closes that gap.
            if (!_polling) _pollLoop();

            const tab = await _findLabsTab();
            const signedIn = await _isSignedIn();
            const shakkerTab = await _findShakkerTab();
            sendResponse({
                connected: _connected,
                tokenCount: _tokenCount,
                lastSuccessAt: _lastSuccessAt,
                hasTab: !!tab,
                signedIn,
                tabUrl: tab ? tab.url : null,
                // Shakker bridge status — separate channel, independent of Flow.
                shakker: {
                    hasTab: !!shakkerTab,
                    tabUrl: shakkerTab ? shakkerTab.url : null,
                    email: _shakkerEmail,
                    lastSync: _shakkerLastSync,
                },
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
    if (msg && msg.type === "SHAKKER_SYNC") {
        // Forwarded from content_shakker.js whenever the user has shakker.ai
        // open. Payload is the slim {user_uuid, token, email, user_id,
        // account_id, webid} object — we forward straight to the bridge.
        //
        // Posted to /sync/shakker-account (NOT /api/shakker-accounts/sync)
        // so the request bypasses the OAuth auth gate — same trust model
        // as the Flow bridge protocol (local-only origin, no auth).
        (async () => {
            try {
                let r = null;
                for (const host of BRIDGE_HOSTS) {
                    try {
                        r = await _bridgePost(host, "/sync/shakker-account", msg.state || {});
                        if (r && r.ok) break;
                    } catch (_) {}
                }
                if (r && r.ok) {
                    _shakkerEmail = (msg.state && msg.state.email) || _shakkerEmail;
                    _shakkerLastSync = Date.now();
                    chrome.storage.local.set({
                        shakkerEmail: _shakkerEmail,
                        shakkerLastSync: _shakkerLastSync,
                    });
                }
                sendResponse({ ok: !!(r && r.ok), result: r });
            } catch (e) {
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }
    // ── Shared Google account auto-login ─────────────────────────────
    if (msg && msg.type === "LOGIN_SHARED_GOOGLE") {
        // Member clicked "Đăng nhập tài khoản chung": fetch the shared account
        // from the backend (which got it from the Hub), stash it briefly, and
        // open the Google login page — content_accounts.js fills it in.
        (async () => {
            try {
                let r = null;
                for (const host of BRIDGE_HOSTS) {
                    try {
                        r = await _bridgeGet(host, "/sync/shared-google");
                        if (r && r.ok) break;
                    } catch (_) {}
                }
                if (!r || !r.ok || !r.email || !r.password) {
                    sendResponse({ ok: false, error: (r && r.reason) || "Chưa có tài khoản chung" });
                    return;
                }
                _pendingGoogleLogin = { email: r.email, password: r.password, ts: Date.now() };
                await chrome.tabs.create({
                    url: "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Flabs.google%2Ffx%2Ftools%2Fflow",
                });
                sendResponse({ ok: true });
            } catch (e) {
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }
    if (msg && msg.type === "GET_GOOGLE_AUTOFILL") {
        const p = _pendingGoogleLogin;
        if (p && (Date.now() - p.ts) < 180000) {
            sendResponse({ ok: true, email: p.email, password: p.password });
        } else {
            chrome.storage.local.get(["targetGoogleEmail"], (data) => {
                const email = data.targetGoogleEmail || _targetGoogleEmail;
                if (email) {
                    sendResponse({ ok: true, email: email, password: null });
                } else {
                    sendResponse({ ok: false });
                }
            });
        }
        return true; // Keep channel open for async response
    }
    if (msg && msg.type === "GOOGLE_AUTOFILL_DONE") {
        _pendingGoogleLogin = null;
        _targetGoogleEmail = null;
        chrome.storage.local.remove("targetGoogleEmail");
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
