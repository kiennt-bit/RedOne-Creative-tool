# 🚀 Cập nhật RedOne Creative Tool & Extension (v1.5.12)

### 🌟 Tính năng mới nổi bật: Tích hợp Topaz Proteus v4 (Enhance MQ) Standalone
* **Đẳng cấp Upscale Video chuẩn Điện ảnh:** Tích hợp trực tiếp thuật toán AI Proteus v4 mới nhất của Topaz Video AI vào mục **Video Upscale** trong Tool RedOne.
* **Hoàn toàn độc lập:** Người dùng **không cần cài đặt phần mềm Topaz Video AI**, không cần cấu hình phức tạp. Bản cập nhật đã đóng gói sẵn đầy đủ engine để mở tool là sử dụng được ngay.
* **Tương thích 100% mọi cấu hình máy:**
  * Máy có card **NVIDIA (RTX / GTX)**: Tự động kích hoạt **TensorRT & NVENC** để đạt tốc độ tối đa của GPU.
  * Máy dùng card **AMD Radeon**: Tự động chuyển sang **DirectML**.
  * Máy dùng card **Intel Arc / đồ họa tích hợp Intel**: Tự động dùng **OpenVINO**.
  * Máy văn phòng không card rời: Tự động chạy chế độ CPU fallback.
* **Không tốn dung lượng ổ cứng:** Cơ chế xử lý luồng trực tiếp (Streaming Pipeline 1 bước), không giải nén hàng triệu file ảnh tạm như các công cụ NCNN cũ.
* **Chuẩn hóa thông số Topaz chính hãng:** Tích hợp bộ ước lượng tự động Auto-estimate (`estimate=8` qua `prap-3`), khử ảo giác vi mô Recover detail 20% (`blend=0.2`), liên kết trực tiếp thanh trượt Khử nhiễu (Denoise) trên giao diện để triệt tiêu hoàn toàn các hạt nhiễu trắng trên video 4K.
* **Chuẩn hóa độ phân giải UHD:** Xuất video đúng kích thước chuẩn 4K (3840x2160), 2K (2560x1440), FHD (1920x1080) theo tỷ lệ khung hình gốc (không bị phóng đại vỡ nét).
* **Bảo mật & Offline 100%:** Toàn bộ quá trình xử lý diễn ra cục bộ trên máy, hoàn toàn không gửi bất kỳ video, hình ảnh hay thông tin người dùng nào lên server.

---

### 📊 Tính năng mới: Tracking Sử Dụng "Upscale Video AI"
* **Ghi nhận tự động vào Cloud Firestore:** Theo dõi toàn diện hành vi người dùng khi thực hiện upscale video (số lượng video upscale, model sử dụng như Topaz Proteus hay Real-ESRGAN, độ phân giải, tên video).
* **Bảng điều khiển Tracking Admin:**
  * Thẻ tổng kết `⚡ Upscale Video` trực quan trên thanh số liệu thống kê.
  * Cột `Upscale` trong bảng danh sách người dùng hiển thị số lượt kèm tooltip chi tiết model.
  * Bảng chi tiết 30 ngày (Daily Breakdown) và thông tin lần upscale gần nhất của từng thành viên trong pop-up thông tin.

---

### 📥 Cách cập nhật:
1. **Với Tool:** Tải bản cập nhật mới nhất (hoặc cập nhật tự động trong Tool). Đã bao gồm sẵn bộ engine Topaz Proteus trong thư mục `addons/tvai-engine/`.
2. **Với Extension:** Phiên bản v1.5.12 được cập nhật đồng bộ. Vào `chrome://extensions/` ➔ Bấm **Cập nhật** (hoặc nạp thư mục `extension/`).

