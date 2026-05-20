# RedOne Creative — Project Context (Session Handoff)

> **Mục đích file này**: tóm tắt toàn bộ quá trình build tool để có thể mở session AI mới mà không bị mất context. Đọc file này + xem code = hiểu được kiến trúc, các quyết định, và lý do tại sao một số thứ được làm theo cách này.
>
> **Cập nhật lần cuối**: 2026-05-20 · phiên bản hiện tại **v1.0.2**

---

## 1. Bối cảnh dự án

### Nguồn gốc

User có 1 tool tên **RedOne / NAVTools** — desktop app PySide6 (decompiled từ `D:\SAVE\RedOne tool\decompile_tools\NAVTools_source`). Tool gọi Google Labs Flow API qua Playwright + Chrome thật để tạo ảnh/video AI bằng credit miễn phí.

Yêu cầu ban đầu: **làm lại tool bằng web app** (FastAPI + HTML/JS), giữ tính năng cốt lõi nhưng UI hiện đại hơn.

### Workspace location

```
C:\Users\Admin\Downloads\NAVTools_Web\        ← project chính (đang work)
C:\Users\Admin\Downloads\VidGen_Pro\          ← project HTML phiên bản trước (tham khảo)
D:\SAVE\RedOne tool\decompile_tools\NAVTools_source\  ← source RedOne gốc (tham khảo)
```

### Repo GitHub

**https://github.com/kiennt-bit/RedOne-Creative-tool** (private/public tùy user)

User `kiennt-bit`. Git Credential Manager của máy này cache user `chovuithoima9-dev` — phải set URL `https://kiennt-bit@github.com/...` để force prompt creds đúng user khi push lần đầu. Sau lần đầu là cache OK.

---

## 2. Kiến trúc tổng quát

### Mô hình deployment

**Mỗi máy chạy 1 instance riêng** (không có server tập trung):

```
GitHub Releases (download zip)
       ↓
Each user PC:
  RedOne Creative.exe  (PyInstaller --onedir)
    ↓
  FastAPI server (127.0.0.1:8000)
    ↓
  Browser tab opens automatically
       ↓
  User clicks "Login" → Chrome thật bật → Google OAuth
       ↓
  Cookies saved local → calls to labs.google
```

- **Server `127.0.0.1:8000`** = UI control panel local
- **Chrome window thứ 2** = nơi user thực sự đăng nhập Google
- Mỗi máy 1 cookies set riêng (account riêng), không chia sẻ → tránh Google flag

### Tech stack

**Backend**:
- Python 3.10+ (test với 3.14 trên dev machine)
- FastAPI + uvicorn (port 8000)
- WebSocket cho realtime updates (`/ws`)
- Playwright async (điều khiển Chrome thật của hệ thống)
- SQLite (file `data/navtools.db`)
- httpx, google-genai (cho Gemini), yt-dlp (cho YouTube analyzer)

**Frontend**:
- Vanilla JS ES modules (KHÔNG dùng framework, KHÔNG bundler)
- CSS variables cho theme (light/dark toggle)
- Module pattern: 1 page = 1 file trong `frontend/js/pages/`

**Packaging**: PyInstaller `--onedir` → `dist/RedOne Creative/` folder ~150MB

---

## 3. Cấu trúc thư mục

```
NAVTools_Web/
├── backend/
│   ├── __init__.py
│   ├── main.py              ← FastAPI app, lifespan, router includes
│   ├── config.py            ← APP_NAME, paths, model maps, helpers
│   ├── database.py          ← SQLite ORM (Database class)
│   ├── ws_hub.py            ← WebSocket broadcast hub
│   ├── queue_manager.py     ← Sequential task queue (1 task / lúc)
│   ├── routers/             ← FastAPI routers — 1 file per domain
│   │   ├── accounts.py      ← /api/accounts/*
│   │   ├── content.py       ← /api/content/* (T2V + I2V)
│   │   ├── image.py         ← /api/image/* (Nano Banana / Imagen)
│   │   ├── long_video.py    ← /api/long-video/* (multi-scene + ffmpeg concat)
│   │   ├── analyzer.py      ← /api/analyzer/* (YouTube + Script → Prompt)
│   │   ├── media_tools.py   ← /api/media/* (bg remove, watermark, etc)
│   │   ├── tasks.py         ← /api/tasks/* (list, cancel, retry, open-folder)
│   │   ├── files.py         ← /api/files/* (download-zip, move-to-outputs, delete)
│   │   ├── settings.py      ← /api/settings/*
│   │   └── system.py        ← /api/system/* (info, check-update)
│   └── services/
│       ├── flow_client.py   ← Google Labs Flow client (~1600 lines, port từ VidGen_Pro)
│       ├── browser_manager.py  ← Playwright Chrome launch (real Chrome, off-screen)
│       ├── google_auth.py   ← Login flow (legacy, mostly inlined in accounts.py)
│       ├── gemini.py        ← Gemini API wrapper with fallback chain
│       ├── updater.py       ← GitHub releases API check (5min TTL cache)
│       ├── ffmpeg_utils.py  ← FFmpeg wrappers (concat, audio merge, subtitle)
│       └── image_utils.py   ← Pillow resize, fill background
│
├── frontend/
│   ├── index.html           ← Single SPA shell with sidebar + topbar + banners
│   ├── css/
│   │   ├── theme.css        ← Design tokens (light + dark via [data-theme])
│   │   ├── layout.css       ← Sidebar, topbar, page-container
│   │   ├── components.css   ← Buttons, cards, inputs, toasts, banners
│   │   └── pages.css        ← Page-specific (scene-grid, prompt-list, etc)
│   ├── js/
│   │   ├── app.js           ← Router + WS setup + theme + update check
│   │   ├── api.js           ← Fetch wrapper (api.accounts.*, api.content.*, ...)
│   │   ├── ws.js            ← WebSocket with auto-reconnect + event bus
│   │   ├── ui.js            ← Helpers: el(), toast(), modal(), confirm(), icon()
│   │   ├── tasks_store.js   ← Global tasks state (in-memory + localStorage)
│   │   ├── gallery_actions.js ← Multi-select toolbar (download/clear/save)
│   │   └── pages/
│   │       ├── content.js   ← Tạo Video (T2V + I2V tabs)
│   │       ├── image.js     ← Tạo Ảnh
│   │       ├── long_video.js ← Video Dài
│   │       ├── youtube.js   ← YouTube → Prompt analyzer
│   │       ├── script.js    ← Ý Tưởng → Video
│   │       ├── image_prompt.js ← Ảnh → Prompt
│   │       ├── bg_remove.js, watermark.js, upscale.js, batch_resize.js
│   │       ├── audio_merge.js, subtitle.js
│   │       ├── accounts.js  ← Quản lý Google accounts
│   │       ├── settings.js  ← Cài đặt
│   │       └── tasks_manager.js ← Quản lý Task (queue + history)
│   └── assets/
│
├── data/                    ← (gitignore) per-machine: db, cookies, browser profiles, app.log
├── outputs/                 ← (gitignore) generated files (auto-save toggle)
│
├── docs/
│   ├── HUONG_DAN_SU_DUNG.md ← User guide tiếng Việt (10 sections)
│   └── screenshots/         ← Checklist 25 screenshots cho user guide
│
├── launch.py                ← Entry point cho dev + PyInstaller exe
├── RedOne.spec              ← PyInstaller spec
├── build.bat                ← Windows build script
├── run.bat                  ← Dev run script
├── requirements.txt
├── BUILD_RELEASE.md         ← Build + release guide
├── README.md
└── .gitignore
```

---

## 4. Sidebar nav structure (13 trang)

```
SÁNG TẠO
├── Tạo Video          /content.js     T2V + I2V tabs
├── Tạo Ảnh            /image.js       Nano Banana Pro / Imagen 4
└── Video Dài          /long_video.js  Multi-scene + FFmpeg concat

PHÂN TÍCH AI
├── YouTube → Prompt   /youtube.js     Gemini Vision phân tích YouTube/TikTok
├── Ý Tưởng → Video    /script.js      Script → storyboard JSON
└── Ảnh → Prompt       /image_prompt.js  Image-to-text cho Veo

XỬ LÝ ẢNH
├── Tách Nền           /bg_remove.js   rembg (offline)
├── Xóa Logo           /watermark.js   OpenCV inpaint
├── Upscale            /upscale.js     Pillow LANCZOS (Real-ESRGAN optional)
└── Resize Hàng Loạt   /batch_resize.js  Pillow + platform presets

XỬ LÝ VIDEO
├── Ghép Audio         /audio_merge.js  FFmpeg
└── Phụ Đề             /subtitle.js     Whisper offline

HỆ THỐNG
├── Quản lý Task       /tasks_manager.js  Task list + queue + retry
├── Tài Khoản          /accounts.js     Google accounts CRUD
└── Cài Đặt            /settings.js     API keys, auto-save, theme, update check
```

---

## 5. Key architectural decisions

### Sequential queue, không parallel tasks
**Lý do**: User yêu cầu chạy task này xong mới sang task khác. Mỗi task vẫn có thể chạy multiple items parallel (qua `task.concurrent` setting + `asyncio.Semaphore`), nhưng **task-level vẫn FIFO**. Implementation: `backend/queue_manager.py` — single worker loop, `enqueue(kind, task_id, runner)` → `_loop()` lấy 1 item, await runner, sang item kế tiếp.

### Mỗi item dùng cùng 1 Playwright page
Browser manager (`browser_manager.py`) chỉ tạo 1 Playwright Page per account. Multiple parallel items trong cùng task chia sẻ page → `ensure_token` có lock để tránh race; `get_recaptcha_token` cũng có per-account lock.

### Frontend state qua module-level singleton + localStorage backup
Mỗi page module có `const form = {...}` ở module level → state survive khi user chuyển tab và quay lại. `tasks_store.js` cũng singleton, mirror state xuống `localStorage` để survive F5/restart browser.

### State items track theo `item_id` từ backend, không theo position
Bug v1.0.x: dùng heuristic "find next pending" → khi chạy parallel, các items hoàn thành out-of-order làm sai mapping. Fix: backend gửi `item_id` trong mỗi WS event; frontend `findOrClaimSlot(t, itemId)` — lần đầu thấy id mới claim slot trống đầu tiên; lần sau lookup theo id.

### Cache busting cho dev
`backend/main.py` middleware: thêm `Cache-Control: no-store` cho `/static` + chèn `?b=<BUILD_ID>` (random per server start) vào script/CSS URL trong HTML. Browser ALWAYS fetch fresh sau mỗi server restart.

### Date + task_name folder structure
Output: `outputs/<kind>/<YYYY-MM-DD>/<task_name>/file.ext`. Giúp user tìm file dễ. `slugify_folder()` xử lý ký tự cấm trên Windows. Khi `auto_save_outputs=false`, files vào `outputs/_pending/...` (auto-clean sau 24h).

### Frozen mode aware paths
`config.py` phân biệt `IS_FROZEN`:
- **Dev**: `BASE_DIR = project root`, `data/outputs` cũng đó
- **PyInstaller**: `BASE_DIR = sys._MEIPASS` (bundle, read-only), nhưng `USER_DATA_ROOT = Path(sys.executable).parent` → `data/` và `outputs/` lưu **cạnh exe** (persist qua updates)

---

## 6. Major bugs đã fix (theo thứ tự)

| # | Bug | Fix |
|---|---|---|
| 1 | Đăng nhập Google: auto-nav giết OAuth callback | Bỏ auto-nav, chỉ poll cookies `next-auth.session-token` cho domain `labs.google` đến khi stable 2 ticks |
| 2 | HTTP 500 video gen: hardcoded `userPaygateTier: PAYGATE_TIER_TWO` cho free queue | Bỏ field này khi model có suffix `_low_priority` / `_relaxed` |
| 3 | HTTP 500: tên model `veo_3_generate_video_*` đã deprecated | Update sang `veo_3_1_t2v_*` / `veo_3_1_i2v_*` (4 model: lite, fast, quality, lite_lp) |
| 4 | Download fail: `done_state["media_id"]` trả None | Field thật là `name`. Helper `download_to(media_id, path)` dùng `_fetch_mp4_via_browser` (Playwright request, cookies + redirect tự động) |
| 5 | reCAPTCHA 403 PUBLIC_ERROR_UNUSUAL_ACTIVITY | Multi-step mouse simulation + `renew_token()` dùng `page.reload()` (clear risk score) + retry 5 lần |
| 6 | HTTP 429 rate limit | Exponential backoff retry trong `generate_image`/`generate_video` |
| 7 | Gallery status mất khi đổi tab | `tasks_store.js` singleton; render pages restore từ `tasksStore.latestByKind(kind)` |
| 8 | 2-instance bug của tasks_store | Server-side JS rewriter inject `?b=BUILD_ID` vào MỌI import → tất cả module load 1 URL canonical |
| 9 | Parallel items mapping sai status | Dùng `item_id` từ WS, claim slot theo id |
| 10 | "Failed to enqueue generation" (Google queue tạm thời) | Item-level retry 3 lần với backoff; pattern match `failed to enqueue`, `try again`, `transient`, etc. |
| 11 | Session-dead silent fail | `SessionDeadError` exception trong flow_client; routers catch → disable account + broadcast WS → banner đỏ |
| 12 | PyInstaller windowed mode: `sys.stdout is None` crash | Patch stdout/stderr với `_StdStream` ghi vào `console.log` ngay đầu `launch.py`; pass `log_config=None` cho uvicorn |
| 13 | EXE thiếu `python314.dll` trên máy khác | User chưa extract zip / chạy exe ngoài folder. Cần `_internal/` ngang hàng với exe |
| 14 | `videoLengthSeconds` field bị Google reject (HTTP 400) | Duration không phải field — **encoded trong model_key**. Omni Flash key = `abra_t2v_<N>s` |
| 15 | Omni Flash I2V trả 500 | Google chưa support: "Frames for Omni Flash coming soon". Frontend ẩn Omni Flash trong I2V tab; backend fallback sang `lite_lp` |

---

## 7. Backend API endpoints (summary)

```
POST /api/accounts                    Thêm account (email)
GET  /api/accounts                    List
POST /api/accounts/{id}/login         Mở Chrome thật, đăng nhập Google
POST /api/accounts/{id}/check         Verify session + lấy credit
POST /api/accounts/{id}/cookie        Upload cookies JSON thủ công
POST /api/accounts/{id}/toggle        Enable/disable
DELETE /api/accounts/{id}

POST /api/content/start               Bắt đầu task T2V/I2V → enqueue
POST /api/content/cancel/{task_id}

POST /api/image/start                 Bắt đầu task tạo ảnh
POST /api/image/cancel/{task_id}

POST /api/long-video/start            Multi-scene + extend + concat
POST /api/long-video/cancel/{task_id}

GET  /api/tasks                       List tất cả tasks với queue position + progress
POST /api/tasks/{id}/cancel           Cancel (queued hoặc running)
POST /api/tasks/{id}/retry            Re-enqueue (reset ERROR items về PENDING)
POST /api/tasks/{id}/open-folder      Mở File Explorer tại output folder
GET  /api/tasks/_/queue               Snapshot queue

POST /api/files/download-zip          Body: paths[] → trả zip stream
POST /api/files/delete                Xóa file vĩnh viễn
POST /api/files/move-to-outputs       Move from _pending → outputs/

POST /api/analyzer/script             Gemini phân tích kịch bản
POST /api/analyzer/youtube            yt-dlp + Gemini Vision
POST /api/analyzer/image-to-prompt    Gemini Vision

POST /api/media/bg-remove
POST /api/media/watermark-remove
POST /api/media/upscale
POST /api/media/audio-merge
POST /api/media/subtitle
POST /api/media/batch-resize

GET  /api/settings                    Trả về tất cả settings + app info
POST /api/settings                    Update (gemini_api_key, default_aspect, ...)
POST /api/settings/test-gemini        Test API key

GET  /api/system/info                 Frozen flag, paths, GitHub repo URL
GET  /api/system/check-update         GitHub releases API (5min cache)

GET  /api/health
WS   /ws                              Broadcast hub
```

---

## 8. WebSocket events

Server broadcast (qua `hub.broadcast(event, data)`):

| Event | Data | Trigger |
|---|---|---|
| `task_started` | `{task_id}` | Task bắt đầu chạy |
| `task_progress` | `{task_id, done, error, total}` | Sau mỗi item |
| `task_completed` | `{task_id, done, error}` | Task hoàn tất |
| `task_error` | `{task_id, error}` | Task crash |
| `task_cancelled` | `{task_id}` | User hủy hoặc queue cancel |
| `item_status` | `{task_id, item_id, status}` | Item bắt đầu generating |
| `item_completed` | `{task_id, item_id, output_path, kind?}` | Item xong |
| `item_error` | `{task_id, item_id, error}` | Item fail |
| `scene_started` | `{task_id, scene, item_id}` | Long video cảnh bắt đầu |
| `scene_done` / `scene_failed` | Same shape | Long video |
| `account_added` / `account_updated` / `account_deleted` | `{id, ...}` | Account CRUD |
| `account_session_dead` | `{account_id, email, reason}` | Session hết hạn — banner đỏ |
| `queue_updated` | `{current, queued}` | Queue state changed |

Frontend `tasks_store.js` lắng nghe các events và update state Map → notify subscribers → page re-render.

---

## 9. Database schema (SQLite)

```sql
accounts:
  id, email, enabled, credit, tier, cookie_path, cookie_exp, token_exp, proxy, created_at

projects:
  id, name, folder_path, created_at

tasks:
  id, project_id, name, mode, quality, image_model, aspect_ratio, resolution,
  duration, concurrent, output_folder, total_count, done_count, error_count,
  character_images_json, status, created_at, started_at, finished_at

task_items:
  id, task_id, prompt, status, output_path, credit_cost, error_message,
  extra_json, created_at, completed_at

settings:
  key, value     ← JSON-encoded
```

Migration idempotent: `_add_column_if_missing("tasks", "duration", "INTEGER DEFAULT 8")` chạy mỗi lần boot — DB cũ tự nâng cấp.

---

## 10. Model keys mapping (`config.py`)

```python
T2V_MODEL_MAP = {
  "lite":    "veo_3_1_t2v_lite",
  "fast":    "veo_3_1_t2v_fast_ultra",
  "quality": "veo_3_1_t2v",
  "lite_lp": "veo_3_1_t2v_lite_low_priority",
}

I2V_MODEL_MAP = {
  "lite":    "veo_3_1_i2v_lite",
  "fast":    "veo_3_1_i2v_s_fast_ultra",
  "quality": "veo_3_1_i2v_s",
  "lite_lp": "veo_3_1_i2v_lite_low_priority",
}

# Omni Flash: duration ENCODED IN KEY → built dynamically
# video_model_for('omni_flash', 't2v', 10) → 'abra_t2v_10s'
# Pattern confirmed via labs.google DevTools network capture.
# I2V chưa hỗ trợ trên Google → frontend ẩn, backend fallback lite_lp

EXTEND_MODEL_MAP = {                          # Cho video dài (extend chain)
  "lite":    "veo_3_1_extension_lite",
  "fast":    "veo_3_1_extension_fast_ultra",
  "quality": "veo_3_1_extension_t2v",
  "lite_lp": "veo_3_1_extension_lite_low_priority",
}

VIDEO_DURATIONS_BY_MODEL = {
  "omni_flash": [4, 6, 8, 10],     # only Omni Flash supports duration variants
  "lite": [8], "fast": [8], "quality": [8], "lite_lp": [8],  # Veo fixed 8s
}
```

Tỉ lệ video: chỉ `16:9` và `9:16` (Google không hỗ trợ khác cho Veo). Image gen full 5 tỉ lệ (1:1, 16:9, 9:16, 4:3, 3:4).

---

## 11. Quan trọng: flow_client.py

**File này ~1600 lines, port từ VidGen_Pro/NAV Tools, RẤT NHẠY CẢM. Đừng refactor lớn nếu chưa hiểu kỹ.**

Các method quan trọng:
- `ensure_token()` — Lock-protected, lấy `ya29.*` từ `/fx/api/auth/session`. Raise `SessionDeadError` nếu 404.
- `_browser_sandbox_request(endpoint, payload, is_text_plain=True)` — Core: gọi qua `page.evaluate(fetch())` để inherit cookies + bypass CORS. Auto-retry 401/403 với token renewal. Raise SessionDeadError sau MAX_RETRY_COUNT.
- `renew_token()` — `page.reload()` để clear reCAPTCHA risk score, KHÔNG `goto()` (Google đánh giá khác).
- `get_recaptcha_token(action)` — Per-account lock. Mouse jitter (3-6 moves + click + scroll). Wait for grecaptcha loaded.
- `generate_video(prompt, model_key, aspect_ratio, reference_image, duration)` — Build payload đúng endpoint (`*VideoText` vs `*StartImage`). Free queue KHÔNG gửi `userPaygateTier`. Retry 5 lần với backoff. Detect 429 → exponential backoff.
- `generate_image(prompt, model_key, aspect_ratio, reference_images, seed)` — Synchronous (không poll). Retry 5 lần.
- `wait_for_completion(workflow_id)` — Poll mỗi 5s, ưu tiên `mediaMetadata.mediaStatus.mediaGenerationStatus`, fallback `state`/`status`. Handle "Media not found" transient cho LP queue.
- `download_to(media_id, output_path)` — Method canonical. Thử `_fetch_mp4_via_browser` (Playwright) trước, fallback `get_download_url` + httpx.
- `extend_video(prompt, media_id, workflow_id, model_key, aspect_ratio, duration)` — Cho long video.

### Mặc định queue + reCAPTCHA defenses
- `_RECAPTCHA_LOCKS: dict[str, asyncio.Lock]` per account_email
- `_PROJECT_IDS: dict[str, str]` class-level — projectId STABLE per account, tránh "Media not found"

---

## 12. Tính năng đặc biệt

### Multi-image I2V với drag-to-reorder
`content.js`: form.refs[] array song song với form.prompts[]. Index `i` của refs ghép với prompts[i]. UI dùng HTML5 drag-and-drop để reorder. Smart bulk paste: nhập nhiều prompts cách nhau dòng trắng → tự split theo `\n\s*\n+` regex.

### Tasks store với localStorage backup
`tasks_store.js`: `tasks.Map<task_id, state>` + `subscribers.Map`. Persist sau mỗi notify. Restore on boot. Page module mount: `tasksStore.latestByKind('image').then(attachToTask)`.

### Selection toolbar
`gallery_actions.js`: `makeSelectionToolbar({ getCards, pathOf, onChange, onClearSelected })` + `attachCardCheckbox(card, path, toolbar)`. Buttons (Tải về đã chọn / Lưu vào outputs / Bỏ khỏi danh sách) chỉ hiện khi >= 1 card được tick.

### Update banner
`app.js init()`: gọi `api.system.checkUpdate()` (cached 5min server-side). Nếu `update_available` → render banner gradient đỏ-cam ở top, click "Tải bản mới" → mở link `release_url` / `download_url`. localStorage `redone_dismissed_update` ghi nhớ version user đã dismiss.

### Session-dead banner
WS event `account_session_dead` → banner đỏ full-width. Button "Mở tab Tài Khoản" → navigate. User Login lại → cookies refresh → manual toggle account ON lại.

---

## 13. Deployment workflow

### Build EXE
```cmd
cd C:\Users\Admin\Downloads\NAVTools_Web
build.bat
```
Output: `dist/RedOne Creative/` (~150MB) chứa `RedOne Creative.exe` + `_internal/`.

**Quan trọng**: user MUST extract zip đầy đủ, KHÔNG kéo .exe ra khỏi folder (sẽ thiếu `_internal/python314.dll`).

### Release lên GitHub
1. Bump `APP_VERSION` trong `backend/config.py`
2. Commit + push
3. Build: `build.bat`
4. Zip folder `dist/RedOne Creative/` → tên `RedOne-Creative-vX.X.X-win64.zip`
5. https://github.com/kiennt-bit/RedOne-Creative-tool/releases/new
6. Tag `vX.X.X`, attach zip, publish
7. Trong 5min (cache TTL), các máy user đang chạy version cũ thấy banner update

---

## 14. Known limitations / TODO

### Còn TODO

- **Veo 3.1 chỉ 8s**: Chưa biết format key cho Veo 4s/6s. Cần capture payload thêm.
- **Omni Flash I2V**: Google chưa hỗ trợ. Khi ra mắt → unhide Omni Flash trong dropdown I2V + fix key cho I2V variant.
- **Multi-account rotation**: Account picker hiện chỉ lấy account có credit cao nhất. Chưa rotate tự động giữa nhiều accounts.
- **YouTube/Script analyzer**: Endpoint có, page UI có, nhưng chưa test e2e đầy đủ.
- **Image-to-prompt**: Có endpoint, có page; cần Gemini API key trong Settings.
- **TTS Vietnamese voice**: Chưa implement (đã đề cập trong RedOne gốc, không port vì cần model offline lớn).
- **GitHub Actions auto-build**: Có template trong `BUILD_RELEASE.md`, chưa setup file `.github/workflows/release.yml`.
- **Screenshots cho user guide**: 25 placeholder trong `docs/screenshots/README.md`, chưa chụp.

### Known limitations

- **Per-machine cookies only**: Không share cookies giữa máy → mỗi user phải login riêng. Intentional để tránh Google flag.
- **Single browser context per account**: Multiple parallel items trong cùng task chia sẻ Playwright Page → `page.evaluate` calls serialize natural. Thực sự parallel chỉ ở phase polling.
- **Optional AI deps không bundle**: rembg, whisper, OpenCV, spandrel, torch — user phải `pip install` thêm nếu muốn dùng (tool báo lỗi rõ).
- **Windows only**: Playwright vẫn cross-platform được nhưng `os.startfile()` (mở folder), `_StdStream` (windowed mode), `find_chrome()` (Windows registry) chỉ test trên Win 10/11.

---

## 15. Version history

| Version | Tóm tắt |
|---|---|
| v1.0.0 | Initial release: 13 pages, sequential queue, multi-account, basic Veo 3.1 + Nano Banana |
| v1.0.1 | Fix PyInstaller windowed mode crash (`sys.stdout is None`) — patch stdout to file |
| v1.0.2 (current) | Omni Flash model (T2V only, 4/6/8/10s) với pattern `abra_t2v_<N>s`. Ẩn Omni Flash trong I2V vì Google chưa hỗ trợ. Session-dead handling + retry button + banner đỏ. ConnectionReset noise silenced. Auto-save toggle + date-based folders. Multi-select gallery với zip download. Tasks Manager tab. |

Trước v1.0.2 từng có v1.0.3 (hotfix `videoLengthSeconds`) + v1.0.4 (abra pattern) trên git history nhưng user yêu cầu version đẩy là v1.0.2.

---

## 16. Commands cheatsheet

```bash
# Run dev mode (cần Python 3.10+ + deps)
cd C:\Users\Admin\Downloads\NAVTools_Web
python -m backend.main          # OR python launch.py

# Build EXE (cần pyinstaller)
build.bat

# Kill server
taskkill /F /IM python.exe

# Test endpoints
curl http://127.0.0.1:8000/api/health
curl http://127.0.0.1:8000/api/system/info
curl http://127.0.0.1:8000/api/tasks?limit=5

# Inspect DB
python -c "from backend.database import db; print(db.all_settings())"

# Git
git status
git add . && git commit -m "..." && git push
git log --oneline -10
```

---

## 17. Conventions & code style

- **Tiếng Việt cho UI text + commit messages**, English cho code comments + identifiers
- **Imports relative** (`from ..config import ...`) trong backend (vì PyInstaller cần consistent module loading)
- **JS ES modules** thuần, KHÔNG dùng bundler. Imports relative (`from '../ui.js'`)
- **CSS variables** thay vì hardcode color. Dark mode override qua `[data-theme="dark"]`
- **Toast levels**: `success` (xanh), `error` (đỏ), `warning` (vàng), `info` (xanh blue)
- **No emojis** trong commit messages / code (chỉ trong UI text + docs)
- **Per-page module pattern**: `export function renderXxx(root)` — render vào DOM root, attach event listeners, cleanup qua MutationObserver

---

## 18. Khi cần debug

1. **Server logs**: `data/app.log` (tail 100 lines)
2. **Frontend console**: F12 → Console. Search `[tasks_store]` cho task state, `[ws]` cho WebSocket, `[RedOne]` cho build banner
3. **Network**: F12 → Network → filter `/api/` hoặc `batchAsync` (Google API calls)
4. **Frozen-mode debug**: `data/console.log` cạnh exe (PyInstaller windowed redirects ở đây)
5. **DB**: SQLite browser hoặc `python -c "from backend.database import db; ..."`

### Khi gặp HTTP error từ Google API

- **400** "Unknown name X": payload field sai → check labs.google network capture
- **401** persistent: session dead → user login lại
- **403** PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA → tool auto reload + retry
- **429** RESOURCE_EXHAUSTED: rate limit → exponential backoff (auto)
- **500** INTERNAL: thường do payload sai (extra field như `userPaygateTier` cho free queue) HOẶC tên model sai → check Google Labs UI để xem key đúng

---

## 19. Phương pháp capture Google API cho debug

Khi cần verify field name / model key:

1. https://labs.google/fx/tools/video-fx → F12 → Network tab
2. Filter: `batchAsync` (lọc đúng API call)
3. Tick ☑ **Preserve log**
4. Trong UI Flow, chọn model + duration mong muốn, bấm Generate
5. Find request:
   - `video:batchAsyncGenerateVideoText` (T2V)
   - `video:batchAsyncGenerateVideoStartImage` (I2V)
   - `video:batchAsyncGenerateVideoExtendVideo` (extend)
6. Tab **Payload** → expand `requests[0]` để thấy đầy đủ fields
7. Hoặc click **View source** để có JSON raw, copy nguyên

Đối chiếu với code trong `flow_client.py` line ~819 (generate_video) hoặc ~861 (extend_video).

---

## 20. Liên hệ nhanh trong session mới

Khi bạn (hoặc Claude trong session mới) bắt đầu, đọc xong file này nên:

1. Check git status + last commits để biết tình trạng repo
2. Đọc `backend/config.py` để hiểu constants
3. Đọc 1-2 file router (vd `content.py`) để hiểu pattern: enqueue + runner pattern
4. Đọc `frontend/js/pages/content.js` để hiểu cách 1 page module được tổ chức
5. Đọc section 11 (flow_client) trên đây để biết các method core

Sau đó user nói task gì → bắt đầu work, KHÔNG cần hỏi lại context cơ bản.

---

**END OF CONTEXT** — file này nên được update khi có thay đổi lớn về kiến trúc hoặc version bump.
