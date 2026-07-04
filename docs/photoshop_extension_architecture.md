# Kiến trúc Photoshop CEP Extension — RedOne Generative Fill

Tài liệu này phân tích chi tiết cấu trúc thư mục, kiến trúc luồng dữ liệu, và cách thức tương tác đa môi trường bên trong Photoshop CEP (Common Extensibility Platform) Extension của RedOne GenFill.

---

## 1. Mô hình kiến trúc tổng quan (Dual-Engine Execution)

CEP Extension hoạt động dựa trên mô hình **hai động cơ chạy song song** được liên kết chặt chẽ với nhau thông qua Adobe CSInterface bridge:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Adobe Photoshop (Host App)                        │
│                                                                        │
│  ┌──────────────────────────────┐    ┌──────────────────────────────┐  │
│  │    CEP Panel (Chromium CEF)  │    │     ExtendScript Engine      │  │
│  │                              │    │                              │  │
│  │  • UI (HTML5/CSS/JS)         │    │  • Photoshop DOM API         │  │
│  │  • Node.js Runtime           │    │  • Action Manager (Low-level)│  │
│  │  • Embedded Server (p8001)   │    │  • File & Canvas Manipulation│  │
│  │  • Flow API Client           │    │                              │  │
│  └──────────────┬───────────────┘    └──────────────▲───────────────┘  │
│                 │                                   │                  │
│                 │       csInterface.evalScript      │                  │
│                 └───────────────────────────────────┘                  │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Chromium Embedded Framework (CEF Engine)**:
   - Chịu trách nhiệm hiển thị giao diện UI cho người dùng (HTML/CSS/Vanilla JS).
   - Tích hợp sẵn môi trường **Node.js** đầy đủ (cho phép gọi thư viện hệ thống như `fs`, `path`, `os`, `http`, v.v.).
   - Khởi chạy một server local (`embedded_server.js` chạy trên cổng `8001`) trực tiếp bên trong Photoshop để nhận token, lệnh điều khiển từ Chrome Extension.
   - Gửi yêu cầu HTTP đến Google Flow API (qua Chrome Extension proxy).

2. **ExtendScript Engine (JSX Engine)**:
   - Chạy độc lập trong lõi xử lý của Photoshop.
   - Có toàn quyền truy xuất cấu trúc dữ liệu của Photoshop (Tài liệu, Vùng chọn, Layers, Canvas).
   - Sử dụng ngôn ngữ Javascript ES3 cũ cùng các hàm API độc quyền của Adobe để chỉnh sửa đồ họa.

3. **Adobe CSInterface Bridge**:
   - Cung cấp giao thức `CSInterface.evalScript(jsxCommand, callback)` để gửi mã Javascript từ CEF sang ExtendScript thực thi và nhận kết quả trả về dưới dạng chuỗi (String/JSON stringified).

---

## 2. Cấu trúc thư mục của Plugin

```
photoshop-plugin/
├── CSXS/
│   └── manifest.xml          # Khai báo cấu hình CEP Extension, Port debug, quyền Node.js
├── index.html                  # Giao diện chính của Panel (HTML5)
├── css/
│   └── style.css               # Giao diện tối (Dark Mode) đồng bộ với Photoshop theme
├── js/
│   ├── CSInterface.js          # Thư viện cầu nối tiêu chuẩn của Adobe CEP
│   ├── main.js                 # Trình điều khiển chính của UI (Event handler, State manager)
│   ├── flow_api.js             # Client gửi nhận gói tin HTTP Google Flow API ngầm
│   └── embedded_server.js      # Server Node.js (HTTP/WS) chạy nền bên trong CEP
├── jsx/
│   └── photoshop.jsx           # Mã nguồn ExtendScript thực thi các tác vụ vẽ/cắt trên Photoshop
├── .debug                      # Cấu hình mở cổng debug Chrome DevTools (cổng 8098)
└── README.md                   # Hướng dẫn cài đặt & sử dụng
```

---

## 3. Kiến trúc luồng xử lý chi tiết (Data Flow & Sequence)

### 3.1 Luồng Đồng bộ Token Xác thực (Auth Token Sync)

Google Flow yêu cầu token OAuth (`ya29.*`) và token reCAPTCHA enterprise để tạo ảnh. Việc lấy token này được xử lý bởi Chrome Extension và gửi về cho Photoshop:

```
┌─────────────────┐       Token & Action       ┌─────────────────┐
│ Google Chrome   ├───────────────────────────>│ CEP Panel       │
│ Extension       │  HTTP /api/sync/status     │ (embedded_server│
│ (GenFill Helper)│                            │  running p8001) │
└─────────────────┘                            └────────┬────────┘
                                                        │
                                                        │ Lưu trữ tạm
                                                        ▼
                                               ┌─────────────────┐
                                               │ flow_api.js     │
                                               │ (Trình gọi API) │
                                               └─────────────────┘
```

1. **`embedded_server.js`** khởi động một server HTTP nhỏ trên cổng `8001` khi mở panel Photoshop.
2. **`GenFill Helper`** (Chrome Extension) chạy ngầm trên trình duyệt, định kỳ gửi các token xác thực (`Authorization` header lấy từ tab Google Flow đang hoạt động) tới endpoint `http://127.0.0.1:8001/sync/status`.
3. Server lưu các token này vào bộ nhớ của panel (`flow_api.js`) để phục vụ các yêu cầu tạo ảnh tiếp theo.

---

### 3.2 Luồng Tạo Generative Fill (Generative Fill Flow)

Khi người dùng bôi chọn một vùng trên Photoshop và nhấn nút **Tạo GenFill**:

```
[Photoshop UI]       [main.js]          [photoshop.jsx]        [flow_api.js]        [Google Flow API]
      │                  │                     │                     │                      │
      │──(Click Tạo)────>│                     │                     │                      │
      │                  │───(evalScript)─────>│                     │                      │
      │                  │   normalizeAndExport│                     │                      │
      │                  │                     │──(Crop/Resize)      │                      │
      │                  │                     │──(Save Temp PNG)    │                      │
      │                  │<──(Trả về tọa độ)───│                     │                      │
      │                  │   {cropX, cropY...} │                     │                      │
      │                  │                     │                     │                      │
      │                  │──────────────────────────────────────────>│                      │
      │                  │   generateFill(prompt, upscale=true)      │                      │
      │                  │                                           │──(Upload source/mask)│
      │                  │                                           │──(Generate request)─>│
      │                  │                                           │<─(Nhận ảnh 1376x768)─│
      │                  │                                           │──(Upscale 4K Req)───>│
      │                  │                                           │<─(Nhận ảnh 4K base64)│
      │                  │<──(Lưu file kết quả kết quả tạm thời)─────│                      │
      │                  │                                                                  │
      │──(Click Apply)──>│                                                                  │
      │                  │───(evalScript)───────────────────────────>│                      │
      │                  │   applyResultAsLayer(path, cropX, cropY, cropW, cropH, prompt)   │
      │                  │                                           │──(Lưu Selection)     │
      │                  │                                           │──(Place Smart Obj)   │
      │                  │                                           │──(Scale & Translate) │
      │                  │                                           │──(Áp Layer Mask)     │
      │                  │<──(Trả về OK)─────────────────────────────│                      │
      ▼                  ▼                                           ▼                      ▼
```

1. **`main.js`** nhận sự kiện, gọi hàm `normalizeAndExport()` trong file **`photoshop.jsx`**.
2. **`photoshop.jsx`** tiến hành trích xuất vùng ảnh gốc bị crop theo tỉ lệ 1376:768 và file mặt nạ mask trắng đen (tương ứng vùng chọn), resize về `1376x768` và lưu thành ảnh tạm trên ổ cứng. Trả về tọa độ crop thực tế.
3. **`main.js`** chuyển tọa độ đó cho **`flow_api.js`**, sau đó gọi API để:
   - Upload ảnh gốc và ảnh mask tạm lên Cloud Media Storage của Google.
   - Gửi yêu cầu sinh ảnh đến mô hình với prompt đã nhập.
   - Khi có kết quả, gửi tiếp yêu cầu Upscale 4K.
   - Tải file ảnh 4K chất lượng cao về máy và lưu tạm.
4. Khi người dùng bấm **Apply** trên giao diện panel:
   - **`main.js`** gọi hàm `applyResultAsLayer()` trong file **`photoshop.jsx`** kèm theo đường dẫn file kết quả và tọa độ crop đã ghi nhớ.
   - **`photoshop.jsx`** sao lưu vùng chọn vào kênh Alpha ẩn, place ảnh kết quả vào canvas làm Smart Object, tự co giãn (scale) và di chuyển (translate) khớp tọa độ pixel-perfect, sau đó nạp lại vùng chọn để tạo Layer Mask bao khít.

---

## 4. Các điểm kỹ thuật nổi bật

- **Node.js Integration**: Nhờ việc cấu hình `<Parameter>--enable-nodejs</Parameter>` trong file `manifest.xml`, JavaScript phía panel chạy được cả code frontend lẫn backend (sử dụng thư viện `fs` để đọc ghi file, `http` để tạo server, `path` để điều khiển đường dẫn thư mục tạm).
- **Action Manager Code**: Sử dụng giao thức cấp thấp của Photoshop (Action Manager) dạng `charIDToTypeID` và `executeAction` để chèn ảnh Smart Object (`Plc `) và tạo Layer Mask (`Mk `). Đây là cách duy nhất để tự động hóa các thao tác phức tạp mà DOM API thông thường của ExtendScript không hỗ trợ.
- **Xử lý bất đồng bộ kết hợp**: CEP sử dụng cơ chế Promise của JS hiện đại để kiểm soát luồng hoạt động mạng và luồng callback của ExtendScript vốn chạy đồng bộ và chậm chạp, giữ cho UI của panel không bao giờ bị đơ (freeze).
- **Remote Debugging**: File `.debug` định cấu hình mở cổng kết nối `8098`. Lập trình viên có thể mở trình duyệt Chrome bình thường truy cập `http://localhost:8098` để debug lỗi Panel Console, kiểm tra Network, và chỉnh sửa CSS giao diện trực tiếp trong thời gian thực.
