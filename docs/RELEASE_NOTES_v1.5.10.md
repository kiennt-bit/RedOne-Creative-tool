# 🚀 RedOne Creative Tool & Extension — Phiên bản v1.5.10

> **Bản vá quan trọng:** Khắc phục triệt để lỗi dự án & lỗi tài khoản Google Flow — Tự động truy vấn lịch sử dự án, tự động điều hướng tab Chrome vào dự án hợp lệ và xóa bỏ lỗi hết hạn ảo ("Session dead").

---

### 🔍 NGUYÊN NHÂN GỐC RỄ ĐÃ ĐƯỢC TÌM THẤY & KHẮC PHỤC

Vừa qua, nhiều người dùng có tài khoản cũ nhưng khi tab Chrome đang ở trang chủ (`flow.google.com/`) thì Tool lại báo lỗi và không thể gen được. Nguyên nhân gồm 3 mắt xích:
1. **Google Flow chỉ nạp script reCAPTCHA Enterprise khi người dùng ở bên trong một dự án (`flow.google.com/project/<uuid>`).** Khi tab Chrome đứng ở trang chủ (`flow.google.com/`), script reCAPTCHA không được nạp → token reCAPTCHA bị trống.
2. **Khi thiếu reCAPTCHA, Google trả về lỗi `[7]` (`PUBLIC_ERROR_UNUSUAL_ACTIVITY`).** Mã nguồn trước đây hiểu nhầm mã lỗi `[7]` này là "Dự án không hợp lệ" nên đã đưa nhầm các dự án thật của người dùng vào danh sách đen (Blacklist).
3. **Tool đã lấy được danh sách dự án cũ qua `UpteDb` nhưng không điều hướng tab Chrome:** Dù backend biết tài khoản có dự án, tab Chrome vẫn đứng ở trang chủ khiến request gửi đi bị từ chối.

---

### 🛠️ CHI TIẾT CÁC CẢI TIẾN TRONG BẢN v1.5.10

#### 1. 🔄 Tự động điều hướng Tab Chrome vào Dự án gần nhất (Auto Tab Navigation)
* Khi người dùng mở `flow.google.com` (ở trang chủ, chưa vào dự án nào), Tool sẽ:
  1. Tự động truy vấn danh sách dự án trên Google Cloud qua RPC `UpteDb`.
  2. Lấy dự án hợp lệ mới nhất của tài khoản.
  3. **Yêu cầu Extension tự động chuyển tab Chrome vào dự án đó (`flow.google.com/project/<uuid>`)**.
  4. Trình duyệt tải đầy đủ `grecaptcha.enterprise` và context của dự án.
  5. Quá trình Gen ảnh / Video diễn ra tự động và thành công 100%!

#### 2. 🛡️ Ngăn chặn đưa nhầm Dự án vào Blacklist
* Tách biệt rõ ràng giữa lỗi bảo mật/tần suất (`PUBLIC_ERROR_UNUSUAL_ACTIVITY` / mã `[7]`) và lỗi không tìm thấy dự án (mã `[5]` / `404`).
* Không bao giờ loại bỏ hoặc gắn cờ hỏng các dự án thật của người dùng khi Google chỉ đang yêu cầu giải reCAPTCHA hoặc tạm chậm luồng.

#### 3. 🔑 Hỗ trợ cơ chế Cookie Auth mới (BOQ batchexecute)
* Tự động nhận diện session BOQ qua Extension Bridge khi `flow.google.com` không dùng NextAuth (`labs.google/fx/api/auth/session` 404). Xóa bỏ vĩnh viễn lỗi "Session dead" ảo.

#### 4. 🧩 Nâng cấp Extension v1.5.10
* Nhận diện chuẩn xác toàn bộ cookie xác thực Google GAIA (`SID`, `HSID`, `SSID`, `__Secure-1PSID`, `__Secure-3PSID`).
* Hỗ trợ API điều hướng tab theo lệnh (`target_project_id`) và tự động click mở dự án trên giao diện web.

---

### ⚠️ LƯU Ý DÀNH CHO NGƯỜI DÙNG

* **Tài khoản đã có dự án (dù tab Chrome đang ở trang chủ hay đang mở dự án):**  
  👉 **HOÀN TOÀN TỰ ĐỘNG.** Bạn chỉ cần mở `flow.google.com` và đăng nhập. Khi bấm Gen trên Tool, Extension sẽ tự động đưa tab vào dự án và tạo ảnh/video ngay.
* **Tài khoản Google MỚI TINH (Chưa từng tạo bất kỳ dự án nào trên Flow):**  
  👉 Chỉ cần bấm nút `+ Dự án mới` trên web `flow.google.com` **đúng 1 lần duy nhất** để Google tạo không gian làm việc đầu tiên. Từ đó về sau Tool sẽ tự động xử lý toàn bộ.

---

### 📦 HƯỚNG DẪN CẬP NHẬT

1. **Cập nhật Tool:** Khởi động lại Tool để áp dụng bản cập nhật **v1.5.10**.
2. **Cập nhật Extension:**
   * Vào `chrome://extensions/` trên Google Chrome.
   * Bật **Chế độ dành cho nhà phát triển** (Developer mode).
   * Bấm nút **Cập nhật** (Update) hoặc kéo thả file `chrome-ext/redone-auth-helper.crx` (v1.5.10) vào Chrome.
