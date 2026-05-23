// Popup UI — shows live status of bridge connection, labs tab, login,
// and harvested token count. Refreshes every 1s while popup is open.

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
        setStatus("status-bridge", r.connected ? "ok" : "err",
            r.connected ? "Đã kết nối" : "Mất kết nối — backend chưa chạy?");
        setStatus("status-tab", r.hasTab ? "ok" : "warn",
            r.hasTab ? "Đã mở" : "Chưa mở labs.google");
        setStatus("status-login", r.signedIn ? "ok" : "warn",
            r.signedIn ? "Đã đăng nhập" : "Chưa đăng nhập Google");
        document.getElementById("token-count").textContent = r.tokenCount || 0;
        document.getElementById("last-success").textContent = formatAgo(r.lastSuccessAt);
    });
}

document.getElementById("open-labs").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://labs.google/fx/tools/flow" });
});

document.getElementById("reset-metrics").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "RESET_METRICS" }, refresh);
});

refresh();
setInterval(refresh, 1000);
