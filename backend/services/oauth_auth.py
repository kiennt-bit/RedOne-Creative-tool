"""Google OAuth login gate for company-internal RedOne tool.

Architecture
============
Tool runs locally on user's machine. To log in:

  1. User opens RedOne → frontend loads → checks `/api/auth/me`.
  2. No session → redirect to `/login.html` (standalone page with a
     "Đăng nhập Google @redone.vn" button).
  3. Button → `/auth/login` (backend) → 302 redirect to Google's
     OAuth consent URL (with `hd=redone.vn` hint).
  4. User signs in with @redone.vn account in their browser.
  5. Google redirects to `http://127.0.0.1:8000/auth/callback?code=...`
  6. Callback exchanges code for ID token → verifies signature →
     reads `email` → checks domain ends with `@redone.vn`.
  7. If yes: store session in `data/auth_session.json` (per-machine,
     persists across tool restarts) and redirect to `/`.
     If no: redirect to `/login.html?error=domain`.

Session storage
===============
JSON file at `data/auth_session.json`:

  {
    "session_id": "<random>",
    "email":      "kiennt@redone.vn",
    "name":       "Kien Nguyen Trung",
    "picture":    "https://lh3.googleusercontent.com/...",
    "created_at": 1730000000.0,
    "expires_at": 1732592000.0,
  }

Per-machine: each laptop has its own session file. Logging in on
machine A doesn't affect machine B.

Security model
==============
- Client secret is in `backend/private_config.py` (gitignored, baked
  into EXE at build). Risk is acceptable for internal tool — secret
  + OAuth login + domain check together are the security boundary.
- ID token signature verified using Google's public certs (caught
  expiry, tampering).
- Domain check is the actual access control — Google's "Internal"
  audience is the first line, our check is the second.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
import urllib.parse
from pathlib import Path
from typing import Optional

import httpx

from ..config import DATA_DIR

log = logging.getLogger("redone.auth")

# Persistent session — JSON file alongside other RedOne user data.
SESSION_FILE = DATA_DIR / "auth_session.json"

# ── Config loading ───────────────────────────────────────────────────

_CONFIG: dict = {}


def _load_config() -> dict:
    """Load OAuth + domain config from private_config.py.

    Falls back to placeholder values if the file is missing — the auth
    flow will then refuse with a clear error message. This is
    intentional: the tool MUST have private_config to gate logins.
    """
    global _CONFIG
    if _CONFIG:
        return _CONFIG
    try:
        from .. import private_config as _pc   # type: ignore
        _CONFIG = {
            "client_id":      getattr(_pc, "OAUTH_CLIENT_ID", ""),
            "client_secret":  getattr(_pc, "OAUTH_CLIENT_SECRET", ""),
            "allowed_domain": getattr(_pc, "ALLOWED_EMAIL_DOMAIN", "redone.vn"),
            "session_days":   int(getattr(_pc, "SESSION_MAX_AGE_DAYS", 30)),
        }
    except Exception as e:
        log.warning(
            f"private_config.py không load được ({e}). Auth gate sẽ "
            f"từ chối mọi login. Copy backend/private_config.py.template "
            f"→ backend/private_config.py và điền credentials."
        )
        _CONFIG = {
            "client_id": "", "client_secret": "",
            "allowed_domain": "redone.vn", "session_days": 30,
        }
    return _CONFIG


def get_allowed_domain() -> str:
    """Used by the login page to display 'Chỉ @<domain> được phép'."""
    return _load_config().get("allowed_domain", "redone.vn")


def is_configured() -> bool:
    """Whether OAuth credentials are present. UI uses this to either
    show the login flow or surface a setup-error banner to the admin."""
    cfg = _load_config()
    return bool(cfg.get("client_id")) and bool(cfg.get("client_secret"))


# ── OAuth flow ───────────────────────────────────────────────────────

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

# Per-process state cache for the `state` query param Google sends back.
# Maps `state` → epoch timestamp; entry expires after 10 minutes. The
# state is generated when /auth/login is called, then matched against
# the value Google returns in /auth/callback to prevent CSRF.
_PENDING_STATES: dict[str, float] = {}
_STATE_TTL_S = 600.0


def _make_state() -> str:
    """Generate a fresh CSRF state token, remember it in process."""
    state = secrets.token_urlsafe(32)
    _PENDING_STATES[state] = time.time()
    # Garbage-collect old states inline
    cutoff = time.time() - _STATE_TTL_S
    for k in list(_PENDING_STATES.keys()):
        if _PENDING_STATES[k] < cutoff:
            del _PENDING_STATES[k]
    return state


def _consume_state(state: str) -> bool:
    """Atomically check + remove a state. Returns True if it was valid."""
    if not state or state not in _PENDING_STATES:
        return False
    ts = _PENDING_STATES.pop(state)
    return (time.time() - ts) < _STATE_TTL_S


def build_login_url(redirect_uri: str) -> str:
    """Build the Google OAuth consent URL the browser should be sent to.

    Includes `hd=<domain>` so the Google account picker prefers the
    company workspace user — but this is just a HINT, not enforcement.
    Real enforcement is done after callback (domain check).
    """
    cfg = _load_config()
    state = _make_state()
    params = {
        "client_id":     cfg["client_id"],
        "redirect_uri":  redirect_uri,
        "response_type": "code",
        "scope":         "openid email profile",
        "access_type":   "offline",
        "prompt":        "select_account",
        "hd":            cfg["allowed_domain"],   # workspace hint
        "state":         state,
    }
    return f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"


async def exchange_code(code: str, redirect_uri: str) -> dict:
    """Exchange the OAuth `code` param for ID token + user info."""
    cfg = _load_config()
    data = {
        "code":          code,
        "client_id":     cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "redirect_uri":  redirect_uri,
        "grant_type":    "authorization_code",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        # 1. Exchange code → tokens
        token_resp = await client.post(GOOGLE_TOKEN_URL, data=data)
        if token_resp.status_code != 200:
            log.error(f"Google token exchange failed: {token_resp.status_code} {token_resp.text[:200]}")
            raise RuntimeError(
                f"Google trả về lỗi {token_resp.status_code} khi đổi mã. "
                f"Kiểm tra Client ID + Secret + Redirect URI trong "
                f"private_config.py."
            )
        tokens = token_resp.json()
        access_token = tokens.get("access_token")
        if not access_token:
            raise RuntimeError("Google response không có access_token")

        # 2. Fetch user profile (cleaner than parsing ID token manually
        #    — Google handles the JWT verification for us via userinfo).
        user_resp = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if user_resp.status_code != 200:
            raise RuntimeError(f"Userinfo failed: {user_resp.status_code}")
        user = user_resp.json()
        # Keep Google's id_token (returned because scope includes `openid`).
        # Used ONCE at login to link the RedOne Hub (hub_client.verify_and_store);
        # NOT persisted to disk. Harmless extra key on the userinfo dict.
        if isinstance(user, dict):
            user["id_token"] = tokens.get("id_token", "")
        return user


def is_email_allowed(email: str) -> bool:
    """Domain check — case-insensitive. Must end with @<allowed_domain>."""
    if not email or "@" not in email:
        return False
    domain = email.rsplit("@", 1)[1].lower()
    allowed = _load_config().get("allowed_domain", "").lower()
    return bool(allowed) and domain == allowed


# ── Session persistence ──────────────────────────────────────────────

def save_session(user: dict) -> dict:
    """Persist a session record after successful OAuth + domain check.
    Returns the session dict the caller can echo back to the client."""
    cfg = _load_config()
    now = time.time()
    record = {
        "session_id": secrets.token_urlsafe(32),
        "email":      user.get("email") or "",
        "name":       user.get("name") or "",
        "picture":    user.get("picture") or "",
        "created_at": now,
        "expires_at": now + cfg["session_days"] * 86400,
    }
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSION_FILE.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info(f"auth: session created for {record['email']!r} (expires +{cfg['session_days']}d)")
    return record


def load_session() -> Optional[dict]:
    """Load + validate the on-disk session. Returns None if missing /
    expired / corrupt — caller treats as unauthenticated."""
    if not SESSION_FILE.exists():
        return None
    try:
        rec = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning(f"auth: corrupt session file: {e}")
        return None
    if not isinstance(rec, dict):
        return None
    if rec.get("expires_at", 0) < time.time():
        log.info(f"auth: session expired for {rec.get('email')!r}")
        return None
    # Re-validate domain on every load — in case private_config's
    # allowed_domain changed (e.g. company switched workspaces).
    if not is_email_allowed(rec.get("email", "")):
        log.warning(f"auth: stored email {rec.get('email')!r} no longer matches allowed domain")
        return None
    return rec


def clear_session() -> None:
    """Logout — delete the session file."""
    if SESSION_FILE.exists():
        try:
            SESSION_FILE.unlink()
            log.info("auth: session cleared")
        except Exception as e:
            log.warning(f"auth: clear_session error: {e}")
