# 🚀 Cập nhật RedOne Creative Tool & Extension (v1.6.0)

### 🌟 Tính năng & Cải tiến nổi bật:

#### 1. 🔑 Đồng bộ & Bảo lưu Multi-Account Google Flow (`/u/X/` & `authuser`)
* **Không còn tình trạng bị đá về tài khoản Free/Default:** Toàn bộ quá trình điều hướng dự án (`init_flow_project`) và lệnh gọi RPC BOQ (`batchexecute`) đều bảo lưu chính xác tiền tố người dùng (ví dụ: `https://flow.google.com/u/1/` của tài khoản Ultra).
* **Tránh lỗi "Không tìm thấy dự án":** Dự án tạo bởi tài khoản Ultra sẽ luôn được mở và thực thi dưới tài khoản Ultra, triệt tiêu hoàn toàn lỗi không tìm thấy dự án do lệch tài khoản giữa Chrome và Tool.
* **Tự động phục hồi trạng thái:** Nếu chẳng may một project cũ trong cache không tồn tại, Extension sẽ tự động đưa tab về trang chủ Flow an toàn thay vì để tab kẹt ở màn hình báo lỗi, đồng thời báo cho Tool tự động liên kết sang dự án hợp lệ khác.

#### 2. ⚡ Thuật toán chọn Tab thông minh (Ưu tiên tuyệt đối tài khoản ULTRA)
* **Nhận diện Tab ưu tiên cao:** Thuật toán xếp hạng tab trong Extension được nâng cấp toàn diện:
  * Tự động chấm điểm ưu tiên cao nhất cho tab có gói đăng ký **ULTRA** hoặc **PRO**.
  * Ưu tiên tab người dùng vừa mở hoặc vừa thao tác gần nhất (`lastAccessed`).
  * Loại trừ và phạt nặng các tab cũ, tab bị lỗi hoặc tab bị Chrome đóng băng (discarded).
* **Làm mới bộ nhớ đệm tài khoản theo từng Tab:** Thông tin tài khoản được lưu riêng cho từng tab và tự động làm mới ngay khi đổi tab, điều hướng URL hoặc đăng xuất.

#### 3. 🎯 Backend tự động tối ưu hóa tài khoản
* Trong mọi luồng xử lý (tạo ảnh đơn, tạo ảnh hàng loạt, video dài, Photoshop GenFill), khi chọn tài khoản từ cơ sở dữ liệu, Tool sẽ **luôn ưu tiên tài khoản ULTRA hàng đầu**, sau đó mới tới PRO và Free.

---

### 📥 Cách cập nhật:
1. **Với Tool:** Khởi động lại Tool RedOne để áp dụng phiên bản `v1.6.0`.
2. **Với Extension:** Vào `chrome://extensions/` ➔ Bật "Chế độ dành cho nhà phát triển" (Developer mode) ➔ Bấm **Cập nhật** (hoặc bấm nút **Tải lại ↻** trên tiện ích **RedOne Auth Helper**).
