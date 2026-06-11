# RedOne Hub — Deploy & chuyển sang nội bộ

Hub đóng gói **Docker + Postgres** nên chạy y hệt ở mọi nơi. Bạn dựng **server thử nghiệm bên ngoài** ngay bây giờ, sau này **chuyển sang server + DB của công ty** chỉ là đổi config + chuyển dữ liệu (mục E).

---

## A. Trial nhanh trên 1 VPS (Docker Compose) — khuyến nghị
Cần: 1 server Linux có Docker (vd Ubuntu: `apt install -y docker.io docker-compose-plugin`).

```bash
git clone https://github.com/kiennt-bit/RedOne-Creative-tool.git
cd RedOne-Creative-tool/hub
cp .env.example .env        # rồi sửa .env (xem dưới)
docker compose up -d --build
curl http://localhost:8800/health     # {"ok":true,...}
```

Sửa `.env` tối thiểu:
| Biến | Giá trị |
|---|---|
| `POSTGRES_PASSWORD` | mật khẩu mạnh bất kỳ |
| `OAUTH_CLIENT_ID` | **đúng** Client ID của tool (`backend/private_config.py`) |
| `BOOTSTRAP_ADMIN_EMAIL` | `kiennt@redone.vn` |
| `HUB_JWT_SECRET` | `openssl rand -base64 48` |
| `PUBLIC_BASE_URL` | `https://hub.redone.vn` (hoặc `http://<ip>:8800` khi test thô) |
| `STORAGE_BACKEND` | `local` (hoặc `s3` + các biến `S3_*`) |

Compose tự dựng Postgres + volume dữ liệu `hub_pgdata` + volume media `hub_media`.

## B. HTTPS (Caddy — gọn nhất)
Trỏ DNS `hub.redone.vn` → IP server, rồi `/etc/caddy/Caddyfile`:
```
hub.redone.vn {
    reverse_proxy 127.0.0.1:8800
}
```
`systemctl reload caddy` → tự cấp Let's Encrypt.

> **Chưa có domain lúc test?** Cloudflare Tunnel: `cloudflared tunnel --url http://localhost:8800` → cho 1 URL `https://...` tạm. Đặt `PUBLIC_BASE_URL` = URL đó.

## C. Hoặc PaaS (Railway / Render / Fly.io) — khỏi quản VPS
Dùng chính `Dockerfile`:
- **Railway/Render**: New → Deploy from repo, root = `hub/`. Thêm **Postgres** add-on → đặt `DATABASE_URL` = chuỗi nó cấp. Điền các biến env còn lại. Platform tự cho URL HTTPS → đặt `PUBLIC_BASE_URL` = URL đó.
- **Fly.io**: trong `hub/` chạy `fly launch` (nhận Dockerfile) + `fly postgres create` + `fly secrets set ...`.

> Trên PaaS đĩa thường **không bền** → dùng `STORAGE_BACKEND=s3` (Cloudflare R2) để media không mất khi restart.

## D. Bật phía tool trỏ vào Hub
- **Test nhanh, KHÔNG build lại exe** — đặt biến môi trường trước khi mở tool:
  ```
  set REDONE_HUB_URL=https://hub.redone.vn        (Windows CMD)
  ```
  Mở tool → đăng nhập → tool tự link (tạo `data/hub_session.json`). Bỏ biến đi là về standalone.
- **Bản phát hành chính thức**: thêm `HUB_BASE_URL = "https://hub.redone.vn"` vào `backend/private_config.py` rồi build exe.

## E. 🔄 Chuyển sang server + DB nội bộ công ty (sau này)
Không có gì khoá cứng vào máy trial — tất cả là config:
1. **Chuyển DB**
   - Dump từ trial: `docker compose exec db pg_dump -U hub redone_hub > hub.sql`
   - Nạp vào DB công ty: `psql "<chuỗi-kết-nối-công-ty>" < hub.sql`
   - (DB trống cũng được — Hub tự tạo bảng khi khởi động.)
2. **Chuyển server**: copy `hub/` + `.env` sang server công ty; sửa `DATABASE_URL` trỏ DB công ty (hoặc giữ Postgres trong compose); `docker compose up -d --build`.
3. **Media**: nếu `local` → copy volume `hub_media` (hoặc thư mục media) sang. Nếu `s3/r2` → khỏi làm gì (đã nằm ngoài server). **Khuyến nghị S3/R2** để media độc lập server.
4. **DNS + tool**: trỏ `hub.redone.vn` sang server mới (hoặc đổi `PUBLIC_BASE_URL` + `REDONE_HUB_URL`/`private_config` sang địa chỉ mới).

## F. Backup
- DB: cron `pg_dump` hằng ngày (chứa user/role/quota/ledger/task_events).
- Media: backup volume `hub_media` (nếu local), hoặc dùng S3/R2 có versioning.

## G. Bảo mật
- HTTPS bắt buộc khi ra internet; **không** mở cổng Postgres (5432) ra ngoài.
- `HUB_JWT_SECRET` ngẫu nhiên; `.env` không commit (đã `.gitignore`).
- `OAUTH_CLIENT_ID` + `ALLOWED_DOMAIN` khớp tool. (Google **không** cần cấu hình gì thêm — Hub chỉ verify token.)
