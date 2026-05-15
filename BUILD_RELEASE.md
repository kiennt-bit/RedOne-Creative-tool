# Build & Release Guide — RedOne Creative

## Yêu cầu môi trường (1 lần thôi)

```bash
pip install -r requirements.txt
pip install pyinstaller
playwright install chromium    # bundle browser cho Playwright
```

## Build EXE local

```bat
build.bat
```

Output: `dist\RedOne Creative\RedOne Creative.exe` + các DLL/files đi kèm.
Build mất ~2-5 phút, folder cuối cùng ~400-600 MB.

### Test thử trước khi release

1. `dist\RedOne Creative\RedOne Creative.exe` → double-click
2. Browser auto-mở http://127.0.0.1:8000
3. Kiểm tra: login account, tạo ảnh test, check tab Settings → "Kiểm tra cập nhật"

---

## Phát hành lên GitHub

### Lần đầu — tạo repo

1. Tạo repo `kiennt-bit/RedOne-Creative-tool` (đã có)
2. Push source code:
   ```bash
   cd C:\Users\Admin\Downloads\NAVTools_Web
   git init
   git add .
   git remote add origin https://github.com/kiennt-bit/RedOne-Creative-tool.git
   git branch -M main
   git commit -m "Initial release"
   git push -u origin main
   ```

### Mỗi lần release (vd: v1.0.1)

1. **Bump version**:
   - Sửa `backend/config.py` → `APP_VERSION = "1.0.1"`
   - Commit + push lên `main`

2. **Build**:
   ```bat
   build.bat
   ```

3. **Đóng gói cho release**:
   - Zip thư mục `dist\RedOne Creative\` (chuột phải → Send to → Compressed folder)
   - Đặt tên: `RedOne-Creative-v1.0.1-win64.zip`

4. **Tạo GitHub Release**:
   - Vào https://github.com/kiennt-bit/RedOne-Creative-tool/releases/new
   - **Choose a tag**: gõ `v1.0.1` → "Create new tag: v1.0.1 on publish"
   - **Release title**: `v1.0.1 — Mô tả ngắn`
   - **Description**: changelog (Markdown). Đây là phần user thấy trong banner update.
   - **Attach files**: kéo thả file `.zip` vào → upload
   - Bấm **Publish release**

5. **Auto-detect**: 
   - Trong vòng 5 phút (do cache TTL), tool trên các máy khác sẽ tự thấy banner cập nhật khi user mở
   - Hoặc user bấm "Kiểm tra cập nhật" trong Settings để force check ngay
   - Bấm "Tải bản mới" → mở link release → user tự tải zip + giải nén thay thế

---

## Cấu trúc thư mục frozen mode

Sau khi user giải nén zip, thư mục `RedOne Creative\` trông như:

```
RedOne Creative\
├── RedOne Creative.exe        ← double-click để chạy
├── _internal\                 ← python DLLs + packages (đừng xóa)
│   ├── frontend\              ← HTML/CSS/JS (bundle ở đây)
│   └── ...
├── data\                      ← TỰ TẠO khi chạy lần đầu
│   ├── navtools.db            ← SQLite (settings, tasks, accounts)
│   ├── cookies\<id>_cookies.json
│   ├── browser_profiles\login_<id>\
│   └── app.log
└── outputs\                   ← Output sinh ra
    ├── video\YYYY-MM-DD\<task_name>\
    └── image\YYYY-MM-DD\<task_name>\
```

**Lưu ý**: `data\` và `outputs\` nằm **bên cạnh exe**, KHÔNG nằm trong bundle.
Khi user update lên version mới, chỉ thay thế:
- File `RedOne Creative.exe`
- Folder `_internal\` (chứa code Python + frontend mới)

Giữ nguyên `data\` và `outputs\` → settings + accounts + tasks lịch sử không mất.

---

## Đăng nhập Google trên mỗi máy

Mỗi máy chạy tool sẽ:
1. User bấm **Login** trong tab "Tài Khoản"
2. Tool mở Chrome thật của máy đó (`google-chrome.exe`)
3. User đăng nhập Google bằng tài khoản của họ
4. Cookies lưu vào `data\cookies\<id>_cookies.json` của máy đó

Mỗi máy **độc lập** — cookies không sync giữa máy. Đây là intentional vì:
- Tránh "1 account dùng song song nhiều máy" → Google detect bất thường
- User mỗi máy dùng account riêng → có credit riêng

---

## Common issues

| Lỗi | Cách fix |
|---|---|
| `Failed to find Chrome` | Cài Google Chrome trên máy đó (link: https://google.com/chrome) |
| `Port 8000 in use` | Có instance khác đang chạy. Tắt qua Task Manager → kill `RedOne Creative.exe` |
| Banner update không hiện | Chờ 5 phút (cache TTL) hoặc bấm "Kiểm tra cập nhật" trong Settings |
| Build báo `playwright not found` | `pip install playwright && playwright install chromium` |
| EXE chạy báo "MSVCP140.dll missing" | Cài Visual C++ Redistributable: https://aka.ms/vs/17/release/vc_redist.x64.exe |

---

## Tự động hóa với GitHub Actions (tùy chọn)

Tạo file `.github/workflows/release.yml` để auto-build khi push tag:

```yaml
name: Build EXE
on:
  push:
    tags: ['v*']
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: pip install -r requirements.txt && pip install pyinstaller
      - run: playwright install chromium
      - run: pyinstaller RedOne.spec --noconfirm --clean
      - run: |
          cd dist
          Compress-Archive -Path "RedOne Creative" -DestinationPath "RedOne-Creative-${{ github.ref_name }}-win64.zip"
      - uses: softprops/action-gh-release@v1
        with:
          files: dist/RedOne-Creative-*.zip
```

Sau đó chỉ cần `git tag v1.0.1 && git push --tags` → CI tự build + tạo release.
