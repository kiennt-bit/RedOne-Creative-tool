"""File management endpoints: zip-download, delete, move temp→outputs."""
from __future__ import annotations
import io
import logging
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import OUTPUT_DIR
from ..database import db

log = logging.getLogger("redone.files")
router = APIRouter(prefix="/api/files", tags=["files"])


def _validate_path(p: str) -> Path:
    """Reject paths escaping OUTPUT_DIR — basic path traversal defence."""
    candidate = Path(p).resolve()
    base = OUTPUT_DIR.resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        raise HTTPException(400, f"Path outside outputs folder: {p}")
    return candidate


class PathsBody(BaseModel):
    paths: list[str]


@router.post("/download-zip")
async def download_zip(body: PathsBody):
    """Bundle the requested files into a zip and stream it back."""
    files = []
    for p in body.paths:
        f = _validate_path(p)
        if f.is_file():
            files.append(f)
    if not files:
        raise HTTPException(404, "No matching files")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            arcname = f.relative_to(OUTPUT_DIR).as_posix()
            zf.write(f, arcname=arcname)
    buf.seek(0)

    def iter_chunks():
        while chunk := buf.read(1 << 16):
            yield chunk

    return StreamingResponse(
        iter_chunks(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="redone_{len(files)}_files.zip"'},
    )


@router.post("/delete")
async def delete_files(body: PathsBody):
    """Delete the given files from disk."""
    deleted = 0
    errors = []
    for p in body.paths:
        try:
            f = _validate_path(p)
            if f.is_file():
                f.unlink()
                deleted += 1
        except Exception as e:
            errors.append({"path": p, "error": str(e)})
    return {"deleted": deleted, "errors": errors}


@router.post("/move-to-outputs")
async def move_to_outputs(body: PathsBody):
    """Move files from outputs/_pending/... → outputs/... (their stable home).

    Useful when auto_save is OFF and the user later decides to keep some.
    """
    pending_dir = (OUTPUT_DIR / "_pending").resolve()
    moved = []
    errors = []
    for p in body.paths:
        try:
            src = _validate_path(p)
            if not src.is_file():
                continue
            # Compute target: replace "_pending/" segment with nothing
            rel = src.relative_to(OUTPUT_DIR)
            parts = list(rel.parts)
            if parts and parts[0] == "_pending":
                parts = parts[1:]
            dst = OUTPUT_DIR.joinpath(*parts)
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                # add suffix to avoid overwrite
                i = 1
                while dst.with_name(f"{dst.stem}_{i}{dst.suffix}").exists():
                    i += 1
                dst = dst.with_name(f"{dst.stem}_{i}{dst.suffix}")
            shutil.move(str(src), str(dst))
            moved.append({"from": str(src), "to": str(dst)})
        except Exception as e:
            errors.append({"path": p, "error": str(e)})
    return {"moved": len(moved), "files": moved, "errors": errors}


class OpenFolderBody(BaseModel):
    """A single path inside OUTPUT_DIR. If it's a file, the parent dir opens."""
    path: str


@router.post("/open-folder")
async def open_folder(body: OpenFolderBody):
    """Open the host OS file explorer at the given path.

    Path validation: rejects anything outside OUTPUT_DIR — keeps the endpoint
    from being a generic "open arbitrary folder" RPC (which would be a real
    security hole when accessed via the local-only WS, but defence-in-depth).
    If `path` points to a file, opens its parent directory.
    """
    target = _validate_path(body.path)
    if target.is_file():
        target = target.parent
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, f"Folder không tồn tại: {target}")
    folder = str(target.resolve())
    try:
        if sys.platform == "win32":
            os.startfile(folder)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", folder])
        else:
            subprocess.Popen(["xdg-open", folder])
    except Exception as e:
        log.exception("open-folder failed")
        raise HTTPException(500, f"Không mở được folder: {e}")
    return {"ok": True, "path": folder}


def cleanup_pending_folder(max_age_hours: int = 168):
    """Remove _pending files older than `max_age_hours` (default 1 tuần = 168h).
    Safe to call on startup."""
    pending = OUTPUT_DIR / "_pending"
    if not pending.exists():
        return 0
    import time
    cutoff = time.time() - max_age_hours * 3600
    removed = 0
    for f in pending.rglob("*"):
        if f.is_file() and f.stat().st_mtime < cutoff:
            try:
                f.unlink()
                removed += 1
            except Exception:
                pass
    log.info(f"Cleaned {removed} stale files from {pending}")
    return removed
