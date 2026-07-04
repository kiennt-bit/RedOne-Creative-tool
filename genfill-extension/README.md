# RedOne Auth Helper — Chrome Extension

Extension làm cầu nối giữa RedOne backend (FastAPI) và Chrome thật của bạn.
**Tất cả call đến Google Labs Flow chạy từ chính tab Chrome của bạn**
(không phải từ Playwright/Cloak headless) → Google không flag bot → 403 cascade giảm về gần 0.

## Kiến trúc

```
┌──────────────────────────┐     HTTP        ┌──────────────────────────────┐
│  RedOne backend          │   port 8000     │  Chrome thật của bạn          │
│  (FastAPI on 127.0.0.1)  │ ◄─────────────► │  + RedOne Auth Helper ext     │
│                          │   XOR-encoded   │  + tab labs.google đã login   │
└──────────────────────────┘                 └──────────────────────────────┘
        │                                              │
        │ enqueue task (recaptcha / proxy_fetch)       │ chrome.scripting.executeScript
        │ await result                                 │ world="MAIN"
        ▼                                              ▼
                                                Google Labs Flow API
                                          (request fire từ chính Chrome user)
```

## Cài đặt

### 1. Chrome → Extensions → Developer Mode

1. Mở `chrome://extensions/` trong Chrome
2. Bật **Developer mode** (góc trên phải)
3. Click **Load unpacked**
4. Chọn thư mục `extension/` này
5. Extension xuất hiện trong danh sách với icon "R" đỏ

### 2. Verify

- Click icon extension trên toolbar → popup hiện:
  - **Backend**: `✓ Đã kết nối` (nếu RedOne backend đang chạy ở 127.0.0.1:8000)
  - **Labs.google tab**: `✓ Đã mở` (sau khi bạn mở https://labs.google/fx/tools/flow)
  - **Đăng nhập Google**: `✓ Đã đăng nhập` (sau khi bạn login Google trong Chrome)

### 3. Trong RedOne web UI

- Settings → **Auth mode** = `Chrome Extension Bridge (Recommended)`
- Save
- Chip xanh `✓ Extension đã kết nối` xuất hiện ngay phía dưới

## Cách hoạt động

### reCAPTCHA harvest

Backend cần token reCAPTCHA cho call Google → enqueue task → extension:
1. Tìm tab labs.google đang mở
2. `chrome.scripting.executeScript({ world: "MAIN", func: ... })` chạy code trong page context
3. Code gọi `grecaptcha.enterprise.execute(sitekey, {action})`
4. Token trả về backend

**Vì sao win**: Token được sinh trong **đúng Chrome user dùng hàng ngày** — Google scoring system thấy "real user browser, real history, real fingerprint" → score cao → API call sau đó pass.

### Proxy fetch

Backend cần call `aisandbox-pa.googleapis.com/v1/...` → enqueue task → extension:
1. `executeScript` chạy `fetch(url, { credentials: "include", method, headers, body })` trong tab labs.google
2. `credentials: "include"` → Chrome tự gắn cookies Google domain
3. Response (JSON / binary base64) trả về backend qua `/sync/task-result`

**Vì sao win**: API call đi ra từ chính browser user — cùng IP, cùng fingerprint, cùng session timeline đã được Google trust nhiều ngày.

## Protocol

| Endpoint | Method | Mục đích |
|---|---|---|
| `/sync/status` | GET | Heartbeat |
| `/sync/next-task?tab_status=...` | GET | Extension pull next task |
| `/sync/task-result` | POST | Extension submit result |
| `/sync/state` | GET | UI diagnostics — extension connected? |

Payload envelope: `{ "d": "<hex>" }` với inner JSON XOR'd byte-by-byte với `0x5A`.
Đây là obfuscation nhẹ, không phải security.

## Troubleshooting

**Extension không kết nối?**
- Đảm bảo backend đang chạy: `python launch.py` (hoặc EXE)
- Mở DevTools cho service worker: `chrome://extensions` → Details → "Service worker" → Inspect
- Check console errors

**Token harvest fail?**
- Mở tab https://labs.google/fx/tools/flow + đăng nhập
- Đợi 5-10s cho grecaptcha load
- Click icon ext → check "Đăng nhập Google: ✓ Đã đăng nhập"

**Generation fail nhưng tab vẫn login?**
- Reload tab labs.google (`Ctrl+R`)
- Check console (F12) trong tab labs.google xem grecaptcha có lỗi gì

## Files

- `manifest.json` — Manifest V3, permissions, content scripts
- `background.js` — Service worker chính (poll backend, harvest token, proxy fetch)
- `content.js` — Inject vào labs.google tab (signal "ready" cho background)
- `popup.html` / `popup.js` — UI status panel khi click icon
- `_locales/{vi,en}/messages.json` — i18n strings
- `icons/icon48.png`, `icons/icon128.png` — Extension icons

## Limitations (v1)

- **Single account effectively**: extension dùng tab labs.google ĐẦU TIÊN tìm thấy. Multi-account cần Chrome multi-profile hoặc tabs khác account → backend mode v2.
- **Cần Chrome đang chạy**: nếu Chrome tắt, extension service worker chết → backend báo "Extension offline".
- **Chỉ Chrome / Edge / Brave**: extension Manifest V3, không support Firefox WebExtensions API trực tiếp.
