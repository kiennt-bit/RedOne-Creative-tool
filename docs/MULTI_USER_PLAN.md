# RedOne Creative — Kế hoạch Hệ thống Đa người dùng (Multi-user)

> Bản kế hoạch kiến trúc. Chưa code. Cập nhật khi chốt thêm chi tiết.

## 1. Mục tiêu
- **Phân quyền**: `admin` / `lead` / `member`.
- **Giới hạn credit nội bộ**: Hub cấp hạn mức cho từng người; mỗi lần gen trừ dần; **enforce phía server** (không tin client).
- **Lead theo dõi team**: lead xem được task của từng thành viên dưới quyền — **metadata + ảnh/video kết quả**.

## 2. Quyết định đã chốt
| Hạng mục | Lựa chọn |
|---|---|
| Ý nghĩa credit | **Credit nội bộ** do Hub cấp (ledger, enforce server) |
| Lead xem gì | Metadata **+ thumbnail/preview** ảnh/video kết quả |
| Hub là gì | **Cách A**: chỉ **API + DB**. Giao diện lead/admin = **tab trong tool hiện tại** (role-gated), KHÔNG xây web riêng |
| Nơi lưu media | **Ổ đĩa server Hub** |
| Hạ tầng | Dùng **server + DB có sẵn** (cần xác định stack — xem §8) |

## 3. Kiến trúc tổng thể
```
Máy thành viên (tool .exe, gen LOCAL)                RedOne Hub (server có sẵn)
  backend FastAPI local 127.0.0.1:8000   ──HTTPS──►  API + DB (nguồn sự thật)
   - Login OAuth @redone.vn                          - users / roles / teams
   - Trước gen: hỏi Hub còn quota?         ◄──────   - quotas + credit_ledger
   - Sau gen: báo cáo + trừ credit + up thumbnail    - task_events (+ thumb)
   - Tab "Team"/"Quản trị" (chỉ lead/admin) ──query► - media trên ổ đĩa
```
**Quan trọng:** việc **gen vẫn 100% chạy local** trên máy mỗi người (extension + tài khoản Google/Shakker riêng của họ). Hub chỉ là tầng quản lý: identity, role, quota, báo cáo. **Tài khoản gen KHÔNG tập trung.**

## 4. Hub (server) — thành phần
- **Ngôn ngữ**: khuyến nghị **FastAPI (Python)** để tái dùng kỹ năng + một phần code của tool. (Sẽ chốt theo stack thật ở §8.)
- **API chính**:
  - `POST /auth/verify` — nhận Google id_token từ tool → xác thực với Google → trả `{email, role, team_id}`.
  - `GET /me/quota` — số credit còn lại của user (theo chu kỳ).
  - `POST /events/reserve` — trước khi gen: xin "giữ chỗ" credit (trả OK/từ chối nếu hết quota).
  - `POST /events/commit` — sau khi gen: ghi task_event + trừ credit + nhận thumbnail upload.
  - `GET /team/tasks` — (lead/admin) liệt kê task thành viên dưới quyền (filter theo người/thời gian/loại).
  - `GET /team/usage` — (lead/admin) thống kê credit đã dùng theo thành viên.
  - `POST /admin/quota`, `/admin/users`, `/admin/teams` — (admin) cấp quota, gán role, lập team.
- **Media**: nhận thumbnail (ảnh) / poster + preview (video) → lưu ổ đĩa (`/media/<team>/<user>/<id>.jpg`) → phục vụ qua URL có token. Có **retention** (vd xoá sau 30–60 ngày) để khỏi đầy đĩa.
- **Bảo mật**: HTTPS bắt buộc; mọi check quota/role làm **phía server**; URL media có token ký; admin/lead chỉ thấy team mình.

## 5. Data model (Hub DB)
| Bảng | Cột chính | Vai trò |
|---|---|---|
| `users` | email (PK), name, role(admin/lead/member), team_id, active, created_at | Danh bạ + phân quyền |
| `teams` | id, name, lead_email | Nhóm + lead |
| `quotas` | email, period(daily/weekly/monthly), limit_credits, used_credits, reset_at | Hạn mức + đã dùng |
| `credit_ledger` | id, email, delta, reason, task_event_id, created_at | Cộng/trừ credit (audit) |
| `task_events` | id, email, team_id, type, model, status, credit_cost, prompt, thumb_url, created_at, finished_at | Lead xem task thành viên |

## 6. Tool desktop — thay đổi (tích hợp)
- **`backend/services/hub_client.py`** (MỚI): module gọi Hub (verify, reserve, commit, upload thumbnail). Local backend làm trung gian → giữ token Google phía server, gom báo cáo 1 chỗ.
- **Login**: sau OAuth (`oauth_auth.py`), gửi id_token lên Hub → lưu `role/team/quota` vào session/local.
- **Trước gen** (các điểm: `generate_image_item` ở `image.py`, `generate_content_item` ở `content.py`, storyboard, shakker, long_video): gọi `reserve` → hết quota thì chặn + báo "Hết credit, liên hệ lead".
- **Sau mỗi item xong**: `commit` (ghi event + trừ credit) + tạo & upload **thumbnail** (ảnh: resize ~480px bằng `image_utils`; video: trích 1 frame + preview). Tái dùng `image_utils.resize_image`.
- **DB local**: thêm cột `user_email` vào bảng `tasks` (gắn người tạo).
- **Role-gated tabs** (Cách A): thêm trang **"Team"** (lead/admin) + **"Quản trị"** (admin) vào `app.js` PAGES + sidebar `index.html`, chỉ hiện theo role lấy từ Hub. Trang gọi `GET /team/tasks`, `/team/usage`, hiển thị task + thumbnail (tái dùng lightbox `openMediaViewer`).

## 7. Lộ trình theo giai đoạn
- **P0 — Dựng Hub**: API skeleton + DB schema + xác thực Google id_token + admin seed user/team/role. Lưu + phục vụ media trên đĩa.
- **P1 — Identity & role**: tool login → Hub trả role/team; ẩn/hiện tính năng + tab theo role. (Chưa enforce credit.)
- **P2 — Báo cáo & dashboard**: tool gửi `task_events` + thumbnail; tab **Team** cho lead xem task + xem kết quả (lightbox).
- **P3 — Giới hạn credit**: `reserve`/`commit` enforce quota; admin/lead cấp quota; tool chặn khi hết.
- **P4 — Hoàn thiện**: thống kê/biểu đồ theo thành viên, retention media, log audit.

## 8. Việc / tài nguyên bạn cần chuẩn bị
1. **Xác định stack server + DB** (đang "chưa rõ"): cần biết server chạy được Python (FastAPI) không, DB là Postgres/MySQL/khác. → quyết định ngôn ngữ Hub. (Cách kiểm tra: hỏi nhà cung cấp / xem panel hosting / lệnh `python3 --version`, `psql --version`.)
2. **Subdomain + HTTPS** cho Hub, vd `hub.redone.vn` (đã có domain `redone.vn`).
3. **OAuth**: cho phép Hub xác thực Google id_token (dùng lại OAuth client `@redone.vn` hiện có).
4. **Dung lượng đĩa + retention** cho media (ảnh ~vài trăm KB/thumb; video preview nặng hơn — chốt giữ bao lâu).
5. **Chính sách quota**: mỗi role/người bao nhiêu credit, chu kỳ reset (ngày/tuần/tháng).
6. **Admin gốc + sơ đồ team**: 1 email admin để seed; danh sách lead ↔ thành viên.

## 9. Rủi ro cần lưu ý
- **Quyền riêng tư**: lead xem prompt + kết quả của thành viên → cần thông báo chính sách nội bộ.
- **Offline**: Hub không kết nối được → chốt hành vi (cho gen tiếp + cache rồi sync, hay chặn). Khuyến nghị: cho gen + sync lại, nhưng quota chỉ enforce khi online.
- **Video preview** tốn băng thông/đĩa hơn ảnh — cân nhắc chỉ upload preview nén (vd 720p) thay vì file gốc.
- **Không tin client**: enforce quota/role tại Hub, không chỉ ở tool.
