# RedOne Creative — Session Handoff (snapshot 2026-05-22)

> **Mục đích file này**: Mở trong session Claude mới để continue build mà không miss context. Đọc từ đầu xuống cuối; mỗi section tóm tắt 1 mảng. Khi cần chi tiết code → đi tới file path nêu rõ.
>
> **Phiên bản hiện tại**: `v1.0.6` (commit `aadf723`). EXE chưa build/release lên GitHub Releases — code đã push.

---

## 1. Tool là gì

**RedOne Creative** — tool web local (FastAPI + vanilla JS) tạo video / ảnh AI qua Google Labs Flow (Veo 3.1 + Nano Banana / Imagen). Người dùng tự đăng nhập Google account, tool điều khiển Chrome qua Playwright + CDP để gọi API miễn phí.

**Kế thừa từ tool PySide6 cũ** (`D:\SAVE\RedOne tool`) — rebuild để chạy trong browser, dùng FastAPI làm server local.

### Stack
- **Backend**: FastAPI + uvicorn (port 8000), Playwright async, SQLite, WebSocket hub
- **Frontend**: Vanilla JS ES modules (KHÔNG bundler), CSS variables, single-page app routing
- **Browser**: Real Chrome (system) hoặc CloakBrowser stealth (optional, switch trong Settings)
- **AI deps**: `google-genai` (Gemini), `cloakbrowser` (stealth), `opencv-python` (bundled cho watermark), `simple-lama-inpainting` + `torch` (optional, install via wizard)
- **Distribution**: PyInstaller `--onedir` → EXE bundle ~700MB

### Repo
- **GitHub**: https://github.com/kiennt-bit/RedOne-Creative-tool
- **Working dir**: `D:\RedOne Creative tool` (Windows, dev environment)
- **Branch**: `main` only
- **User**: kiennt-bit (email: chovuithoima9@gmail.com)

---

## 2. Quy tắc cho assistant (BẮT BUỘC tuân thủ)

User đã set các constraints rõ ràng trong các session trước. Phải nhớ:

1. **KHÔNG push vội**: chỉ commit + push khi user nói "OK push" (hoặc tương đương). Mỗi lần user sửa request, t sửa code nhưng **chờ** explicit OK trước khi git push.
2. **Mask sensitive fields khi capture network**: với Google API payloads, ẩn `sessionId`, `recaptchaContext.token`, `batchId` — không log/echo lên UI.
3. **Sub-process Windows**: mọi `asyncio.create_subprocess_exec` phải dùng `subprocess_no_window_kwargs()` từ `ffmpeg_utils.py` để tránh CMD flash trên windowed EXE.
4. **Python 3.12**: Setup wizard pin Python 3.12.7. KHÔNG dùng 3.13/3.14 (torch wheel compat issues).

---

## 3. Workspace layout

```
RedOne Creative tool/
├── backend/
│   ├── config.py            ← APP_VERSION, IS_FROZEN, paths, model keys
│   ├── database.py          ← SQLite wrapper (accounts, tasks, task_items, settings)
│   ├── main.py              ← FastAPI app + WS endpoint + SPA fallback
│   ├── queue_manager.py     ← Sequential task queue + cancel-aware worker
│   ├── ws_hub.py            ← WebSocket broadcast hub
│   ├── routers/
│   │   ├── accounts.py      ← /api/accounts + login flows (Chrome + Cloak)
│   │   ├── content.py       ← /api/content/start (T2V/I2V) + retry circuit breaker
│   │   ├── image.py         ← /api/image/start + /upscale + circuit breaker
│   │   ├── long_video.py    ← /api/long-video/start (multi-scene concat)
│   │   ├── analyzer.py      ← Script/YouTube/Image-to-Prompt via Gemini
│   │   ├── media_tools.py   ← bg-remove, watermark, upscale, audio-merge, subtitle, batch-resize, video-watermark-remove
│   │   ├── files.py         ← download-zip, delete, move-to-outputs, open-folder
│   │   ├── settings.py      ← /api/settings + test-gemini + cloak-status + logs
│   │   ├── system.py        ← /info, /check-update, /update-state, /start-update, /apply-update, /shutdown, /lama-install, /setup-status, /setup-run
│   │   └── tasks.py         ← /api/tasks list + cancel + retry + open-folder
│   ├── services/
│   │   ├── flow_client.py   ← ~1700 LOC — Google Flow API client. ensure_token, generate_video/image, upscale_image, check_credits, download_to. RECAPTCHA token harvest.
│   │   ├── browser_manager.py ← Chrome dispatcher (chrome / cloak based on setting)
│   │   ├── cloak_backend.py ← CloakBrowserManager mirror
│   │   ├── google_auth.py   ← Login subprocess flow (Chrome CDP)
│   │   ├── gemini.py        ← google-genai wrapper with model fallback chain
│   │   ├── ffmpeg_utils.py  ← ffmpeg detection + subprocess_no_window_kwargs() helper
│   │   ├── image_utils.py   ← PIL helpers + resize presets
│   │   ├── lama_inpaint.py  ← Inpainting subprocess script (CLI + in-process callable)
│   │   ├── watermark_video.py ← Video watermark removal orchestrator (ffmpeg + lama_inpaint)
│   │   ├── lama_installer.py ← LaMa upgrade wizard pipeline (pip install + model download)
│   │   ├── setup_wizard.py  ← First-run wizard orchestrator (Python + deps + model)
│   │   ├── circuit_breaker.py ← Per-task 403 cascade detector
│   │   └── updater.py       ← Auto-updater (download + extract + Windows install batch)
│   └── resources/
│       └── veo3watermark.png ← Default mask cho Veo logo
├── frontend/
│   ├── index.html           ← App shell: sidebar + topbar + modal root
│   ├── css/
│   │   ├── theme.css        ← CSS variables (light + dark mode)
│   │   ├── layout.css       ← Sidebar + topbar + responsive media queries
│   │   ├── components.css   ← Cards, buttons, chips, dropzone, etc.
│   │   └── pages.css        ← Page-specific styles
│   └── js/
│       ├── app.js           ← Router + init + setupTheme/Shutdown/WS + update banner + setup wizard call
│       ├── api.js           ← Fetch wrapper + all endpoint definitions
│       ├── ui.js            ← el() helper, toast(), confirm(), modal()
│       ├── ws.js            ← WebSocket client + event dispatcher
│       ├── tasks_store.js   ← Global tasks state (Map + localStorage backup)
│       ├── gallery_actions.js ← makeSelectionToolbar + makeRetryFailedButton
│       ├── setup_wizard.js  ← Fullscreen first-run wizard modal
│       └── pages/
│           ├── content.js   ← Tạo Video T2V/I2V (forms + WS-driven gallery)
│           ├── image.js     ← Tạo Ảnh
│           ├── long_video.js ← Video Dài
│           ├── youtube.js, script.js, image_prompt.js
│           ├── bg_remove.js, watermark.js, upscale.js, batch_resize.js
│           ├── audio_merge.js, subtitle.js
│           ├── video_watermark.js ← Xóa Watermark Video (new dedicated page)
│           ├── accounts.js
│           ├── settings.js
│           └── tasks_manager.js
├── data/                    ← User data (persists across updates)
│   ├── navtools.db          ← SQLite
│   ├── cookies/<id>_cookies.json
│   ├── browser_profiles/
│   │   ├── login_<id>/      ← Chrome login persistent profile
│   │   └── cloak/<id>/      ← CloakBrowser persistent profile
│   ├── updates/             ← Auto-updater staging dir
│   ├── setup-state.json     ← First-run wizard completion marker
│   └── app.log
├── outputs/                 ← Generated files (persists across updates)
│   ├── video/<YYYY-MM-DD>/<task>/item_*.mp4
│   ├── video/watermark_removed/<YYYY-MM-DD>/<name> [RedOne].mp4
│   ├── image/<YYYY-MM-DD>/<task>/item_*.png
│   ├── image/<YYYY-MM-DD>/<task>/upscaled/item_*_<2k|4k>.jpg
│   └── _pending/...         ← Temp output (24h cleanup)
├── docs/
│   ├── HUONG_DAN_SU_DUNG.md (user guide, ~430 lines, có placeholders cho 25 screenshots)
│   └── screenshots/01-11_*.png (đã chụp 10 ảnh)
├── RedOne.spec              ← PyInstaller config
├── launch.py                ← Frozen EXE entry (auto-open browser)
├── requirements.txt
├── BUILD_RELEASE.md         ← Build + GitHub release workflow doc
├── PROJECT_CONTEXT.md       ← Earlier handoff doc (~566 lines, may be slightly outdated)
└── SESSION_HANDOFF.md       ← THIS FILE (most recent snapshot)
```

---

## 4. Path & frozen mode

`backend/config.py`:
- `IS_FROZEN = getattr(sys, "frozen", False)`
- **Frozen** (EXE mode):
  - `BUNDLE_DIR = sys._MEIPASS` (PyInstaller extract dir) — for static assets
  - `EXE_DIR = Path(sys.executable).parent` — for user data
  - `USER_DATA_ROOT = EXE_DIR` → `data/`, `outputs/` lưu CẠNH exe
- **Dev**:
  - `BASE_DIR = repo root` → mọi thứ trong project dir

User data (`data/`, `outputs/`) **NEVER** bị touch trong auto-update — chỉ `.exe` + `_internal/` được swap.

---

## 5. Version history

| Tag | Highlights |
|---|---|
| v1.0.0 | Initial release: T2V/I2V, image gen, long video, accounts, basic UI |
| v1.0.1 | Session-dead handling + retry + UI banner; PyInstaller windowed crash fix |
| v1.0.2 | Omni Flash model + duration selector; hide Omni Flash for I2V |
| v1.0.3 | Image upscale 2K/4K via Google Flow upsampleImage API + CloakBrowser optional backend |
| **v1.0.4** | Retry buttons + Xóa Watermark Video (LaMa + OpenCV) + in-app auto-updater + SPA 404 fix |
| **v1.0.5** | Hybrid LaMa install (OpenCV bundled, LaMa via wizard) + UX polish: credit fix (subscriptionCredits / "Tín dụng Flow"), topbar redesign (theme + shutdown), watermark image draw fix |
| **v1.0.6** | **First-run setup wizard** auto-install Python + deps + model + sidebar responsive + circuit breaker for 403 cascade |

### Latest commits (newest first)
```
aadf723 fix(circuit-breaker): catch 403 side-effects + no reset on misc failures
217a544 fix: retry preserves completed items + cooldown hint clarified
511bfcb fix: 403 cascade circuit breaker + always-visible retry button
5e42904 fix(layout): sidebar visible scrollbar + auto-compact on short displays
9fda4c4 fix(wizard): reject Microsoft Store Python alias stubs
cb4fffb v1.0.6: first-run setup wizard — auto-install Python + deps + model
94059c4 fix(windows): kill the CMD flash from lama_status — belt-and-suspenders
2440e0c v1.0.5: hybrid LaMa install + UX polish
4e79712 docs: add 10 user guide screenshots
bef98e8 v1.0.4: retry buttons, video watermark removal, in-app auto-updater
```

---

## 6. Frontend pages & sidebar layout

```
Sáng tạo:
  - Tạo Video (T2V + I2V tabs)         /#content
  - Tạo Ảnh                             /#image
  - Video Dài (N scenes)                /#long-video
Phân tích AI:
  - YouTube → Prompt                    /#youtube
  - Ý tưởng → Video (script)            /#script
  - Ảnh → Prompt                        /#image-prompt
Xử lý ảnh:
  - Tách Nền                            /#bg-remove
  - Xóa Logo Ảnh (rect draw + OpenCV)  /#watermark
  - Upscale (PIL LANCZOS)               /#upscale
  - Resize Hàng Loạt                    /#batch-resize
Xử lý video:
  - Xóa Watermark Video                 /#video-watermark   (NEW v1.0.4)
  - Ghép Audio                          /#audio-merge
  - Phụ Đề                              /#subtitle
Hệ thống:
  - Quản lý Task                        /#tasks
  - Tài Khoản                           /#accounts
  - Cài Đặt                             /#settings
```

**Topbar (góc trên phải)**:
- Chip Accounts count
- Chip "Tín dụng Flow" total (sum subscriptionCredits từ tất cả accounts)
- Theme toggle icon (☀️/🌙)
- Shutdown icon (⏻, đỏ khi hover)

---

## 7. Database schema (`backend/database.py`)

```sql
accounts (
  id, email, enabled, cookie_path, cookie_exp, credit, tier,
  last_login, last_check, created_at
)
tasks (
  id, name, mode, image_model, quality, aspect_ratio, duration,
  concurrent, output_folder, total_count, done_count, error_count,
  character_images_json, status, created_at, started_at, finished_at
)
task_items (
  id, task_id, prompt, status, output_path, credit_cost,
  error_message, extra_json, created_at, completed_at
)
settings (key, value)
```

`extra_json` lưu per-item metadata: `reference_images`, `media_id` (cho upscale), etc.

Settings keys quan trọng:
- `gemini_api_key`, `default_aspect`, `default_quality`, `auto_save_outputs`
- `browser_backend` ("chrome" | "cloak")
- `output_folder` (custom)

---

## 8. WebSocket events (frontend ↔ backend)

`backend/ws_hub.py` broadcasts; `frontend/js/tasks_store.js` + page modules subscribe.

| Event | Payload | Purpose |
|---|---|---|
| `task_started` | `{task_id, kind, retried?}` | Backend bắt đầu xử lý |
| `task_progress` | `{task_id, done, error, total}` | Update progress |
| `task_completed` | `{task_id, done, error, kind?}` | Task xong |
| `task_error` | `{task_id, error}` | Task crash |
| `task_cancelled` | `{task_id}` | User cancel |
| `task_circuit_tripped` | `{task_id, threshold, message}` | **NEW v1.0.6** — 403 circuit pause |
| `item_status` | `{task_id, item_id, status}` | Per-item PENDING/GENERATING/... |
| `item_completed` | `{task_id, item_id, output_path, kind?, media_id?, width?, height?}` | Per-item done |
| `item_error` | `{task_id, item_id, error}` | Per-item error |
| `scene_started/done/failed` | `{task_id, scene, output_path?}` | Long video per-scene |
| `account_updated` | `{id, credit, alive, credit_fetch_ok, credit_fetch_error}` | Account state changed |
| `account_session_dead` | `{account_id, email, reason}` | Session expired |
| `queue_updated` | `{...queue snapshot}` | Queue state changed |
| `upscale_started/_completed/_error` | `{item_id, resolution, ...}` | 2K/4K batch progress |
| `watermark_started/_progress/_completed/_error` | `{job_id, source, status, percent, path?}` | Video watermark batch |
| `update_progress` | `{stage, percent, downloaded, total, message}` | Auto-updater |
| `lama_install_progress` | `{stage, label, percent, pip_log_tail, error}` | LaMa upgrade wizard |
| `setup_progress` | `{stage, current_step, step_label, percent, log_tail, error}` | First-run wizard |
| `server_shutting_down` | `{}` | Tool tắt qua nút Shutdown |

---

## 9. Google Flow API quirks (capture từ user trong các session trước)

**Endpoint base**: `https://aisandbox-pa.googleapis.com/v1/`

### Video generation
- `POST flow/batchAsyncGenerateVideo` (T2V) hoặc `video:batchAsyncGenerateVideoStartImage` (I2V)
- Bearer token (NextAuth session) trong Authorization header
- `clientContext.tool = "PINHOLE"`, `userPaygateTier` **must be omitted** for free queue (Lite [LP])
- `videoLengthSeconds` field bị reject — duration encode trong `model_key` cho Omni Flash (`abra_t2v_<N>s`)
- Veo 3.1 always renders 8s; static keys `veo_3_1_t2v_lite`, `veo_3_1_t2v`, etc.

### I2V via Omni Flash
- **Không support** — Google chưa public. Fallback to Veo 3.1 Lite [LP] in code.

### Image generation
- `POST projects/{projectId}/flowMedia:batchGenerateImages`
- Synchronous — response chứa `fifeUrl` ngay

### Image upscale
- `POST flow/upsampleImage`
- Body: `{mediaId, targetResolution: "UPSAMPLE_IMAGE_RESOLUTION_4K", clientContext: {... userPaygateTier: PAYGATE_TIER_TWO}}`
- Synchronous — trả `{encodedImage: "<base64 JPEG>"}`

### Credit check
- `GET https://aisandbox-pa.googleapis.com/v1/credits` với Bearer
- Response: `{credits: 35871, subscriptionCredits: 10871, topUpCredits: 25000, ...}`
- **Dùng `subscriptionCredits`** ("Tín dụng Flow") — khớp con số popup Google hiển thị, không phải `credits` (total)
- Method 2/3 fallback: parse "Tín dụng Flow" text from page DOM

### reCAPTCHA token harvest
- `grecaptcha.execute(siteKey, {action: "VIDEO_GENERATION"})` từ trong page context
- Per-account lock + mouse jitter trước khi harvest

### Download video
- `_fetch_mp4_via_browser` (browser fetch) → `get_download_url` (tRPC) → fallback
- Sometimes 429s — needs retry with backoff (currently retries 3x)

---

## 10. Critical feature: First-Run Setup Wizard (v1.0.6)

`backend/services/setup_wizard.py` + `backend/routers/system.py` + `frontend/js/setup_wizard.js`.

### Flow
1. EXE chạy lần đầu → `app.js init()` await `maybeRunSetupWizard()`
2. Fetch `/api/system/setup-status` → backend probe MSVC/Python/torch/cv2/model/CUDA
3. If `setup_complete_for_current_version=true` AND `all_ready=true` → skip
4. Otherwise → render fullscreen modal (no skip button)
5. User click "Cài đặt tự động" → POST `/setup-run` → background pipeline:
   - **MSVC redist**: detect only (registry check), show download link if missing
   - **Python 3.12.7**: auto-download installer (~30MB) from python.org → silent install per-user (`/quiet PrependPath=1 InstallAllUsers=0`, no UAC)
   - **pip install**: opencv-python + simple-lama-inpainting + torch (CUDA wheel if `nvidia-smi` present, else CPU)
   - **big-lama.pt**: stream-download ~204MB to `~/.cache/torch/hub/checkpoints/`
6. Pipeline writes `data/setup-state.json` with `completed_for_version: "1.0.6"` + `python_path`
7. Modal closes → `app.js` continues to normal page render

### State file
```json
{
  "completed_for_version": "1.0.6",
  "completed_at": "2026-05-22T11:23:45",
  "python_path": "C:/Users/.../Programs/Python/Python312/python.exe",
  "steps": {"msvc": "ok|skipped", "python": "ok", "pip": "ok", "model": "ok"}
}
```

### Critical bug fixed
- **Microsoft Store Python alias stubs**: `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` is a Microsoft Store install shortcut, NOT real Python. Running with args exits 9009 + opens Store. Fix: `_is_microsoft_store_alias()` rejects any path with `WindowsApps`, `_verify_python()` actually runs `python -c "import sys; print(sys.version_info[:2])"` to confirm working interpreter.

---

## 11. Critical feature: 403 Circuit Breaker (v1.0.6)

`backend/services/circuit_breaker.py` + wired into `content.py` + `image.py`.

### Why
Once Google flags a session as bot-y, ALL reCAPTCHA tokens from that session get rejected for ~10-15 minutes. Page reload (`renew_token`) doesn't reset score. Without protection, all items in a task cascade-fail, burning credit.

### Logic
Per-task `CircuitBreaker(threshold=3)`:
- `record_failure(error_msg)`:
  - If captcha-flavored → counter++, trip if ≥ threshold
  - If non-captcha → **ignore** (don't increment, don't reset — current bug-free version)
- `record_success()` → reset counter to 0

Captcha-flavored patterns (`RECAPTCHA_ERROR_PATTERNS`):
- `"403"`, `"recaptcha"`, `"permission_denied"`, `"unusual_activity"`
- Plus byproducts of 403-induced page reload: `"execution context was destroyed"`, `"failed to fetch"`

### Behavior
1. Item 1 fail 403 → counter=1
2. Item 2 fail "Failed to fetch" (caused by item 1's renew_token) → counter=2
3. Item 3 fail 403 → counter=3 → **CIRCUIT OPEN**
4. Items 4-N skip ngay (mark ERROR with cooldown msg), không gọi Google
5. Task → COMPLETED nhanh
6. Toast warning xuất hiện
7. Retry button enable ngay → user có thể bấm để gen lại tất cả ERROR items (incl. circuit-skipped)

### Retry behavior
`/api/tasks/{id}/retry`:
- ERROR + PENDING items → reset PENDING
- COMPLETED items → giữ nguyên (output_path intact)
- `_process_one()` returns early if `item.status == COMPLETED` (DON'T regenerate ✓ items)
- `counters["done"]` pre-seeded với số COMPLETED items (progress chip không reset)

---

## 12. Critical feature: Video Watermark Removal (v1.0.4 + v1.0.5)

Dedicated page `frontend/js/pages/video_watermark.js` under "Xử lý video" sidebar group.

### Architecture
- **Bundled in EXE** (v1.0.5+): `opencv-python` via `RedOne.spec` collect_all. OpenCV TELEA inpainting chạy **in-process** — không cần Python external.
- **Optional upgrade** to LaMa AI: `simple-lama-inpainting` + `torch` + big-lama.pt via in-app **wizard modal** trên page (button "Nâng cấp lên LaMa AI"). Pipeline reuse `lama_installer.py`.

### Pipeline (`backend/services/watermark_video.py`)
1. ffmpeg extract frames → temp dir as PNG
2. ffmpeg alpha-extract mask + resize to video dims
3. Inpaint:
   - **OpenCV path** (in-process): `lama_inpaint.run_opencv(..., on_event=callback)` via `asyncio.to_thread`
   - **LaMa path** (external Python subprocess): spawn `<python> lama_inpaint.py lama frames mask out`
4. ffmpeg re-encode → MP4 (libx264 crf=18) + copy audio gốc
5. Output: `outputs/video/watermark_removed/<date>/<name> [RedOne].mp4`

### Default Veo mask
`backend/resources/veo3watermark.png` — 1920×1080 mask cho Veo logo bottom-right. Bundled via `RedOne.spec` datas.

### Static watermark fast path (in `lama_inpaint.py`)
Detect if watermark region identical across all frames → inpaint **1 frame** only → paste patch to all others. Perfect cho Veo logo (đứng yên) → kết quả gần bằng LaMa với OpenCV.

### Gallery integration
- Tạo Video gallery có nút **"Xóa watermark"** (cam, eraser icon) trong multi-select toolbar
- Click → batch process selected videos sequentially → WS progress chip per video → auto-download zip

---

## 13. Critical feature: Auto-Updater (v1.0.4)

`backend/services/updater.py` + `backend/routers/system.py` + modal trong `app.js`.

### Flow
1. `app.js checkForUpdate()` on init → GET `/api/system/check-update` → cache 5min
2. Banner đỏ hiện "Có bản v1.0.X" với nút "Tải xuống & cài đặt" (only if frozen)
3. Click → modal mở:
   - Release notes preview
   - Progress bar (WS-driven via `update_progress` events)
   - Nút "Tải xuống"
4. Backend `POST /start-update` → background task:
   - Stream-download `RedOne-Creative-vX.X.X-win64.zip` từ GitHub release asset
   - Extract vào `data/updates/<version>/extracted/`
   - Stage = `ready`
5. User click "Cài đặt & restart" → `POST /apply-update`:
   - Write `data/updates/_install.bat`
   - Spawn batch (detached, CREATE_NO_WINDOW)
   - `os._exit(0)` after 0.5s
6. Batch:
   - Wait 3s for EXE process to die
   - Delete `RedOne Creative.exe` + `_internal/`
   - `xcopy extracted_dir → install_dir` (data/ + outputs/ untouched)
   - Relaunch new EXE
7. User lands on new version với toàn bộ data/accounts intact

### Naming convention bắt buộc
Release zip phải đuôi `.zip` (updater filter). Khuyến nghị format: `RedOne-Creative-vX.X.X-win64.zip`. Layout zip:
```
zip root/
  ├─ RedOne Creative.exe
  └─ _internal/
OR nested:
  └─ RedOne Creative/
      ├─ RedOne Creative.exe
      └─ _internal/
```
Updater auto-detect cả 2.

---

## 14. Multi-account login (Chrome + Cloak)

### Chrome flow (`backend/services/google_auth.py`)
1. User click "Login" trên account card
2. Backend spawn real Chrome subprocess via CDP với user-data-dir `data/browser_profiles/login_<id>/`
3. User đăng nhập Google trong cửa sổ Chrome thật
4. Tool poll cookies — khi thấy `next-auth.session-token` ổn định 2 ticks → export cookies vào `data/cookies/<id>_cookies.json` + close Chrome

### Cloak flow (`backend/routers/accounts.py:_do_login_cloak()`)
Same UX but launches `cloakbrowser.launch_persistent_context_async` instead. Profile dir `data/browser_profiles/cloak_login/<id>/`.

### Dispatcher
`backend/services/browser_manager.py:_configured_backend()` reads `db.get_setting('browser_backend')` fresh mỗi `get_page()` call. User switch trong Settings không cần restart.

### Verify CloakBrowser (đã test trong session này)
- Package: `cloakbrowser` v0.3.30 ✓
- Binary: Chromium 146.0.7680.177.5 cached tại `C:\Users\Admin\.cloakbrowser\` ✓
- Stealth: `navigator.webdriver = false` ✓
- Profile dirs auto-create OK

---

## 15. Build & release workflow

### Build EXE
```cmd
cd D:\RedOne Creative tool
git pull origin main
pyinstaller RedOne.spec --noconfirm --clean
```

Output: `dist\RedOne Creative\` ~600-800MB (sau khi bundle cv2 + imageio_ffmpeg).

**Tips:**
- `RedOne.spec` config: console=False (windowed), datas + binaries collected for cv2, cloakbrowser, etc.
- Build time: 2-5 phút
- Common gotcha: nếu EXE cũ đang chạy → PermissionError. Kill process trước: `Get-Process "RedOne Creative" | Stop-Process -Force`

### Zip
```cmd
cd dist
powershell Compress-Archive -Path "RedOne Creative" -DestinationPath "RedOne-Creative-vX.X.X-win64.zip"
```

### GitHub Release
1. https://github.com/kiennt-bit/RedOne-Creative-tool/releases/new
2. Choose a tag: `vX.X.X` → Create new tag on publish
3. Title + Description (markdown, user thấy trong banner)
4. Attach zip
5. Publish

---

## 16. Known issues / pending tasks

### Pending (chưa code)
1. **System tray icon**: tool chạy ngầm sau khi đóng tab. Hiện chỉ có nút ⏻ Tắt tool trong topbar. Maybe add pystray tray icon → right-click → Exit.
2. **Auto-shutdown idle timeout**: nếu không có WS connection > X phút → server tự `os._exit(0)`.
3. **Screenshot mục #10-#26** cho `docs/HUONG_DAN_SU_DUNG.md` (mới chụp 10 cái, còn ~15)
4. **Account rotation** khi circuit trip: nếu ≥2 accounts enabled → switch account trước khi pause task
5. **Khôi phục các báo cáo lỗi cũ** vào Tasks Manager (currently chỉ hiện running/queued)

### Hỗ trợ user vẫn cần
- v1.0.6 chưa được build + release thực tế. User cần:
  1. `git pull origin main` (đã có aadf723)
  2. `pyinstaller RedOne.spec --noconfirm --clean`
  3. Zip thành `RedOne-Creative-v1.0.6-win64.zip`
  4. Tạo GitHub Release tag `v1.0.6` + upload zip
- Sau đó user khác (đang chạy v1.0.5 hoặc cũ hơn) sẽ thấy banner auto-update

### Edge cases known
- **HTTP 429 download**: video gen xong nhưng download mp4 bị Google throttle 429. Currently retries via `download_to` chain (`_fetch_mp4_via_browser` → `get_download_url` → fallback). Có thể cần thêm exponential backoff specifically cho download path.
- **Antivirus block**: Windows Defender hay quarantine PyInstaller binaries. Document trong user guide.
- **Path Vietnamese / spaces**: PyInstaller có lúc fail nếu extract vào `C:\Tài liệu\` hoặc path nhiều khoảng trắng. Khuyến nghị `C:\RedOne\`.

---

## 17. Quick debug commands

```powershell
# Kill all tool processes
Get-Process "RedOne Creative" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process python -ErrorAction SilentlyContinue | Stop-Process -Force

# Check port 8000 free
Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue

# View latest log
Get-Content data/app.log -Tail 50

# Check setup wizard state
Get-Content data/setup-state.json

# Tail console.log (frozen EXE windowed stdout)
Get-Content "dist/RedOne Creative/console.log" -Tail 30

# Reset wizard (force re-trigger on next launch)
Remove-Item data/setup-state.json

# In dev mode
cd D:\RedOne Creative tool
python launch.py

# In Python REPL — check current settings
python -c "import sys; sys.path.insert(0, '.'); from backend.database import db; print(db.all_settings())"
```

---

## 18. Critical user preferences (do not surprise)

1. **Vietnamese UI**: mọi label, error message, toast — Vietnamese. Comments code → English (đỡ rối).
2. **"Tín dụng Flow"** terminology — không gọi là "credits" hay "AI credits" trong UI (mismatch với Google's popup).
3. **Subscription credits** (10871 type number), không phải total `credits` (35871). User cần biết "credit chính chủ".
4. **Push 1-by-1**: t commit theo từng chủ đề rõ ràng để git log dễ đọc. User hay rebuild EXE local nên cần granular history.
5. **Wizard "Bắt buộc"** UX (no skip button) — user chọn rồi, đừng tự thêm skip.
6. **Build mode = `--onedir`** (không phải `--onefile`). Onefile cồng kềnh + chậm startup.
7. **Python 3.12.7** target. Cẩn thận 3.13/3.14 — torch wheels thiếu, simple-lama compat unsure.
8. **Auto-update KHÔNG đụng data/ + outputs/**. Critical contract — không bao giờ đổi.

---

## 19. Files to read first khi mở session mới

Theo thứ tự ưu tiên (nếu chỉ đọc 5):

1. **`SESSION_HANDOFF.md`** (file này) — tổng quan
2. **`backend/config.py`** — version + paths + model keys + endpoints
3. **`backend/services/flow_client.py`** — Google API client (~1700 LOC, đọc qua function signature)
4. **`backend/services/setup_wizard.py`** — flow Phase 3 mới nhất
5. **`frontend/js/app.js`** — routing + init order

Sau đó nếu cần dig sâu:
- `backend/routers/content.py` cho gen video pipeline
- `backend/services/circuit_breaker.py` cho 403 logic
- `frontend/js/setup_wizard.js` cho wizard UI
- `RedOne.spec` cho build config

---

## 20. Session log (chronological highlights)

Phiên session này (2026-05-22):
- ✅ Verified CloakBrowser end-to-end (package + binary + dispatcher + stealth)
- ✅ Built First-Run Setup Wizard (v1.0.6) — Python 3.12 + torch + model auto-install
- ✅ Fixed Microsoft Store Python alias detection bug
- ✅ Fixed CMD flash via belt-and-suspenders subprocess flags + 60s lama_status cache
- ✅ Made sidebar responsive cho màn hình ngang/thấp (visible scrollbar + auto-compact)
- ✅ Implemented 403 cascade circuit breaker (threshold=3)
- ✅ Fixed retry-regenerates-all-items bug (skip COMPLETED items in `_process_one`)
- ✅ Hardened circuit breaker patterns (catch byproducts, no reset on misc errors)

Phiên session trước (2026-05-20 đến 05-21):
- v1.0.3 image upscale 2K/4K
- v1.0.4 retry buttons + video watermark removal + auto-updater
- v1.0.5 hybrid LaMa (OpenCV bundled, LaMa via wizard) + topbar redesign + credit "Tín dụng Flow"

Earliest sessions (2026-05-15 đến 05-19):
- Initial build từ PySide6 codebase (`D:\SAVE\RedOne tool`)
- T2V/I2V/image gen pipeline
- Multi-account login với Chrome CDP
- Omni Flash duration encoded in model_key
- CloakBrowser optional backend

---

**End of handoff doc. Mở file này đầu mọi session mới về RedOne Creative.**
