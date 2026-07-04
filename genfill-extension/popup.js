// Popup UI — shows live status of bridge connection + both providers
// (Google Labs / Shakker.ai). Refreshes every 1s while popup is open.

function setStatus(elId, cls, label) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.className = "value " + cls;
    el.innerHTML = `<span class="dot"></span>${label}`;
}

function formatAgo(ts) {
    if (!ts) return "—";
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5) return "vừa xong";
    if (diff < 60) return `${diff}s trước`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m trước`;
    return `${Math.floor(diff / 3600)}h trước`;
}

async function refresh() {
    chrome.runtime.sendMessage({ type: "GET_METRICS" }, (r) => {
        if (chrome.runtime.lastError || !r) {
            setStatus("status-bridge", "err", "Service worker chết");
            return;
        }
        // Backend bridge
        setStatus("status-bridge", r.connected ? "ok" : "err",
            r.connected ? "Đã kết nối" : "Mất kết nối — backend chưa chạy?");

        // ── Google Labs ─────────────────────────────────────
        setStatus("status-tab", r.hasTab ? "ok" : "warn",
            r.hasTab ? "Đã mở" : "Chưa mở labs.google");
        setStatus("status-login", r.signedIn ? "ok" : "warn",
            r.signedIn ? "Đã đăng nhập" : "Chưa đăng nhập Google");
        document.getElementById("token-count").textContent = r.tokenCount || 0;
        document.getElementById("last-success").textContent = formatAgo(r.lastSuccessAt);

        // ── Shakker.ai ──────────────────────────────────────
        const sk = r.shakker || {};
        setStatus("status-shakker-tab", sk.hasTab ? "ok" : "warn",
            sk.hasTab ? "Đã mở" : "Chưa mở shakker.ai");

        // Account email — green when we have a recent sync (< 10 min),
        // grey otherwise. "Chưa đồng bộ" if we've never synced.
        const emailEl = document.getElementById("shakker-email");
        if (sk.email) {
            const fresh = sk.lastSync && (Date.now() - sk.lastSync < 10 * 60 * 1000);
            emailEl.textContent = sk.email;
            emailEl.style.color = fresh ? "#4ade80" : "#cbd5e1";
        } else {
            emailEl.textContent = "Chưa đồng bộ";
            emailEl.style.color = "#64748b";
        }
        document.getElementById("shakker-last-sync").textContent = formatAgo(sk.lastSync);
    });
}

document.getElementById("open-labs").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://labs.google/fx/tools/flow" });
});

document.getElementById("open-shakker").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.shakker.ai/aigenerator" });
});

document.getElementById("reset-metrics").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "RESET_METRICS" }, refresh);
});

const _lsBtn = document.getElementById("login-shared");
if (_lsBtn) _lsBtn.addEventListener("click", () => {
    const msgEl = document.getElementById("login-shared-msg");
    if (msgEl) msgEl.textContent = "Đang lấy tài khoản chung…";
    _lsBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "LOGIN_SHARED_GOOGLE" }, (r) => {
        _lsBtn.disabled = false;
        if (chrome.runtime.lastError || !r || !r.ok) {
            if (msgEl) msgEl.textContent = "Lỗi: " + ((r && r.error) || "không lấy được tài khoản chung");
            return;
        }
        if (msgEl) msgEl.textContent = "Đã mở trang đăng nhập — đang tự điền…";
    });
});

refresh();
setInterval(refresh, 1000);
