"""Media storage abstraction — swap between local disk and S3/R2 by config.

Only small artifacts are stored here: image thumbnails (~tens of KB) and
video poster frames. Full-resolution outputs stay on the member's machine.

- LocalDiskStorage: writes under MEDIA_DIR; serves via an HMAC-signed
  /media/<key> URL (capability URL — no auth header needed, so an <img>
  tag in the tool's browser can load it directly).
- S3Storage: any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2,
  GCS-S3). Serves via presigned GET URLs, or a public custom-domain base.

Switch with env STORAGE_BACKEND=local|s3 (see config.py).
"""
from __future__ import annotations

import hashlib
import hmac
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from .config import settings


def safe_key(key: str) -> str:
    """Normalise a storage key — strip traversal, leading slashes, backslashes."""
    key = (key or "").replace("\\", "/").lstrip("/")
    parts = [p for p in key.split("/") if p not in ("", ".", "..")]
    return "/".join(parts)


class StorageBackend(ABC):
    @abstractmethod
    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        """Store bytes under `key`. Returns the normalised key."""

    @abstractmethod
    def url_for(self, key: str, base_url: str = "") -> str:
        """Return a URL a browser can GET directly (signed / presigned)."""


# ── Local disk ─────────────────────────────────────────────────────────
class LocalDiskStorage(StorageBackend):
    def __init__(self) -> None:
        self.root = Path(settings.MEDIA_DIR).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def local_path(self, key: str) -> Path:
        return self.root / safe_key(key)

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        key = safe_key(key)
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return key

    @staticmethod
    def _sign(key: str, exp: int) -> str:
        msg = f"{key}:{exp}".encode("utf-8")
        return hmac.new(settings.jwt_secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()[:32]

    def verify(self, key: str, exp: int, sig: str) -> bool:
        key = safe_key(key)
        try:
            if int(exp) < int(time.time()):
                return False
        except (TypeError, ValueError):
            return False
        return hmac.compare_digest(self._sign(key, int(exp)), sig or "")

    def url_for(self, key: str, base_url: str = "") -> str:
        key = safe_key(key)
        exp = int(time.time()) + settings.SIGNED_URL_TTL
        sig = self._sign(key, exp)
        base = (settings.PUBLIC_BASE_URL or base_url or "").rstrip("/")
        return f"{base}/media/{key}?exp={exp}&sig={sig}"


# ── S3 / R2 / any S3-compatible ────────────────────────────────────────
class S3Storage(StorageBackend):
    def __init__(self) -> None:
        import boto3  # lazy — only required when STORAGE_BACKEND=s3

        self._bucket = settings.S3_BUCKET
        self._public_base = settings.S3_PUBLIC_BASE_URL
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT_URL or None,
            region_name=settings.S3_REGION or None,
            aws_access_key_id=settings.S3_ACCESS_KEY_ID or None,
            aws_secret_access_key=settings.S3_SECRET_ACCESS_KEY or None,
        )

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        key = safe_key(key)
        self._client.put_object(Bucket=self._bucket, Key=key, Body=data, ContentType=content_type)
        return key

    def url_for(self, key: str, base_url: str = "") -> str:
        key = safe_key(key)
        if self._public_base:
            return f"{self._public_base}/{key}"
        return self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": key},
            ExpiresIn=settings.SIGNED_URL_TTL,
        )


_BACKEND: Optional[StorageBackend] = None


def get_storage() -> StorageBackend:
    global _BACKEND
    if _BACKEND is None:
        _BACKEND = S3Storage() if settings.STORAGE_BACKEND == "s3" else LocalDiskStorage()
    return _BACKEND
