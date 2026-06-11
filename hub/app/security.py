"""Identity & authorization.

- verify_google_id_token: cryptographically verify a Google-issued id_token
  (signature via Google's public certs) + check audience (our OAuth client id)
  + workspace domain. This is how the Hub trusts a member's identity WITHOUT
  trusting the desktop client (which runs on the user's own machine).
- issue/decode Hub token: after the first verify, the Hub mints its own
  long-lived session token (JWT) so subsequent calls don't hit Google.
- FastAPI deps: get_current_user, require_roles, plus visible_emails() for
  lead/admin team scoping.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
from typing import Optional

import jwt  # PyJWT
from fastapi import Depends, Header, HTTPException
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import Team, User

log = logging.getLogger("hub.security")

_google_request = google_requests.Request()


class AuthError(Exception):
    """Raised when identity verification fails (mapped to HTTP 401)."""


# ── Google id_token verification ───────────────────────────────────────
def verify_google_id_token(token: str) -> dict:
    """Verify a Google id_token and return its claims. Raises AuthError on
    any failure (bad signature, expired, wrong audience/issuer/domain, or
    unverified email)."""
    try:
        claims = google_id_token.verify_oauth2_token(
            token,
            _google_request,
            audience=None,  # checked manually against our allow-list below
            clock_skew_in_seconds=settings.GOOGLE_CLOCK_SKEW_S,
        )
    except Exception as e:  # noqa: BLE001 — surface a clean message
        raise AuthError(f"id_token không hợp lệ: {e}")

    if claims.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise AuthError("issuer không phải Google")

    aud = claims.get("aud", "")
    if settings.OAUTH_CLIENT_IDS and aud not in settings.OAUTH_CLIENT_IDS:
        raise AuthError("audience (Client ID) không khớp cấu hình Hub (OAUTH_CLIENT_ID)")

    if not claims.get("email_verified", False):
        raise AuthError("email chưa được Google xác minh")

    email = (claims.get("email") or "").lower()
    if "@" not in email:
        raise AuthError("không đọc được email từ token")
    domain = email.rsplit("@", 1)[1]
    if settings.ALLOWED_DOMAIN and domain != settings.ALLOWED_DOMAIN:
        raise AuthError(f"email phải thuộc @{settings.ALLOWED_DOMAIN}")

    return claims


# ── Hub session token (JWT) ────────────────────────────────────────────
def issue_hub_token(email: str) -> tuple[str, datetime]:
    exp = datetime.utcnow() + timedelta(days=settings.HUB_TOKEN_DAYS)
    payload = {"sub": email.lower(), "iat": int(time.time()), "exp": exp}
    token = jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
    return token, exp


def decode_hub_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except Exception as e:  # noqa: BLE001
        raise AuthError(f"Hub token không hợp lệ hoặc đã hết hạn: {e}")


# ── FastAPI dependencies ───────────────────────────────────────────────
def get_current_user(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> User:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Thiếu Hub token (Authorization: Bearer ...)")
    token = authorization[7:].strip()
    try:
        claims = decode_hub_token(token)
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    email = (claims.get("sub") or "").lower()
    user = db.get(User, email)
    if not user or not user.active:
        raise HTTPException(status_code=401, detail="Tài khoản không tồn tại hoặc đã bị khoá")
    return user


def require_roles(*roles: str):
    """Dependency factory — allow only the given roles."""

    def _dep(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="Bạn không đủ quyền cho thao tác này")
        return user

    return _dep


def visible_emails(db: Session, user: User) -> Optional[list[str]]:
    """Emails `user` is allowed to monitor.

    - admin  → None (means ALL members; caller skips the filter)
    - lead   → members of every team this user leads, plus themselves
    - member → only themselves
    """
    if user.role == "admin":
        return None
    if user.role == "lead":
        team_ids = [t.id for t in db.query(Team).filter(Team.lead_email == user.email).all()]
        emails = {user.email}
        if team_ids:
            for u in db.query(User).filter(User.team_id.in_(team_ids)).all():
                emails.add(u.email)
        return sorted(emails)
    return [user.email]
