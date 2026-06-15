"""Symmetric encryption for secrets stored at rest (shared-account credentials).

Uses Fernet (AES-128-CBC + HMAC-SHA256). The key comes from the
`HUB_CREDENTIALS_KEY` env var (a urlsafe-base64 32-byte Fernet key). If that is
unset, a stable key is DERIVED from `HUB_JWT_SECRET` so local dev works out of
the box — set an explicit `HUB_CREDENTIALS_KEY` in production.

Only the shared Google password / Shakker token are encrypted. They are
decrypted only inside lead/admin/member API handlers, never logged.
"""
from __future__ import annotations

import base64
import hashlib
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from .config import settings


def _fernet() -> Fernet:
    raw = (settings.HUB_CREDENTIALS_KEY or "").strip()
    if raw:
        # Prefer a proper 32-byte urlsafe-base64 Fernet key; if the provided
        # value isn't one, derive a valid key from it deterministically.
        try:
            return Fernet(raw.encode("ascii"))
        except Exception:
            digest = hashlib.sha256(raw.encode("utf-8")).digest()
            return Fernet(base64.urlsafe_b64encode(digest))
    # Dev fallback: derive from the JWT secret (which itself warns when default).
    seed = (settings.jwt_secret or "dev").encode("utf-8")
    digest = hashlib.sha256(seed).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(plaintext: Optional[str]) -> Optional[str]:
    """Encrypt a string → token (str). Returns None for None/empty input."""
    if not plaintext:
        return None
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(token: Optional[str]) -> Optional[str]:
    """Decrypt a token → plaintext. Returns None if missing or undecryptable
    (e.g. the key changed) — callers treat None as 'not set'."""
    if not token:
        return None
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, Exception):
        return None
