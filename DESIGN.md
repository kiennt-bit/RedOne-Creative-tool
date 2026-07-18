---
name: RedOne Creative
colors:
  bg-0: "#f7f7f8"
  bg-1: "#ffffff"
  bg-2: "#fafafa"
  bg-3: "#f2f2f4"
  surface: "#ffffff"
  surface-alt: "#f8f8fa"
  border: "#ececef"
  border-strong: "#e0e0e4"
  border-soft: "#f2f2f4"
  text: "#161618"
  text-2: "#2a2a2e"
  text-muted: "#8a8a92"
  brand: "#dc2626"
  brand-2: "#b91c1c"
  brand-soft: "#fee2e2"
  brand-tint: "#fef2f2"
  green: "#10b981"
  green-soft: "#e7f8f1"
  yellow: "#f59e0b"
  yellow-soft: "#fef4e2"
  red: "#dc2626"
  red-soft: "#fee2e2"
  blue: "#3b82f6"
  blue-soft: "#eaf0ff"
  dark:
    bg-0: "#0e0f12"
    bg-1: "#16181d"
    bg-2: "#111316"
    bg-3: "#1d2027"
    surface: "#16181d"
    surface-alt: "#1a1d22"
    border: "#21252c"
    border-strong: "#2a2e36"
    border-soft: "#1d2027"
    text: "#ececef"
    text-2: "#c8c8cc"
    text-muted: "#757882"
    brand: "#ef4444"
    brand-2: "#f87171"
    brand-soft: "rgba(239, 68, 68, 0.14)"
    brand-tint: "rgba(239, 68, 68, 0.06)"
    green-soft: "rgba(16, 185, 129, 0.14)"
    yellow-soft: "rgba(245, 158, 11, 0.14)"
    red-soft: "rgba(239, 68, 68, 0.14)"
    blue-soft: "rgba(59, 130, 246, 0.14)"
typography:
  fontBody: "Inter, system-ui, -apple-system, sans-serif"
  fontMono: "JetBrains Mono, Cascadia Code, monospace"
rounded:
  xs: 6px
  sm: 8px
  md: 10px
  lg: 14px
  xl: 18px
  "2xl": 24px
  full: 999px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 28px
  "7": 40px
  "8": 56px
---

# RedOne Creative Design System

Giao diện của RedOne Creative Tool được xây dựng theo phong cách **Modern Professional Interface** (giao diện chuyên nghiệp, hiện đại, tối giản) với cấu trúc thẻ hộp sạch sẽ, tông đỏ làm điểm nhấn thương hiệu và hỗ trợ chế độ tối (Dark Mode) hoàn chỉnh.

## 1. Nguyên tắc thiết kế (Aesthetic & Style)
*   **Thương hiệu năng động:** Tông đỏ thương hiệu (`--brand`) làm điểm nhấn cho các hành động chính (Primary Call-to-actions), chỉ số trạng thái và tiêu điểm tương tác.
*   **Thiết kế phẳng kết hợp chiều sâu nhẹ:** Sử dụng các đường viền siêu mảnh (`1px`) và đổ bóng mờ nhẹ (`--sh-md`) để tách biệt các lớp thông tin thay vì dùng dải màu chuyển đổi phức tạp.
*   **Tính nhất quán:** Tất cả các thành phần tương tác như nút bấm, ô nhập liệu, và thẻ nội dung đều phải tuân thủ đúng kích thước bo góc (`--r-md` = `10px` là tiêu chuẩn) và khoảng cách nhịp điệu (`8px` làm gốc).

## 2. Hệ thống màu sắc (Colors)
*   **Chế độ sáng (Mặc định):** Sử dụng nền xám rất nhẹ (`#f7f7f8`) làm màu nền trang chính và màu trắng tinh (`#ffffff`) cho các thẻ nội dung để tạo độ tương phản cao, dễ nhìn.
*   **Chế độ tối (Dark Mode):** Sử dụng tông xám đen sâu lắng (`#0e0f12` làm nền chính, `#16181d` làm thẻ) để giảm mỏi mắt khi làm việc trong thời gian dài.
*   **Màu sắc trạng thái:**
    *   **Thành công (Success):** Màu xanh lá (`#10b981`).
    *   **Cảnh báo (Warning):** Màu vàng hổ phách (`#f59e0b`).
    *   **Lỗi (Error):** Màu đỏ (`#dc2626`).

## 3. Font chữ & Hệ thống Chữ (Typography)
*   **Font chữ chính:** `Inter` (Font chữ hiện đại tối ưu hóa cho màn hình kỹ thuật số).
*   **Font chữ mã nguồn/kỹ thuật:** `JetBrains Mono` hoặc `Cascadia Code`.
*   *Quy tắc:*
    *   Tiêu đề lớn (`h1`, `h2`): Cần viết đậm (`font-weight: 600`), kích thước tối thiểu từ `18px` trở lên.
    *   Văn bản phụ (`field-help`): Giảm kích thước xuống `12px` và sử dụng màu chữ nhạt (`--text-muted`) để tạo phân cấp thông tin.

## 4. Đặc tả các thành phần (Component Specifications)
*   **Nút bấm (Buttons):**
    *   *Primary:* Nền màu đỏ `--brand`, chữ trắng. Khi di chuột (`hover`), nền chuyển sang màu đậm hơn `--brand-2`.
    *   *Ghost/Invisible:* Nền trong suốt, viền mờ hoặc không viền, chữ màu `--text-muted`. Chỉ hiện nền nhẹ khi di chuột qua.
*   **Thẻ nội dung (Cards):**
    *   Bo góc đúng `10px`. Viền `1px solid var(--border)`. Đổ bóng mờ nhẹ.
*   **Vùng kéo thả (Dropzones):**
    *   Viền nét đứt (`dashed`) màu `--border-strong`.
    *   Khi di chuột hoặc kéo tệp qua (`dragover`), viền chuyển sang màu thương hiệu `--brand` và đổi nền nhẹ để phản hồi hành động.
*   **Thanh tiến trình (Progress Bars):**
    *   Chiều cao từ `4px` đến `6px`. Nền chứa màu `--border-strong`, thanh chạy (fill) sử dụng màu trạng thái tương ứng (thường là màu thương hiệu `--brand` hoặc màu xanh `--green` khi hoàn tất).
