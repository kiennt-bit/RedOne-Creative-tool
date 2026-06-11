"""Signed media route — only used by the LocalDiskStorage backend.

The URL carries `exp` + `sig` (HMAC), so it is a capability: any browser
holding the link can load the thumbnail until it expires, without a Hub
token. (S3/R2 backends serve via presigned URLs and never hit this route.)
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from ..storage import LocalDiskStorage, get_storage

router = APIRouter(tags=["media"])


@router.get("/media/{key:path}")
def get_media(key: str, exp: int = Query(...), sig: str = Query(...)):
    storage = get_storage()
    if not isinstance(storage, LocalDiskStorage):
        raise HTTPException(status_code=404, detail="Not found")
    if not storage.verify(key, exp, sig):
        raise HTTPException(status_code=403, detail="URL hết hạn hoặc chữ ký không hợp lệ")
    path = storage.local_path(key)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Media không tồn tại")
    return FileResponse(path)
