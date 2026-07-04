# RedOne GenFill — Photoshop Plugin

Plugin Photoshop CEP tích hợp **Generative Fill** qua Google Flow API.

**Hoàn toàn độc lập** — mọi thứ chạy bên trong Photoshop, không cần mở thêm bất kỳ phần mềm nào. Chỉ cần Chrome Extension ("RedOne Auth Helper") + tab labs.google/fx.

## Cách hoạt động

```
Photoshop Panel (CEP)
  ├─ Embedded Node.js server (port 8000)  ← Extension kết nối vào đây
  ├─ Flow API client                       ← Upload + Generate qua bridge
  └─ ExtendScript                          ← Export image/mask, apply result
```

Panel tự khởi động HTTP server trên port 8000 khi mở. Chrome Extension ("RedOne Auth Helper") tự động kết nối vào server này — giống như khi kết nối với RedOne, nhưng server nằm ngay trong Photoshop.

> Nếu RedOne đang chạy (cũng dùng port 8000), panel tự detect và dùng RedOne backend thay thế.

## Yêu cầu

- **Photoshop** CC 2015.5+ (đã test v27.8)
- **Chrome Extension** "RedOne Auth Helper" đã cài
- Tab **labs.google/fx** mở trong Chrome (đã đăng nhập Google)
- ❌ ~~Python~~ — KHÔNG cần
- ❌ ~~RedOne Creative Tool~~ — KHÔNG cần chạy

## Cài đặt

### Bước 1: Chạy installer (1 lần)
Chuột phải `install_ps_plugin.bat` → **Run as administrator**

Hoặc làm thủ công:
1. Registry: `HKEY_CURRENT_USER\Software\Adobe\CSXS.10` → `PlayerDebugMode` = `"1"`
2. Symlink/copy thư mục `photoshop-plugin` vào:
   ```
   C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\com.redone.genfill
   ```

### Bước 2: Restart Photoshop

### Bước 3: Mở panel
**Window → Extensions → RedOne GenFill**

## Sử dụng

1. **Mở ảnh** trong Photoshop
2. **Tạo vùng chọn** (Lasso, Magic Wand, Quick Selection, Marquee, v.v.)
3. Trong panel:
   - Chọn **Model**: Nano Banana Pro / Nano Banana 2 / Imagen 4
   - Nhập **Prompt**
   - Click **Tạo GenFill** (hoặc `Ctrl+Enter`)
4. Chờ 10-30 giây
5. Xem preview → **Apply vào PS** (tạo layer mới)

## Khắc phục sự cố

| Triệu chứng | Giải pháp |
|---|---|
| Panel không hiện | Kiểm tra registry `PlayerDebugMode = 1`, restart PS |
| "Chờ extension…" | Mở Chrome + kiểm tra extension "RedOne Auth Helper" đã bật |
| "Extension: no_tab" | Mở tab `labs.google/fx/tools/flow` trong Chrome |
| "Extension: no_login" | Đăng nhập Google trong tab labs.google |
| Kết quả không tốt | Thử prompt cụ thể hơn, hoặc đổi model |

## Debug

Mở Chrome DevTools tại:
```
http://localhost:8098
```

## Cấu trúc

```
photoshop-plugin/
├── CSXS/manifest.xml          # CEP manifest
├── index.html                  # Panel UI
├── css/style.css               # Dark theme
├── js/
│   ├── CSInterface.js          # Adobe CEP bridge
│   ├── embedded_server.js      # ★ Node.js bridge server (tự chạy trong PS)
│   ├── flow_api.js             # ★ Google Flow API client
│   └── main.js                 # Panel logic
├── jsx/photoshop.jsx           # ExtendScript
├── .debug                      # DevTools debug config
└── README.md
```
