# 📘 RedOne Creative — Hướng dẫn sử dụng

> Tool tạo **ảnh & video AI** (Google Veo 3.1 + Nano Banana) cho nội bộ RedOne.
>
> **Phiên bản:** v1.1.3 · **Hệ điều hành:** Windows 10/11

---

## 📑 Mục lục

1. [Cài đặt & chạy tool](#1-cài-đặt--chạy-tool)
2. [Đăng nhập (bắt buộc — email @redone.vn)](#2-đăng-nhập-bắt-buộc--email-redonevn)
3. [Hai chế độ tạo: Vertex AI vs Extension Bridge](#3-hai-chế-độ-tạo)
4. [Tạo ảnh AI](#4-tạo-ảnh-ai)
5. [Tạo video (Text→Video & Image→Video)](#5-tạo-video)
6. [Khi gặp lỗi: thông báo & Gen lại](#6-khi-gặp-lỗi-thông-báo--gen-lại)
7. [Quản lý task & tải file](#7-quản-lý-task--tải-file)
8. [Cài đặt](#8-cài-đặt)
9. [(Tùy chọn) Bật Extension Bridge để dùng quota miễn phí](#9-tùy-chọn-bật-extension-bridge)
10. [Cập nhật tool](#10-cập-nhật-tool)
11. [Lỗi thường gặp](#11-lỗi-thường-gặp)
12. [Liên hệ / Báo lỗi](#12-liên-hệ--báo-lỗi)

---

## 1. Cài đặt & chạy tool

### Yêu cầu
- Windows 10 hoặc 11
- Kết nối internet ổn định
- Một tài khoản Google **@redone.vn** (để đăng nhập tool)
- Google Chrome — chỉ **bắt buộc nếu** dùng chế độ Extension Bridge (xem mục 9)

### Tải về và chạy

1. Vào https://github.com/kiennt-bit/RedOne-Creative-tool/releases
2. Tải file `RedOne-Creative-vX.X.X-win64.zip` ở mục **Latest release**
3. **Chuột phải** vào file zip → **Extract All…** (BẮT BUỘC giải nén, đừng chạy trong zip)
4. Mở folder vừa giải nén → **double-click `RedOne Creative.exe`**
5. Đợi 5–10 giây → trình duyệt mặc định tự mở `http://127.0.0.1:8000`

⚠️ **Windows Defender chặn** → bấm **More info → Run anyway**.
⚠️ **Báo `python***.dll missing`** → bạn chưa giải nén hoặc đã kéo `.exe` ra khỏi folder. Giải nén lại đầy đủ, chạy `.exe` **từ trong** folder.
⚠️ **Báo `MSVCP140.dll missing`** → cài Visual C++ Redistributable: https://aka.ms/vs/17/release/vc_redist.x64.exe

---

## 2. Đăng nhập (bắt buộc — email @redone.vn)

Ngay khi mở, tool sẽ hiện **trang đăng nhập**. Đây là cổng bảo vệ: **chỉ tài khoản Google có đuôi `@redone.vn`** mới vào được.

1. Bấm **"Đăng nhập với Google"**
2. Chọn / nhập tài khoản Google công ty (`...@redone.vn`)
3. Cho phép quyền → tool tự quay lại và mở giao diện chính

✅ Phiên đăng nhập giữ **30 ngày** — không phải đăng nhập lại mỗi lần mở.
❌ Đăng nhập bằng Gmail thường (không phải @redone.vn) → bị từ chối.

> 💡 Ngay sau khi đăng nhập, tool **tự quét lại tín dụng + trạng thái** các tài khoản đã lưu (nếu có) — bạn không cần bấm "Check" thủ công.

---

## 3. Hai chế độ tạo

Tool có thể tạo ảnh/video theo **một trong hai** chế độ (đổi trong **Cài Đặt → Auth mode**):

| | **Vertex AI (Commercial)** | **Chrome Extension Bridge** |
|---|---|---|
| **Chi phí** | Trả phí theo lượt (Google Cloud) | **Miễn phí** (quota Google Labs Flow/ngày) |
| **Cần làm gì** | **Không cần gì** — dùng ngay sau khi đăng nhập | Cài extension + login Google trong Chrome thật (mục 9) |
| **Cần thêm account Google?** | Không | Có (account riêng cho Labs Flow) |
| **Giới hạn** | Theo ngân sách Cloud (không giới hạn lượt/ngày) | Hết quota/ngày → lỗi 429; thỉnh thoảng bị 403 |
| **Model video** | Veo 3.1 Lite / Fast / Quality | Lite / Fast / Quality / **Lite [LP]** / **Omni Flash** |

### 🎯 Bản phân phối nội bộ mặc định chạy **Vertex AI**

Bản EXE phát cho nội bộ đã **nhúng sẵn credentials** → **mở tool, đăng nhập @redone.vn là tạo được ảnh/video ngay**, **không cần** thêm tài khoản hay cài gì thêm. Đây là chế độ khuyến nghị.

> 💰 **Lưu ý chi phí:** Vertex AI tính tiền theo lượt và **mọi máy đều đổ về 1 project Google Cloud của công ty**. Tham khảo bảng giá từng model trong `docs/` (Nano Banana, Veo 3.1). Dùng tiết kiệm, ưu tiên model rẻ (Flash / Veo Lite) cho bản nháp.

Chỉ chuyển sang **Extension Bridge** nếu muốn xài quota **miễn phí** của Labs Flow (xem mục 9).

---

## 4. Tạo ảnh AI

### 4.1. Mở tab **Tạo Ảnh** (sidebar → nhóm SÁNG TẠO)

### 4.2. Cấu hình (panel trái)

| Mục | Lựa chọn |
|---|---|
| **Tên task** | Vd: `chan_dung_studio` → file lưu ở `outputs/image/<ngày>/chan_dung_studio/` |
| **Model** | **Nano Banana 2** (nhanh, rẻ) hoặc **Nano Banana Pro** (chất lượng cao hơn) |
| **Tỉ lệ** | `1:1`, `16:9`, `9:16`, `4:3`, `3:4` |
| **Số ảnh / prompt** | 1–8 (vd 1 prompt × 4 = 4 biến thể) |
| **Số luồng song song** | 1–3 |
| **Ảnh tham chiếu** | (tùy chọn) kéo thả ảnh để model bám phong cách/nhân vật |

### 4.3. Nhập prompt (panel phải)

- **Bulk paste**: dán nhiều prompt, cách nhau **1 dòng trắng** → bấm **Áp dụng**
- **Từng dòng**: bấm **+ Thêm prompt**
- **Import .txt**: mỗi dòng = 1 prompt

> ✍️ **Quan trọng:** viết prompt **mô tả ảnh cụ thể** (chủ thể, bối cảnh, phong cách). Prompt quá ngắn / kiểu chào hỏi ("xin chào", "test") sẽ bị model hiểu là hội thoại và **không ra ảnh**.
> Ví dụ tốt: `một con mèo tam thể ngồi trên ghế sofa, phong cách ảnh chụp thật, ánh sáng studio`.

### 4.4. Bấm **Tạo ảnh**

Gallery bên phải hiện các card: **Đang chờ → Đang tạo → Hoàn thành**. Mỗi ảnh xong hiện thumbnail (click để zoom), có nút **Tải** + **Copy prompt**.

File lưu ở `outputs\image\<ngày>\<tên_task>\item_X.png` (mặc định auto-lưu).

### 4.5. Tải về 2K / 4K (Upscale)

*Chỉ hoạt động ở chế độ Extension Bridge (Labs Flow).* Tick ảnh → toolbar hiện **Tải về 2K / 4K**. (Vertex AI mode hiện chưa hỗ trợ upscale — gen lại ở Nano Banana Pro nếu cần độ phân giải cao.)

---

## 5. Tạo video

### 5.1. Tab **Tạo Video** → chọn **Text → Video** hoặc **Image → Video**

### 5.2. Cấu hình

| Mục | Lựa chọn |
|---|---|
| **Model** | **Lite** (rẻ nhất) · **Fast** (cân bằng) · **Quality** (đẹp nhất) — đều là Veo 3.1. *(Lite [LP] / Omni Flash chỉ có ở Extension Bridge.)* |
| **Tỉ lệ** | `16:9` (ngang) hoặc `9:16` (dọc) |
| **Độ dài** | tối đa 8 giây / clip |
| **Số luồng song song** | 1–3 |

### 5.3. Text → Video (T2V)

Nhập prompt (giống tạo ảnh). Mẹo cho Veo: ưu tiên tiếng Anh, mô tả **shot type + camera move + scene + style**.
Ví dụ: `Medium shot, static camera, a woman in red dress walking through autumn forest, cinematic lighting`.

### 5.4. Image → Video (I2V)

1. Kéo thả **nhiều ảnh** vào dropzone (mỗi ảnh = 1 video, tự đánh số #1, #2…)
2. Kéo-thả để đổi thứ tự nếu cần
3. Nhập prompt theo thứ tự ảnh (Ảnh #1 ↔ Prompt #1), hoặc 1 prompt dùng chung cho tất cả

### 5.5. Bấm **Bắt đầu render**

Mỗi video ~30–90 giây. Xong sẽ có **player ngay trong card** + nút **Tải** (MP4). File ở `outputs\video\<ngày>\<tên_task>\item_X.mp4`.

> ⏳ Giữa mỗi đợt gen, tool **nghỉ ngẫu nhiên 5–10 giây** (chỉnh được ở Cài đặt) để tránh bị Google rate-limit.

---

## 6. Khi gặp lỗi: thông báo & Gen lại

Tool **không hủy hàng loạt** khi 1 prompt lỗi — mỗi prompt chạy độc lập, lỗi cái nào chỉ cái đó.

### 6.1. Thông báo lỗi rõ ràng

Card lỗi hiện **thông báo tiếng Việt dễ hiểu** (rê chuột để xem chi tiết kỹ thuật). Các lỗi hay gặp:

| Thông báo | Ý nghĩa | Cách xử lý |
|---|---|---|
| "Hết lượt tạo… hôm nay" | Hết quota free (chỉ ở Bridge mode) | Đổi tài khoản, hoặc chuyển sang Vertex AI, hoặc đợi mai |
| "Google tạm chặn… (reCAPTCHA)" | Bị nghi bot (Bridge mode) | Thử lại sau vài phút / đổi account |
| "Nội dung bị Google chặn (chính sách)" | Prompt/ảnh nhạy cảm, người thật, bản quyền | Sửa prompt trung tính hơn |
| "Phiên đăng nhập… hết hạn" | Account Labs Flow hết session | Login lại ở tab Tài Khoản |
| "prompt quá ngắn / giống lời chào" | Model hiểu là hội thoại | Mô tả ảnh cụ thể hơn |
| "Veo chặn nội dung (RAI)…" | Bộ lọc an toàn video chặn | Bỏ người thật/bạo lực/brand trong prompt |

### 6.2. Gen lại

- **Gen lại 1 prompt**: trên card lỗi có nút **🔄 Gen lại** → tạo lại đúng prompt đó.
- **Gen lại tất cả lỗi**: nút **"Gen lại N lỗi"** ở đầu khu Kết quả → chạy lại mọi prompt lỗi.
- ✅ Cả hai **hoạt động ngay cả khi task chưa chạy xong** — không phải đợi hoàn tất. Các prompt đã thành công được giữ nguyên.

---

## 7. Quản lý task & tải file

### 7.1. Tab **Quản lý Task** (sidebar → Hệ Thống)

Bảng liệt kê mọi task: tên, loại (Ảnh/Video), trạng thái, tiến độ, thời gian. Mỗi dòng có:
- 📁 **Mở folder** — mở thư mục output trong File Explorer
- 👁 **Xem** — nhảy tới trang tạo với đúng task đó
- 🔄 **Retry** — chạy lại task lỗi/hủy (giữ item đã xong)
- ⏹ **Hủy** — dừng task đang chạy

### 7.2. Đa-chọn trên gallery

Tick checkbox góc các card → toolbar hiện: **Tải về đã chọn** (zip nếu >1), **Bỏ khỏi danh sách** (file vẫn còn trên đĩa), và (tab Video) **Xóa watermark**.

### 7.3. Xóa danh sách

Nút **Xóa danh sách** xóa các task khỏi giao diện (file trong `outputs\` **không** bị xóa). Hữu ích khi danh sách cũ load chậm/ảnh hỏng.

---

## 8. Cài đặt

Sidebar → **Hệ Thống → Cài Đặt**.

| Setting | Tác dụng |
|---|---|
| **Auth mode** | **Vertex AI (Commercial)** — dùng ngay, trả phí · **Chrome Extension Bridge** — free, cần cài extension · **Playwright (Legacy)** — dự phòng |
| **Vertex AI** (project, service account) | Bản nội bộ đã điền sẵn — không cần đụng |
| **Khoảng nghỉ giữa các đợt gen** | Random min–max giây (mặc định 5–10s) |
| **Tỉ lệ / Chất lượng mặc định** | Áp dụng khi mở trang mới |
| **Tự lưu vào outputs/** | Bật = lưu vĩnh viễn; Tắt = lưu tạm (tự xóa sau 24h) |
| **Kiểm tra cập nhật** | Kiểm tra bản mới trên GitHub |

---

## 9. (Tùy chọn) Bật Extension Bridge

Dùng khi muốn xài **quota miễn phí** của Google Labs Flow thay vì trả phí Vertex.

1. Sau khi giải nén zip, mở folder **`extension\`** kèm theo
2. Mở **Chrome thật** → `chrome://extensions/` → bật **Developer mode**
3. Bấm **Load unpacked** → chọn folder `extension\` → extension **"RedOne Auth Helper"** (icon R đỏ) xuất hiện
4. Mở tab https://labs.google/fx/tools/flow → **đăng nhập Google** (account muốn dùng để gen free)
5. Trong tool: **Cài Đặt → Auth mode → Chrome Extension Bridge → Lưu**
6. Vào tab **Tài Khoản → + Thêm account** (nhập email account vừa login) → bấm **Check** để nạp tín dụng

Từ đó các task gen sẽ đi qua Chrome thật của bạn → request giống người dùng thật → ít bị 403.

> Mỗi máy độc lập, cookies không sync giữa máy (cố ý — tránh Google detect 1 account dùng nhiều máy).

---

## 10. Cập nhật tool

- Tool tự kiểm tra bản mới trên GitHub. Khi có, hiện **banner cập nhật** (trong ~5 phút, hoặc bấm Cài Đặt → "Kiểm tra cập nhật").
- Bấm **"Tải xuống & cài đặt"** → tool tự tải zip, giải nén, cài đè và khởi động lại.
- **`data\` và `outputs\` được giữ nguyên** → tài khoản, cài đặt, ảnh/video đã tạo không mất.

---

## 11. Lỗi thường gặp

| Lỗi | Cách fix |
|---|---|
| `python***.dll missing` / `MSVCP140.dll missing` | Giải nén zip đầy đủ + cài VC++ Redist (link ở mục 1) |
| Đăng nhập bị từ chối | Phải dùng email **@redone.vn**, không phải Gmail thường |
| Ảnh ra **chữ thay vì hình** | Prompt quá ngắn/giống lời chào → mô tả ảnh cụ thể hơn |
| "Hết lượt tạo hôm nay" (429) | Đang ở Bridge mode → đổi account / chuyển Vertex / đợi mai |
| Video báo "Veo chặn nội dung (RAI)" | Bỏ người thật, bạo lực, logo/brand khỏi prompt |
| Vertex báo 403 / thiếu quyền | Báo admin kiểm tra service account / project Cloud |
| Banner cập nhật không hiện | Đợi 5 phút (cache) hoặc bấm "Kiểm tra cập nhật" |
| Port 8000 đang bận | Có instance khác đang chạy → tắt qua Task Manager (`RedOne Creative.exe`) |
| Ảnh cũ hiện lỗi/404 trong gallery | Bấm **Xóa danh sách** (file gốc không bị xóa) |

### Log file
Mọi log ở `data\app.log` (cùng folder exe). Báo lỗi cho dev: gửi **50 dòng cuối** file này.

---

## 12. Liên hệ / Báo lỗi

- **GitHub**: https://github.com/kiennt-bit/RedOne-Creative-tool
- **Issues**: https://github.com/kiennt-bit/RedOne-Creative-tool/issues
- **Releases**: https://github.com/kiennt-bit/RedOne-Creative-tool/releases

Khi báo lỗi kèm: (1) version tool (Cài Đặt → About), (2) 50 dòng cuối `data\app.log`, (3) screenshot lỗi, (4) các bước trước khi gặp lỗi.
