"""HG Stock API client — handles authentication, file hashing, upload, and
file-info creation for the HG Stock integration.

Upload flow (per HG Stock docs):
1. Authenticate via Client Credentials → Bearer token
2. Compute file hash (3-chunk SHA-256 algorithm)
3. Get presigned URL(s) for upload
4. PUT file data to presigned URL(s)
5. (Multipart only) Confirm upload via complete-multipart-upload
6. Create file-info on HG Stock (title, tags, project, etc.)
"""
from __future__ import annotations

import hashlib
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx

from ..config import (
    HGSTOCK_API_URL,
    HGSTOCK_IDENTITY_URL,
    HGSTOCK_CREDS,
)

log = logging.getLogger("redone.hgstock")

# ── Media type mapping ────────────────────────────────────────────────
MEDIA_EXTENSIONS: dict[str, int] = {}
_IMAGE_EXTS = {"jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "svg"}
_VIDEO_EXTS = {"mp4", "mov", "avi", "mkv", "webm", "flv", "wmv"}
_AUDIO_EXTS = {"mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"}
for _ext in _IMAGE_EXTS:
    MEDIA_EXTENSIONS[_ext] = 0
for _ext in _AUDIO_EXTS:
    MEDIA_EXTENSIONS[_ext] = 1
for _ext in _VIDEO_EXTS:
    MEDIA_EXTENSIONS[_ext] = 2

# Chunk size for the hash function (5 MB — matches HG Stock reference)
HASH_CHUNK_SIZE = 5 * 1024 * 1024


def detect_media_type(file_path: str | Path) -> int:
    """Return HG Stock mediaType: 0=image, 1=audio, 2=video."""
    ext = Path(file_path).suffix.lstrip(".").lower()
    return MEDIA_EXTENSIONS.get(ext, 0)  # default to image


# ── 3-chunk SHA-256 hash (ported from HG Stock C#/TS reference) ──────
def _sha256_latin1(data: bytes) -> str:
    """SHA-256 of raw bytes, returned as hex string."""
    return hashlib.sha256(data).hexdigest()


def _read_chunk(file_data: bytes, start: int, size: int) -> bytes:
    """Read a chunk from file bytes starting at `start`, up to `size` bytes."""
    return file_data[start:start + size]


def compute_file_hash(
    file_path: str | Path,
    chunk_size: int = HASH_CHUNK_SIZE,
) -> str:
    """Compute the HG Stock hash for a file.

    Algorithm (from HG Stock docs):
    - If file > chunk_size * 3: read 3 chunks (start, middle, end),
      SHA-256 each, concatenate hashes, SHA-256 the concatenation.
    - Else: read up to 3 sequential chunks, same logic.
    """
    file_path = Path(file_path)
    file_size = file_path.stat().st_size
    file_data = file_path.read_bytes()
    number_of_chunks = 3
    concatenated_hash = ""

    if file_size > (chunk_size * 3):
        for i in range(number_of_chunks):
            if i == 0:
                start = 0
            elif i == 1:
                start = (file_size // 2) - (chunk_size // 2)
            else:
                start = file_size - chunk_size
            chunk = _read_chunk(file_data, start, chunk_size)
            concatenated_hash += _sha256_latin1(chunk)
    else:
        actual_chunks = min(
            number_of_chunks,
            -(-file_size // chunk_size),  # ceil division
        )
        for i in range(actual_chunks):
            start = i * chunk_size
            chunk = _read_chunk(file_data, start, chunk_size)
            concatenated_hash += _sha256_latin1(chunk)

    return _sha256_latin1(concatenated_hash.encode("iso-8859-1"))


# ── HG Stock API Client ──────────────────────────────────────────────
class HGStockClient:
    """Async client for the HG Stock REST API."""

    def __init__(self) -> None:
        env = HGSTOCK_CREDS.get("env", "dev")
        self._api_url = HGSTOCK_API_URL.get(env, HGSTOCK_API_URL["dev"])
        self._identity_url = HGSTOCK_IDENTITY_URL.get(
            env, HGSTOCK_IDENTITY_URL["dev"],
        )
        self._client_id = HGSTOCK_CREDS.get("client_id", "")
        self._client_secret = HGSTOCK_CREDS.get("client_secret", "")
        self._scope = HGSTOCK_CREDS.get("scope", "")
        self._user_id = HGSTOCK_CREDS.get("user_id", "")
        self._token: str = ""
        self._token_expires: float = 0.0

    def is_configured(self) -> bool:
        """Return True if HG Stock credentials are present."""
        return bool(self._client_id and self._client_secret)

    # ── Authentication ────────────────────────────────────────────────
    async def authenticate(self) -> str:
        """Obtain a Bearer token via Client Credentials flow.

        Caches the token until it expires.
        """
        if self._token and time.time() < self._token_expires:
            return self._token

        url = f"{self._identity_url}/connect/token"
        payload = {
            "grant_type": "client_credentials",
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        }
        if self._scope:
            payload["scope"] = self._scope

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                url,
                data=payload,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if resp.status_code != 200:
                log.error("HGStock auth failed (%s): %s", resp.status_code, resp.text)
                raise RuntimeError(
                    f"HG Stock authentication failed: {resp.status_code}",
                )
            data = resp.json()

        self._token = data.get("access_token", "")
        expires_in = data.get("expires_in", 3600)
        self._token_expires = time.time() + expires_in - 60  # 1-min buffer
        log.info("HGStock auth OK, token expires in %ss", expires_in)
        return self._token

    def _headers(self, token: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Time-Zone": "Asia/Bangkok",
        }

    def _user_params(self) -> dict[str, str]:
        """Query params for Client Credentials flow (userId required)."""
        if self._user_id:
            return {"userId": self._user_id}
        return {}

    # ── Step 1: Get presigned URL ─────────────────────────────────────
    async def get_presigned_url(
        self,
        folder_id: str,
        file_name: str,
        file_extension: str,
        media_type: int,
        file_hash: str,
        file_size: int | None = None,
    ) -> dict[str, Any]:
        """Request presigned URL(s) for uploading a file."""
        token = await self.authenticate()
        url = f"{self._api_url}/api/v1/external/get-presigned-url"
        body: dict[str, Any] = {
            "folderId": folder_id,
            "fileName": file_name,
            "fileExtension": file_extension,
            "mediaType": media_type,
            "hash": file_hash,
        }
        if file_size and file_size > 2 * 1024 * 1024 * 1024:
            body["size"] = file_size

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                url,
                json=body,
                headers=self._headers(token),
                params=self._user_params(),
            )
            if resp.status_code != 200:
                log.error("get-presigned-url failed (%s): %s", resp.status_code, resp.text)
                raise RuntimeError(f"get-presigned-url: {resp.status_code}")
            return resp.json()

    # ── Step 2: Upload file to presigned URL ──────────────────────────
    async def upload_normal(
        self,
        presigned_url: str,
        file_path: str | Path,
        on_progress: Any = None,
    ) -> str | None:
        """Upload file via single presigned URL (normal upload).

        Returns the ETag from the response header (if any).
        """
        file_path = Path(file_path)
        file_size = file_path.stat().st_size

        file_data = file_path.read_bytes()
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.put(
                presigned_url,
                content=file_data,
                headers={"Content-Length": str(file_size)},
            )
            if resp.status_code not in (200, 201):
                log.error("Upload failed (%s): %s", resp.status_code, resp.text)
                raise RuntimeError(f"Upload failed: {resp.status_code}")
            etag = resp.headers.get("ETag", "")
            log.info("Upload OK, ETag=%s", etag)
            return etag

    async def upload_multipart(
        self,
        presigned_urls: list[str],
        file_path: str | Path,
        part_size: int,
        on_progress: Any = None,
    ) -> list[dict[str, Any]]:
        """Upload file via multipart presigned URLs.

        Returns list of {partNumber, eTag} for complete-multipart call.
        """
        file_path = Path(file_path)
        parts: list[dict[str, Any]] = []

        async with httpx.AsyncClient(timeout=600) as client:
            with open(file_path, "rb") as f:
                for i, url in enumerate(presigned_urls):
                    chunk = f.read(part_size)
                    if not chunk:
                        break
                    resp = await client.put(
                        url,
                        content=chunk,
                        headers={"Content-Length": str(len(chunk))},
                    )
                    if resp.status_code not in (200, 201):
                        raise RuntimeError(
                            f"Multipart upload part {i} failed: {resp.status_code}",
                        )
                    etag = resp.headers.get("ETag", "")
                    parts.append({"partNumber": i, "eTag": etag})
                    if on_progress:
                        on_progress(i + 1, len(presigned_urls))

        log.info("Multipart upload OK, %d parts", len(parts))
        return parts

    # ── Step 2b: Complete multipart upload ────────────────────────────
    async def complete_multipart(
        self,
        upload_id: str,
        object_key: str,
        ceph_server_id: str,
        parts: list[dict[str, Any]],
    ) -> bool:
        """Confirm multipart upload success."""
        token = await self.authenticate()
        url = f"{self._api_url}/api/v1/external/file-info/complete-multipart-upload"
        body = {
            "uploadId": upload_id,
            "objectKey": object_key,
            "cephServerId": ceph_server_id,
            "parts": parts,
        }
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                url,
                json=body,
                headers=self._headers(token),
                params=self._user_params(),
            )
            if resp.status_code != 200:
                log.error("complete-multipart failed (%s): %s", resp.status_code, resp.text)
                raise RuntimeError(f"complete-multipart: {resp.status_code}")
            log.info("Multipart complete OK")
            return True

    # ── Step 3: Create file-info on HG Stock ──────────────────────────
    async def create_file_info(
        self,
        folder_id: str,
        title: str,
        media_type: int,
        tags: list[str],
        resource_file: dict[str, str],
        description: str = "",
        sub_genre: str = "",
    ) -> dict[str, Any]:
        """Create file info record on HG Stock.

        Uses fixed values per RedOne policy:
        - source = 5 (MKT sản xuất)
        - isAIProduct = True
        - usageForm = 2 (Độc quyền)
        """
        token = await self.authenticate()
        url = f"{self._api_url}/api/v1/external/file-info/create"
        body: dict[str, Any] = {
            "folderId": folder_id,
            "title": title,
            "description": description,
            "mediaType": media_type,
            "isAIProduct": True,
            "source": 5,              # MKT sản xuất
            "usageForm": 2,           # Độc quyền
            "isCopyright": True,
            "tags": tags,
            "subGenre": sub_genre,
            "resourceFile": resource_file,
        }
        # Add upscale request for video
        if media_type == 2:
            body["upscaleRequest"] = [0, 1, 2]  # HD, 2K, 4K

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                url,
                json=body,
                headers=self._headers(token),
                params=self._user_params(),
            )
            if resp.status_code != 200:
                log.error("create-file-info failed (%s): %s", resp.status_code, resp.text)
                raise RuntimeError(f"create-file-info: {resp.status_code}")
            return resp.json()

    # ── Full upload flow ──────────────────────────────────────────────
    async def upload_file(
        self,
        file_path: str | Path,
        folder_id: str,
        title: str,
        tags: list[str],
        sub_genre: str = "",
        on_progress: Any = None,
    ) -> dict[str, Any]:
        """Execute the complete upload flow for a single file.

        Steps:
        1. Compute hash
        2. Get presigned URL
        3. Upload to storage
        4. (Multipart) Complete multipart
        5. Create file-info

        Returns the file-info response from HG Stock.
        """
        file_path = Path(file_path)
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        file_name = file_path.name
        file_ext = file_path.suffix.lstrip(".")
        media_type = detect_media_type(file_path)
        file_size = file_path.stat().st_size

        # Step 1: Hash
        log.info("Computing hash for %s (%d bytes)", file_name, file_size)
        if on_progress:
            on_progress("hashing", 0, 1)
        file_hash = compute_file_hash(file_path)
        log.info("Hash: %s", file_hash)

        # Step 2: Presigned URL
        if on_progress:
            on_progress("presigning", 0, 1)
        presigned = await self.get_presigned_url(
            folder_id=folder_id,
            file_name=file_name,
            file_extension=file_ext,
            media_type=media_type,
            file_hash=file_hash,
            file_size=file_size if file_size > 2 * 1024**3 else None,
        )

        if presigned.get("isExisted"):
            log.info("File already exists on HG Stock")
            # Still need to create file-info
            resource_file = {
                "id": presigned.get("resourceFileId", ""),
                "fileName": presigned.get("fileName", file_name),
                "fileExtension": presigned.get("fileExtension", file_ext),
                "hash": presigned.get("hash", file_hash),
                "cephServerId": presigned.get("cephServerId", ""),
                "objectKey": presigned.get("objectKey", ""),
            }
        else:
            upload_type = presigned.get("uploadType", 0)

            # Step 3: Upload
            if upload_type == 0:
                # Normal upload
                if on_progress:
                    on_progress("uploading", 0, 1)
                await self.upload_normal(
                    presigned["preSignedUrl"], file_path, on_progress,
                )
            else:
                # Multipart upload
                urls = presigned.get("preSignedUrls", [])
                part_size = presigned.get("partSize", HASH_CHUNK_SIZE)
                parts = await self.upload_multipart(
                    urls, file_path, part_size, on_progress,
                )
                # Step 4: Complete multipart
                await self.complete_multipart(
                    upload_id=presigned.get("uploadId", ""),
                    object_key=presigned.get("objectKey", ""),
                    ceph_server_id=presigned.get("cephServerId", ""),
                    parts=parts,
                )

            resource_file = {
                "id": presigned.get("resourceFileId", ""),
                "fileName": presigned.get("fileName", file_name),
                "fileExtension": presigned.get("fileExtension", file_ext),
                "hash": presigned.get("hash", file_hash),
                "cephServerId": presigned.get("cephServerId", ""),
                "objectKey": presigned.get("objectKey", ""),
            }

        # Step 5: Create file-info
        if on_progress:
            on_progress("creating", 0, 1)
        result = await self.create_file_info(
            folder_id=folder_id,
            title=title,
            media_type=media_type,
            tags=tags,
            resource_file=resource_file,
            sub_genre=sub_genre,
        )
        if on_progress:
            on_progress("done", 1, 1)

        log.info("File created on HG Stock: %s", result.get("id", ""))
        return result
