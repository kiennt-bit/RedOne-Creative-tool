# RedOne Hub

Dịch vụ quản lý trung tâm cho RedOne Creative tool: **định danh + phân quyền (admin/lead/member) + credit nội bộ + theo dõi task của team**.

> Việc **gen ảnh/video vẫn chạy 100% trên máy mỗi nhân sự** (extension + tài khoản Google/Shakker riêng). Hub **không** gen, **không** giữ tài khoản gen. Hub chỉ là tầng quản lý: ai được dùng, hạn mức bao nhiêu, và lưu metadata + thumbnail để lead theo dõi.

---

## 1. Hub là gì (và KHÔNG là gì)
- **Là**: một API nhỏ (FastAPI) + 1 database, chạy trên server công ty. Có 1 địa chỉ HTTPS (vd `https://hub.redone.vn`) để các máy cài tool kết nối tới.
- **Không phải**: một website cho người dùng. Lead/admin xem team **ngay trong tool** (tab "Team"/"Quản trị"), không có giao diện web riêng.

```
Máy nhân sự (tool, gen LOCAL)  ──HTTPS──►  Hub (server này)
                                            FastAPI + DB + media (đĩa hoặc S3/R2)
```

## 2. Yêu cầu server
- Python **3.10+**.
- Một database: **SQLite** (mặc định, hợp nhóm nhỏ) hoặc **PostgreSQL/MySQL** (khuyến nghị production — chỉ cần đổi `DATABASE_URL`).
- Một địa chỉ HTTPS công khai (subdomain như `hub.redone.vn`, hoặc tên miền/IP khác + reverse proxy TLS). HTTPS là **bắt buộc**.

## 3. Cài đặt nhanh (dev / thử nghiệm)
```bash
cd hub
cp .env.example .env          # rồi sửa .env (xem mục 5)
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8800
# Kiểm tra: GET http://127.0.0.1:8800/health
```
Windows có thể chạy thẳng `run_dev.bat`.

## 4. Chạy production (gợi ý)
- Chạy uvicorn nhiều worker sau một reverse proxy có TLS (nginx/Caddy):
  ```bash
  uvicorn app.main:app --host 127.0.0.1 --port 8800 --workers 4
  ```
- Trỏ `hub.redone.vn` → server này, proxy `https://hub.redone.vn` → `127.0.0.1:8800`, bật Let's Encrypt.
- Đặt biến môi trường (hoặc `.env`) đầy đủ, **bắt buộc** có `HUB_JWT_SECRET` ngẫu nhiên dài.
- Database dùng Postgres: `pip install psycopg2-binary` + `DATABASE_URL=postgresql+psycopg2://...`.

> Lưu ý nhiều worker + SQLite không hợp nhau (khoá ghi). Production nhiều worker → dùng Postgres/MySQL.

## 5. Biến cấu hình (.env)
| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `DATABASE_URL` | có | Chuỗi kết nối SQLAlchemy. Mặc định `sqlite:///./hub.db`. |
| `OAUTH_CLIENT_ID` | có | **Giống hệt** Client ID của tool (`backend/private_config.py` → `OAUTH_CLIENT_ID`). Hub verify `id_token` theo giá trị này. Có thể liệt kê nhiều, cách nhau dấu phẩy. |
| `ALLOWED_DOMAIN` | có | Đuôi email được phép (vd `redone.vn`). |
| `BOOTSTRAP_ADMIN_EMAIL` | nên | Email admin gốc (nhiều thì cách nhau dấu phẩy). Tự thành `admin` khi đăng nhập lần đầu. Đổi/chuyển được sau qua tab Quản trị. |
| `HUB_JWT_SECRET` | có (prod) | Khoá ký token phiên của Hub. Sinh: `python -c "import secrets;print(secrets.token_urlsafe(48))"`. |
| `HUB_TOKEN_DAYS` | không | Hạn token Hub (mặc định 30). |
| `PUBLIC_BASE_URL` | nên | URL công khai của Hub (vd `https://hub.redone.vn`) để dựng link media (storage local). |
| `STORAGE_BACKEND` | không | `local` (đĩa, mặc định) hoặc `s3` (object storage). |
| `MEDIA_DIR` | không | Thư mục lưu media khi `local` (mặc định `./media`). |
| `S3_*` | nếu s3 | Endpoint/region/bucket/key cho S3/R2/B2. `S3_PUBLIC_BASE_URL` tuỳ chọn (domain public). |
| `DEFAULT_QUOTA_LIMIT` | không | Hạn mức mặc định mỗi người, `-1` = không giới hạn. Admin chỉnh từng người sau. |
| `DEFAULT_QUOTA_PERIOD` | không | `daily`/`weekly`/`monthly`/`none`. |

## 6. OAuth — **không cần tạo gì mới trên Google**
Hub **không** tự chạy luồng đăng nhập. Tool đã đăng nhập Google và lấy `id_token`; Hub chỉ **kiểm tra** token đó bằng chứng thư công khai của Google (thư viện `google-auth`) + đối chiếu `aud == OAUTH_CLIENT_ID` + đuôi email `@ALLOWED_DOMAIN`.

→ Vì chỉ *verify*, **không cần** redirect URI mới hay OAuth client mới. Chỉ cần điền `OAUTH_CLIENT_ID` đúng bằng của tool. (Đảm bảo OAuth consent screen để chế độ **Internal** cho workspace.)

## 7. Lưu trữ media
- Hub chỉ nhận **thumbnail ảnh + poster video** (nhẹ), không nhận file gốc.
- `local`: lưu trong `MEDIA_DIR`, phục vụ qua URL ký HMAC (`/media/...?exp&sig`) — hết hạn sau `SIGNED_URL_TTL`.
- `s3`: lưu lên bucket, phục vụ qua presigned URL (hoặc domain public nếu đặt `S3_PUBLIC_BASE_URL`). Cloudflare R2 được khuyến nghị (rẻ, miễn phí băng thông ra).
- Đặt cron/retention xoá media cũ (vd > 30–60 ngày) nếu cần tiết kiệm dung lượng.

## 8. API tóm tắt
| Method & path | Quyền | Việc |
|---|---|---|
| `GET /health` | công khai | Kiểm tra sống. |
| `POST /auth/verify` | (id_token) | Đổi Google `id_token` → Hub token + role/team. |
| `GET /me` | đã đăng nhập | Thông tin + quota còn lại. |
| `POST /events/reserve` | member+ | Xin giữ credit trước khi gen. |
| `POST /events/commit` | member+ | Ghi nhận sau gen + upload thumbnail. |
| `GET /team/tasks` `GET /team/usage` | lead/admin | Task + thống kê của thành viên trong quyền. |
| `POST /admin/users` `/admin/teams` `/admin/quota` `/admin/grant` | admin | CRUD người/team/quota, cấp credit. |

Tài liệu tương tác: `http://<hub>/docs` (Swagger UI).

## 9. Checklist bảo mật
- [ ] `HUB_JWT_SECRET` đặt giá trị ngẫu nhiên (không để trống → tránh secret dev).
- [ ] HTTPS bật ở reverse proxy; không expose `:8800` trần ra internet.
- [ ] `.env`, `*.db`, `media/` đã trong `.gitignore` (sẵn rồi) — không commit.
- [ ] `OAUTH_CLIENT_ID` + `ALLOWED_DOMAIN` khớp tool.
- [ ] DB backup định kỳ (chứa user/role/quota/ledger).
