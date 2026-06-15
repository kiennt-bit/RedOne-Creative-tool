# 📸 Hướng dẫn chụp screenshots cho HUONG_DAN_SU_DUNG.md

File hướng dẫn (`docs/HUONG_DAN_SU_DUNG.md`) tham chiếu **25 screenshots** trong folder này. Dưới đây là danh sách chính xác từng ảnh cần chụp.

> **Mẹo chụp**: dùng tổ hợp **Win + Shift + S** để chụp vùng tùy chọn, lưu lại với đúng tên file ở cột "File name".

| # | File name | Cảnh cần chụp |
|---|---|---|
| 1 | `01_double_click_exe.png` | Folder `RedOne Creative\` trong File Explorer: hiện file `RedOne Creative.exe` + folder `_internal\`. Đặt chuột chỉ vào file `.exe`. |
| 2 | `02_main_screen.png` | Giao diện chính sau khi tool mở: full màn hình trình duyệt với sidebar đỏ-trắng + topbar + đang ở tab "Tạo Video" |
| 3 | `03_sidebar_accounts.png` | Crop sidebar trái, highlight (khoanh đỏ) nút "Tài Khoản" trong nhóm "HỆ THỐNG" |
| 4 | `04_accounts_empty.png` | Trang Tài khoản khi chưa có account nào. Mũi tên chỉ vào nút "+ Thêm account" góc trên trái |
| 5 | `05_add_account_modal.png` | Popup modal "Thêm Google account" với ô input email + 2 nút Hủy/Thêm |
| 6 | `06_account_card_added.png` | Account card vừa được tạo (chưa có credit), hiển thị email + tier "FREE" + 4 nút action |
| 7 | `07_click_login_button.png` | Account card, khoanh đỏ nút "Login" có icon mắt 👁 |
| 8 | `08_login_confirm.png` | Modal popup "Đăng nhập Google" với mô tả các bước + nút Hủy/OK |
| 9 | `09_chrome_login_window.png` | Cửa sổ Chrome **riêng** vừa bật ở góc trên trái (KHÔNG phải tab tool), đang ở trang `accounts.google.com` |
| 10 | `10_labs_google_flow.png` | Trang Google Labs Flow sau khi login: URL bar có `labs.google/fx/tools/video-fx`, có nút Create hoặc danh sách video |
| 11 | `11_account_with_credit.png` | Account card sau khi bấm Check, hiện số credit > 0 (vd "150 credits") + tier (FREE/ULTRA/PRO) |
| 12 | `12_image_page_overview.png` | Toàn cảnh trang Tạo Ảnh: panel trái config (Tên task, Model, Tỉ lệ, etc.) + panel phải (Prompts + Gallery) |
| 13 | `13_image_prompts_list.png` | Khu Prompts khi có 3-5 prompt rows. Bulk textarea phía trên có nội dung sample 2-3 đoạn cách nhau dòng trắng |
| 14 | `14_image_gallery_generating.png` | Gallery khi đang gen: mix các card — 2 ảnh đã xong (thumbnail), 1 đang tạo (spinner), 2-3 chờ |
| 15 | `15_image_completed_card.png` | Zoom vào 1 card sinh ảnh xong: thumbnail ảnh + chip xanh "Hoàn thành" + 2 nút Tải/Copy URL |
| 16 | `16_video_t2v_overview.png` | Trang Tạo Video tab "Text → Video" active, panel trái config (Model dropdown mở để thấy 4 model Veo 3.1) |
| 17 | `17_video_gallery_rendering.png` | Gallery video khi đang render: 1-2 video có player MP4 (đã xong), vài video đang render (spinner), vài chờ |
| 18 | `18_video_i2v_tab.png` | Tab "Image → Video" đang active (highlight), dropzone "Kéo thả NHIỀU ảnh hoặc bấm để chọn" hiện ra |
| 19 | `19_i2v_multi_images_uploaded.png` | Khu "Ảnh tham chiếu" sau khi upload 5 ảnh: grid 5 thumbnails đánh số đỏ #1-#5 với nút X xóa |
| 20 | `20_i2v_drag_reorder.png` | Đang kéo 1 ảnh thả vào vị trí khác: ảnh source mờ đi (opacity 0.4), ảnh target viền đỏ + scale |
| 21 | `21_i2v_prompts_paired.png` | Khu Prompts ở chế độ I2V: 5 rows, mỗi row có thumbnail ảnh nhỏ bên trái + số thứ tự + textarea prompt riêng |
| 22 | `22_tasks_manager.png` | Toàn cảnh trang Quản lý Task: 4 stat cards trên (Đang chạy/Chờ/Hoàn tất/Lỗi) + bảng task chi tiết |
| 23 | `23_open_folder.png` | File Explorer Windows mở folder `outputs\image\<ngày>\<tên_task>\` chứa 4-5 file PNG (thumbnail view) |
| 24 | `24_multiselect_actions.png` | Gallery với 3 cards có checkbox tích (đỏ), toolbar trên hiện đầy đủ 5 nút (Chọn tất cả / Bỏ chọn / Tải / Lưu / Bỏ) |
| 25 | `25_settings_page.png` | Toàn cảnh trang Cài Đặt: card API Keys + card Hệ thống (có toggle auto-save) + card About + card Logs |

## Quy ước

- **Định dạng**: PNG (tránh JPG để khỏi mờ chữ)
- **Độ phân giải**: tối thiểu 1280px chiều dài (responsive crop OK)
- **Mouse cursor**: bật để user thấy điểm bấm
- **Highlight**: dùng công cụ Snipping Tool có thể vẽ khoanh đỏ tròn (đỡ phải mở Photoshop)

## Cách quy trình share screenshots

1. Chụp tất cả 25 ảnh
2. Lưu vào `docs/screenshots/` với đúng tên file
3. Mở `docs/HUONG_DAN_SU_DUNG.md` → preview Markdown → check ảnh đã hiện đầy đủ
4. Commit + push:
   ```bash
   git add docs/
   git commit -m "docs: add user guide with screenshots"
   git push
   ```

Người dùng có thể đọc trực tiếp trên GitHub:
https://github.com/kiennt-bit/RedOne-Creative-tool/blob/main/docs/HUONG_DAN_SU_DUNG.md
