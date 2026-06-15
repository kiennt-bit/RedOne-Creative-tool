# RedOne Creative — Project Context (Session Handoff)

> **Mục đích file này**: tóm tắt toàn bộ kiến trúc + quyết định + lịch sử để mở session AI mới (hoặc onboard dev mới) mà không mất context. Đọc file này + xem code = hiểu hệ thống.
>
> **Cập nhật lần cuối**: 2026-06-03 · phiên bản hiện tại **v1.2.2**

---

## 0. TL;DR thay đổi lớn gần đây (v1.2.0)

- **Thêm Shakker.ai** — tab "Ảnh Shakker" sinh ảnh hàng loạt (Stable Diffusion + LoRA), song song với Google Flow.
- **Gỡ Vertex AI + Playwright/Cloak** — tool giờ **chỉ chạy 1 chế độ duy nhất: Chrome Extension Bridge**. Code của 2 mode cũ vẫn còn trên đĩa nhưng KHÔNG còn được gọi (dead code) — `flow_factory.py` ép `extension`.
- **Gen song song** — task Shakker và task Flow (ảnh/video) chạy trên 2 queue độc lập, đồng thời.
- **OAuth gate @redone.vn** — đăng nhập tool bằng Google Workspace; project Google Cloud cũ (`resonant-forge-497503-e0`) **đã bị Google suspend** (billing/AUP) nên OAuth chuyển sang **project mới riêng** (chỉ host OAuth, không billing).
- **Viết lại toàn bộ thông báo lỗi** (Flow + Shakker) cho chính xác/dễ hiểu.

---

## 1. Bối cảnh dự án

### Nguồn gốc
Làm lại tool desktop **RedOne** (PySide6 cũ) thành **web app** (FastAPI + vanilla JS), giữ tính năng tạo ảnh/video AI qua Google Labs Flow (credit miễn phí), thêm Shakker.ai.

### Workspace location (CANONICAL)
```
D:\RedOne Creative tool\        ← PROJECT CHÍNH (code ở đây từ 2026-05-29)
```
> ⚠️ Mọi chỉnh sửa đi vào **`D:\RedOne Creative tool`**.

### Repo GitHub
**https://github.com/kiennt-bit/RedOne-Creative-tool** — user `kiennt-bit`.
Git Credential Manager máy này từng cache user khác → nếu push lỗi auth, set remote `https://kiennt-bit@github.com/...` để prompt đúng user.

---

## 2. Kiến trúc tổng quát

### Mô hình deployment (mỗi máy 1 instance, không server tập trung)
```
GitHub Releases (zip)  →  RedOne Creative.exe (PyInstaller --onedir)
                              ↓
                       FastAPI 127.0.0.1:8000  ──(auth gate @redone.vn)──►  SPA UI
                              ↓
                  Chrome Extension "RedOne Auth Helper" (cài unpacked)
                     ├─ tab labs.google   → token/cookies Flow  ──► /sync/*
                     └─ tab shakker.ai     → token Shakker        ──► /sync/shakker-account
```

### 2 lớp "tài khoản" — ĐỪNG NHẦM
| Lớp | Mục đích | Cơ chế |
|-----|----------|--------|
| **Đăng nhập tool** | Cổng bảo vệ — chỉ `@redone.vn` mới vào | OAuth Google, session lưu `data/auth_session.json` (30 ngày), per-máy |
| **Tài khoản tạo ảnh** | Account thực thi gen | Google (labs.google) cho Flow + tài khoản Shakker — đều lấy qua Chrome Extension |

### Tech stack
**Backend**: Python 3.10+ (dev 3.14) · FastAPI + uvicorn (8000) · WebSocket `/ws` · SQLite (`data/navtools.db`) · httpx (Flow bridge + Shakker + OAuth) · oss2 (upload ảnh tham chiếu Shakker lên Alibaba OSS) · google-genai (Gemini) · yt-dlp.
**Frontend**: Vanilla JS ES modules (không framework, không bundler) · CSS variables (light/dark) · 1 page = 1 file trong `frontend/js/pages/`.
**Extension**: Chrome MV3 (content scripts + background service worker + popup), XOR-enveloped bridge protocol với backend `/sync/*`.
**Packaging**: PyInstaller `--onedir` → `dist/RedOne Creative/` (~400-600MB).

---

## 3. Cấu trúc thư mục (cập nhật v1.2.0)

```
RedOne Creative tool/
├── backend/
│   ├── main.py              ← FastAPI app, lifespan (2 queue), AUTH GATE middleware, router includes
│   ├── config.py            ← APP_NAME, APP_VERSION (1.2.0), paths, model maps, SERVER_PORT=8000
│   ├── database.py          ← SQLite ORM (+ bảng shakker_accounts)
│   ├── ws_hub.py            ← WebSocket broadcast hub
│   ├── queue_manager.py     ← queue (Flow lane) + shakker_queue (Shakker lane) — CHẠY SONG SONG
│   ├── private_config.py    ← (GITIGNORE) OAuth client id/secret, ALLOWED_EMAIL_DOMAIN, Vertex* (dead)
│   ├── private_config.py.template
│   ├── routers/
│   │   ├── auth.py          ← /auth/login, /callback, /me, /logout (OAuth gate)
│   │   ├── accounts.py      ← /api/accounts/* (Google Flow accounts)
│   │   ├── content.py       ← /api/content/* (T2V + I2V)
│   │   ├── image.py         ← /api/image/* (Flow images)
│   │   ├── long_video.py    ← /api/long-video/*
│   │   ├── shakker.py       ← /api/shakker/* (generate/cancel/retry/models/loras/account/upload-ref)
│   │   ├── shakker_accounts.py ← /api/shakker-accounts/* (list/sync/check/toggle/delete/check-all)
│   │   ├── sync.py          ← /sync/* (extension bridge: Flow cookies + shakker token; XOR envelope)
│   │   ├── analyzer.py, media_tools.py, tasks.py, files.py, settings.py, system.py
│   └── services/
│       ├── flow_factory.py      ← make_flow_client() — ÉP 'extension' (Vertex/Playwright đã gỡ)
│       ├── flow_client_bridge.py ← BridgeFlowClient — ACTIVE (gọi Flow qua extension)
│       ├── browser_bridge.py    ← Bridge tới Chrome extension (request/response qua /sync)
│       ├── shakker_client.py    ← ShakkerClient — ACTIVE (models/loras/generate/poll/upload OSS)
│       ├── oauth_auth.py        ← OAuth login gate logic (session file, domain check)
│       ├── error_messages.py    ← friendly_error() [Flow] + friendly_shakker_error() [Shakker]
│       ├── gemini.py, updater.py, ffmpeg_utils.py, image_utils.py
│       ├── lama_inpaint.py, lama_installer.py, watermark_video.py
│       └── [DEAD] flow_client.py, browser_manager.py, cloak_backend.py,
│                  recaptcha_provider.py, google_auth.py  ← Playwright/Cloak cũ, không còn gọi tới
│
├── extension/               ← Chrome MV3 "RedOne Auth Helper" (version 1.2.0)
│   ├── manifest.json        ← host_permissions: labs.google + shakker.ai
│   ├── background.js        ← service worker, GET_METRICS, SHAKKER_SYNC handler
│   ├── content_*.js (labs.google)  + content_shakker.js (shakker.ai)
│   └── popup.html / popup.js ← trạng thái Flow + Shakker
│
├── frontend/
│   ├── index.html           ← SPA shell: sidebar + topbar (3 chip: Accounts / Tín dụng Flow / Tín dụng Shakker) + banners
│   ├── css/ (theme, layout, components, pages)
│   ├── js/
│   │   ├── app.js           ← router, WS, theme, OAuth chip, autoScanAccounts (Flow+Shakker),
│   │   │                       refreshShakkerPower (topbar), maybeShowUpdateNotice (banner reload ext)
│   │   ├── api.js           ← api.shakker.*, api.shakkerAccounts.*, api.accounts.*, ...
│   │   ├── ws.js, ui.js, tasks_store.js, gallery_actions.js
│   │   └── pages/
│   │       ├── shakker.js   ← Tab "Ảnh Shakker" (model + multi-LoRA + img2img + 7 tỉ lệ + bulk)
│   │       ├── accounts.js  ← Google accounts + SECTION tài khoản Shakker
│   │       ├── settings.js  ← Cài đặt (chỉ "Chế độ kết nối" = Extension Bridge cố định)
│   │       ├── content.js, image.js, long_video.js, tasks_manager.js, ...
│
├── data/      (gitignore)   ← db, auth_session.json, app.log, cookies, browser profiles
├── outputs/   (gitignore)   ← file đã gen
├── docs/
│   ├── HUONG_DAN_SU_DUNG.md ← User guide v1.2.0 (13 mục, có chương Ảnh Shakker)
│   └── shakker_capture/     ← (GITIGNORE) HAR + dump reverse-engineering — CHỨA TOKEN THẬT, không commit
├── PROJECT_CONTEXT.md (file này) · SESSION_HANDOFF.md · BUILD_RELEASE.md · README.md
├── build.bat · run.bat · requirements.txt · .gitignore
```

---

## 4. Sidebar nav (thêm "Ảnh Shakker")

```
SÁNG TẠO:   Tạo Video · Tạo Ảnh · Ảnh Shakker (★ mới) · Video Dài
PHÂN TÍCH:  YouTube→Prompt · Ý Tưởng→Video · Ảnh→Prompt
XỬ LÝ ẢNH:  Tách Nền · Xóa Logo · Upscale · Resize Hàng Loạt
XỬ LÝ VIDEO: Ghép Audio · Phụ Đề
HỆ THỐNG:   Quản lý Task · Tài Khoản (Google + Shakker) · Cài Đặt
```

---

## 5. Auth / OAuth gate (đăng nhập tool)

- Middleware trong `main.py` chặn `/api/*` + SPA root nếu chưa có session hợp lệ. **Cho qua không cần auth**: `/auth/*`, `/static/*`, `/sync/*` (extension bridge), `/login.html`, `/favicon.ico`.
- Nếu `private_config.py` chưa có OAuth creds (`is_configured()` False) → **gate BỎ QUA** (admin vào đọc hướng dẫn setup được).
- Flow: `/auth/login` → Google consent (`hd=redone.vn`) → `/auth/callback` → đổi code → kiểm tra email kết thúc `@redone.vn` → lưu `data/auth_session.json` (30 ngày) → redirect `/`.
- **Quan trọng (sự cố thực tế)**: project Cloud cũ `resonant-forge-497503-e0` bị Google **suspend** (billing + nghi AUP) → OAuth client cũ báo `disabled_client`. Đã tạo **project Google Cloud MỚI riêng cho OAuth** (User Type **Internal**, không bật billing → không bao giờ bị suspend vì thanh toán). Client id/secret mới nằm trong `private_config.py` (gitignored).
- 1 mail @redone.vn login được nhiều máy đồng thời (mỗi máy 1 session file).

---

## 6. Generation: CHỈ Chrome Extension Bridge

`flow_factory.py` (đã rút gọn v1.2.0):
- `_read_auth_mode()` → luôn `"extension"` (tự "chữa lành" máy nào còn lưu `auth_mode=vertex_api|playwright`).
- `is_vertex_mode()` → False · `get_page_for_account()` → None · `make_flow_client()` → luôn `BridgeFlowClient`.
- Giữ tên hàm cũ (`synthetic_vertex_account`, ...) để router import không vỡ → **không router nào phải sửa**.

**BridgeFlowClient** (`flow_client_bridge.py`) gọi Flow API qua extension trong Chrome thật của user (token+cookies thật → Google ít flag 403). Extension đẩy state về backend qua `/sync/*` (XOR envelope). Cookie/token KHÔNG lưu file (extension mode), session "sống" được xác định qua bridge probe `/fx/api/auth/session`.

---

## 7. Shakker.ai (tính năng mới v1.2.0)

- **Shakker.ai = front quốc tế của Liblib AI** (Trung Quốc), engine Stable Diffusion (FLUX.1). Tính bằng **power** (không phải credit Google).
- **Auth**: header `token:` (44-char hex) lấy từ cookie `usertoken` trên shakker.ai — extension `content_shakker.js` đọc và đẩy về `/sync/shakker-account`. `webid` = cookie `cid`. `liblibai_userinfo` (localStorage) cho uuid/email/id.
- **ShakkerClient** (`shakker_client.py`): `list_models`/`list_loras` (search param = **`query`**), `build_payload`, `submit_generate` (retry lỗi transient "task is being initiated"), `wait_for_completion`, `download_result`, `upload_reference_image` (oss2 → bucket `models-online-persist-us`, key `img/{uuid}/{hash}.{ext}`).
  - **LoRA**: `additionalNetwork.append({"modelId": versionId, "weight": w, "type": 0})` (modelId = **versionId**, kèm type:0).
  - **img2img**: cần `denoisingStrength=1.0-strength`, `resizeWidth/Height`, `sourceImageId` = **OSS object key** (không phải CDN url), `imageMode:0`, `resizeMode:1`; generateType=22; t2i = 21.
- **Router** `shakker.py`: account concurrent=1 → **xử lý tuần tự từng prompt** (1 item "Đang tạo", còn lại "Đang chờ"); tối đa **4 ảnh/prompt**; fan-out không giới hạn luồng nhưng `_spaced_submit` (lock toàn cục ≥1.2s) chống va chạm submit. Task config (checkpoint/LoRA/ref/aspect) lưu 1 lần trên task row (`character_images_json`).
- **Queue riêng** `shakker_queue` → chạy song song với Flow.
- Quản lý account Shakker ở **tab Tài Khoản** (không phải Cài đặt). Topbar có chip "Tín dụng Shakker" = tổng power các account bật.

---

## 8. Queue song song (v1.2.0)

`queue_manager.py`: 2 instance `TaskQueue` độc lập, mỗi cái 1 worker:
- `queue` — lane Flow (content/image/long_video) — tuần tự với nhau.
- `shakker_queue` — lane Shakker — tuần tự với nhau.
→ 1 task Flow + 1 task Shakker chạy **đồng thời**. `tasks.py` có `_queue_for_mode(mode)` định tuyến position/cancel/retry đúng lane; `_merged_snapshot()` gộp 2 lane cho UI.

---

## 9. Database schema (SQLite)

```sql
accounts:        id, email, enabled, credit, tier, cookie_path, cookie_exp, token_exp, proxy, created_at
projects:        id, name, folder_path, created_at
tasks:           id, project_id, name, mode("shakker"|"image"|...), quality, image_model,
                 aspect_ratio, resolution, duration, concurrent, total_count, done_count,
                 error_count, character_images_json (dùng làm JSON config Shakker), status, *_at
task_items:      id, task_id, prompt, status, output_path, credit_cost, error_message, extra_json, *_at
settings:        key, value (JSON)
shakker_accounts: id, user_uuid(UNIQUE), email, user_id, account_id, token, webid, tier,
                 total_power, used_power, usable_power, concurrent, expiry, enabled, status,
                 status_msg, last_check_at, created_at
```
Migration idempotent: `_add_column_if_missing(...)` chạy mỗi boot.

---

## 10. Thông báo lỗi (`error_messages.py`)

2 hàm: `friendly_error()` (Flow) + `friendly_shakker_error()` (Shakker). Mỗi message nêu: **nguyên nhân** + **tạm thời/vĩnh viễn** + **việc cần làm**. Thứ tự bucket quan trọng:
- **reCAPTCHA/throttle** (`UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC`) check **TRƯỚC** daily-quota (vì cùng chứa "429") → không bị gán nhầm "hết lượt hôm nay".
- **Prominent people** (`PROMINENT_PEOPLE_FILTER_FAILED`) check trước safety chung.
- Đã bỏ mọi nhắc tới "Vertex AI" (đã gỡ). Bug đã sửa: Shakker dùng `"rate"` khớp nhầm chữ "gene**rate**" → đổi sang `"rate limit"`.

---

## 11. Cập nhật + Extension (QUAN TRỌNG khi release)

- Auto-updater (`updater.py`) tải zip → giải nén → `_install.bat`: xóa exe + `_internal\`, `xcopy bundle\* → install\` (overwrite, **gồm cả `extension\`**), giữ `data\`+`outputs\`, relaunch.
- ⚠️ **Chrome KHÔNG hot-reload extension unpacked** → sau update user phải vào `chrome://extensions` bấm **↻ Reload** (nhất là khi manifest đổi). `app.js` `maybeShowUpdateNotice()` so version trong localStorage → hiện banner nhắc reload sau mỗi update (chạy từ bản SAU bản chứa code này; bản 1.1.3→1.2.0 phải ghi nhắc trong release notes).
- Đóng gói zip: `RedOne Creative/` chứa exe + `_internal/` + **`extension/`** ngang hàng. Lệnh: `xcopy /E /I extension "dist\RedOne Creative\extension"` trước khi zip.

---

## 12. Bảo mật (RÀNG BUỘC)

- **KHÔNG commit secret lên GitHub.** Gitignored: `backend/private_config.py` (OAuth secret), `docs/shakker_capture/` + `*.har` (chứa token Shakker + userId + image tokens THẬT), `data/`, `outputs/`, `*-key.json`.
- Chỉ user **@redone.vn** được dùng tool (OAuth gate).
- **KHÔNG push vội** — chỉ commit+push khi user nói rõ "OK push".
- **"Đừng chữa lợn lành thành lợn què"** — giữ path Flow/bridge đang chạy nguyên vẹn khi thêm tính năng.

---

## 13. Version history

| Version | Tóm tắt |
|---|---|
| v1.0.x | Web app cơ bản: Veo 3.1 + Nano Banana, sequential queue, multi-account, Playwright |
| v1.1.x | Chrome Extension Bridge (giảm 403), Vertex AI commercial mode, OAuth gate @redone.vn, batch cooldown |
| v1.2.0 | **Ảnh Shakker** (model + multi-LoRA + img2img + bulk). **Gỡ Vertex AI + Playwright/Cloak** → chỉ còn Extension Bridge. **Queue song song** Flow ⇄ Shakker. Viết lại toàn bộ thông báo lỗi. OAuth chuyển project mới (project cũ bị Google suspend). |
| v1.2.1 | Quản lý tài khoản Shakker dời sang tab **Tài Khoản** + chip "Tín dụng Shakker" trên topbar (auto-scan khi login). Banner nhắc **reload extension** sau update. Sửa lỗi **"Session hết hạn" gián đoạn**: `_do_get_token` retry status=0 thay vì báo session-dead ngay. **Capability gate** (`browser_bridge.pop_task_for_extension` + `is_ready_extension_live`): extension chạy được ở **nhiều profile Chrome** — chỉ instance có tab labs.google (`tab_status="ready"`) nhận task. Extension `_findLabsTab` retry 3× + khớp mọi locale `/vi/`,`/en/`. |
| **v1.2.2 (current)** | **Loop video** (I2V): cùng ảnh làm frame đầu+cuối → interpolation (endpoint `video:batchAsyncGenerateVideoStartAndEndImage`, model `veo_3_1_interpolation_*`). UI: toggle + card kết quả đẹp lại (toàn cục), card storyboard riêng cho analyzer (`.sb-card`, không ô ảnh), default video model = `lite_lp`. **YouTube→Prompt fix**: Gemini nhận video đúng (mime + Files API trong `gemini.py`), auto-harvest cookie YouTube qua extension (manifest **1.2.2** + task `get_cookies` + `bridge.get_cookies`), yt-dlp merge format + `player_client`. **State-persist** module-level cho 3 tab analyzer (youtube/script/image_prompt) + 4 tab Xử lý ảnh (bg_remove/watermark/upscale/batch_resize) — giữ input + kết quả khi chuyển tab. |

---

## 14. Commands cheatsheet

```bash
cd "D:\RedOne Creative tool"
run.bat                      # dev run (uvicorn 127.0.0.1:8000)
build.bat                    # build EXE
curl http://127.0.0.1:8000/api/health
py -c "from backend.database import db; print(db.all_settings())"
git status && git log --oneline -10
```

---

## 15. Conventions

- Tiếng Việt cho UI text + commit messages; English cho code comments/identifiers.
- Imports relative (backend `from ..x`; JS `from '../x.js'`).
- CSS variables, dark mode qua `[data-theme="dark"]`.
- Per-page module: `export function renderXxx(root)` + cleanup qua MutationObserver.
- Toast: success/error/warning/info.
- Backend đổi Python → **phải restart `run.bat`**; đổi JS/HTML → chỉ cần hard-refresh (server tự bust cache import bằng `?b=BUILD_ID`).

---

## 16. Khi mở session mới — đọc theo thứ tự

1. `git status` + `git log --oneline` → tình trạng repo.
2. File này (PROJECT_CONTEXT.md) — section 0 (TL;DR) + 6/7/8 (extension, Shakker, queue).
3. `backend/config.py` (constants) + `backend/main.py` (auth gate + router includes).
4. `backend/services/flow_factory.py` (extension-only) + `flow_client_bridge.py` (bridge).
5. `backend/routers/shakker.py` + `backend/services/shakker_client.py` (Shakker).
6. `frontend/js/pages/shakker.js` + `accounts.js` (UI patterns).

> ⚠️ `flow_client_bridge.py` / `shakker_client.py` đã chạy ổn — không refactor lớn nếu chưa hiểu kỹ. Giữ path đang chạy nguyên vẹn.

---

**END OF CONTEXT** — update file này khi có thay đổi lớn về kiến trúc hoặc version bump.
