"""Hub configuration — everything via environment variables (12-factor).

Load order: real process environment first, then a local `.env` file (only
if `python-dotenv` is installed — optional). NOTHING secret is committed to
the repo; the real values live in the deployed `.env` / server environment.

The desktop tool and the Hub MUST agree on two things:
  - OAUTH_CLIENT_ID — same Google OAuth client id the tool logs in with
    (private_config.OAUTH_CLIENT_ID). Used as the id_token audience.
  - ALLOWED_DOMAIN  — same workspace domain (e.g. redone.vn).
"""
from __future__ import annotations

import os

try:  # optional convenience for local dev
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    pass


def _split(csv: str) -> list[str]:
    return [x.strip() for x in (csv or "").split(",") if x.strip()]


class Settings:
    # ── Database ───────────────────────────────────────────────────────
    # DB-agnostic via SQLAlchemy. Examples:
    #   sqlite:///./hub.db                       (local dev — default)
    #   postgresql+psycopg2://user:pw@host/db    (recommended prod)
    #   mysql+pymysql://user:pw@host/db
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./hub.db")

    # ── Auth / identity ────────────────────────────────────────────────
    # Accept multiple client ids (comma-separated) in case the tool ever
    # uses a web + installed client. The id_token's `aud` must be one of these.
    OAUTH_CLIENT_IDS: list[str] = _split(os.getenv("OAUTH_CLIENT_ID", ""))
    ALLOWED_DOMAIN: str = os.getenv("ALLOWED_DOMAIN", "redone.vn").strip().lower()
    # First-run admin(s). Anyone whose email is listed here is upserted as
    # `admin` on login. Can be changed/relinquished later via the admin tab.
    BOOTSTRAP_ADMIN_EMAILS: list[str] = [e.lower() for e in _split(os.getenv("BOOTSTRAP_ADMIN_EMAIL", ""))]
    HUB_JWT_SECRET: str = os.getenv("HUB_JWT_SECRET", "").strip()
    HUB_TOKEN_DAYS: int = int(os.getenv("HUB_TOKEN_DAYS", "30"))
    # Allow clock skew when verifying Google id_tokens (seconds).
    GOOGLE_CLOCK_SKEW_S: int = int(os.getenv("GOOGLE_CLOCK_SKEW_S", "10"))

    # ── Storage (media: thumbnails / video posters) ────────────────────
    STORAGE_BACKEND: str = os.getenv("STORAGE_BACKEND", "local").strip().lower()  # local | s3
    MEDIA_DIR: str = os.getenv("MEDIA_DIR", "./media")
    SIGNED_URL_TTL: int = int(os.getenv("SIGNED_URL_TTL", "86400"))
    # Public base URL of THIS hub (e.g. https://hub.redone.vn). Used to build
    # absolute signed media URLs for the local-disk backend. If empty, the
    # request's own base URL is used at runtime.
    PUBLIC_BASE_URL: str = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    # S3 / Cloudflare R2 / any S3-compatible object storage
    S3_ENDPOINT_URL: str = os.getenv("S3_ENDPOINT_URL", "")
    S3_REGION: str = os.getenv("S3_REGION", "auto")
    S3_BUCKET: str = os.getenv("S3_BUCKET", "")
    S3_ACCESS_KEY_ID: str = os.getenv("S3_ACCESS_KEY_ID", "")
    S3_SECRET_ACCESS_KEY: str = os.getenv("S3_SECRET_ACCESS_KEY", "")
    # Optional: R2/S3 public custom-domain base. If set, media is served via
    # this (object must be public-read) instead of presigned URLs.
    S3_PUBLIC_BASE_URL: str = os.getenv("S3_PUBLIC_BASE_URL", "").rstrip("/")

    # ── Media retention ────────────────────────────────────────────────
    # Auto-delete thumbnails/posters older than N days (0 = keep forever).
    # A periodic sweep runs inside the Hub. For S3/R2 you can also use
    # bucket lifecycle rules instead.
    MEDIA_RETENTION_DAYS: int = int(os.getenv("MEDIA_RETENTION_DAYS", "60"))
    RETENTION_SWEEP_HOURS: int = int(os.getenv("RETENTION_SWEEP_HOURS", "12"))

    # ── Quota defaults (applied when a user has no explicit quota row) ──
    # -1 = unlimited. Admin overrides per-user at runtime via the admin tab.
    DEFAULT_QUOTA_LIMIT: int = int(os.getenv("DEFAULT_QUOTA_LIMIT", "-1"))
    DEFAULT_QUOTA_PERIOD: str = os.getenv("DEFAULT_QUOTA_PERIOD", "monthly").strip().lower()

    # ── Misc ───────────────────────────────────────────────────────────
    CORS_ORIGINS: list[str] = _split(os.getenv("CORS_ORIGINS", "*")) or ["*"]

    @property
    def jwt_secret(self) -> str:
        """Secret used to sign Hub session tokens. Falls back to an insecure
        dev value (with a warning emitted at startup) if unset — set
        HUB_JWT_SECRET in production."""
        return self.HUB_JWT_SECRET or "dev-insecure-secret-change-me"

    @property
    def jwt_secret_is_default(self) -> bool:
        return not self.HUB_JWT_SECRET


settings = Settings()
