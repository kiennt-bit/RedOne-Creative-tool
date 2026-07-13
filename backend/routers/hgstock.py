"""HG Stock upload endpoints.

Thin router — delegates to hgstock_client.py for all API interactions.

Endpoints
=========
    GET  /api/hgstock/status       Check if feature is available for current user
    GET  /api/hgstock/projects     List available project presets
    POST /api/hgstock/upload       Upload file(s) to HG Stock
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..config import (
    OUTPUT_DIR,
    HGSTOCK_PROJECT_PRESETS,
    HGSTOCK_CREDS,
    HGSTOCK_ADMIN_URL,
    HGSTOCK_DEFAULT_FOLDER_ID,
)
from ..services.hgstock_client import HGStockClient, detect_media_type

log = logging.getLogger("redone.hgstock_router")
router = APIRouter(prefix="/api/hgstock", tags=["hgstock"])

# Singleton client — reuses cached auth token across requests
_client = HGStockClient()

# In-progress upload tasks (task_id → status dict)
_upload_tasks: dict[str, dict[str, Any]] = {}


# ── Helpers ───────────────────────────────────────────────────────────
def _get_session(request: Request) -> dict:
    """Get current user session. Returns {} if not logged in."""
    try:
        from ..services.oauth_auth import load_session
        return load_session() or {}
    except Exception:
        return {}


def _user_has_hgstock_permission(session: dict) -> bool:
    """Check if the current user has HG Stock upload permission.

    Session format from oauth_auth: {session_id, email, name, picture, ...}
    A non-empty session with an email = logged in.

    For the initial rollout: any logged-in @redone.vn user has access.
    Later: add per-user toggle via Hub/Admin.
    """
    from ..config import IS_FROZEN
    if IS_FROZEN:
        return False
    if not session or not session.get("email"):
        return False
    # Any authenticated user can upload (gated by @redone.vn domain check
    # already enforced by oauth_auth). Future: per-user flag via Hub.
    return True



# ── Request schemas ───────────────────────────────────────────────────
class UploadRequest(BaseModel):
    """Request body for /upload endpoint."""
    files: list[str]           # List of file paths (relative to outputs/)
    project: str               # Project name (e.g. "Relax", or custom text)
    tags: list[str]            # List of tag strings
    folder_id: str = ""        # HG Stock folder ID (optional, can be derived)


# ── Endpoints ─────────────────────────────────────────────────────────
@router.get("/status")
async def hgstock_status(request: Request) -> JSONResponse:
    """Check if HG Stock upload is available for the current user."""
    from ..config import IS_FROZEN
    if IS_FROZEN:
        return JSONResponse({
            "configured": False,
            "has_permission": False,
            "environment": "prod",
            "admin_url": "",
            "user_email": "",
        })

    session = _get_session(request)
    configured = _client.is_configured()
    has_permission = _user_has_hgstock_permission(session)
    env = HGSTOCK_CREDS.get("env", "dev")

    return JSONResponse({
        "configured": configured,
        "has_permission": has_permission,
        "environment": env,
        "admin_url": HGSTOCK_ADMIN_URL.get(env, ""),
        "user_email": session.get("email", ""),
    })


@router.get("/projects")
async def hgstock_projects() -> JSONResponse:
    """Return preset project names for the upload UI."""
    return JSONResponse({
        "presets": HGSTOCK_PROJECT_PRESETS,
    })


@router.post("/upload")
async def hgstock_upload(
    body: UploadRequest,
    request: Request,
) -> JSONResponse:
    """Start uploading selected files to HG Stock.

    Runs in background, returns a task_id for progress polling.
    """
    session = _get_session(request)
    if not _user_has_hgstock_permission(session):
        raise HTTPException(403, "Bạn không có quyền upload lên HG Stock.")

    if not _client.is_configured():
        raise HTTPException(
            503,
            "HG Stock chưa được cấu hình. Kiểm tra private_config.py.",
        )

    # Validate files exist
    resolved_files: list[Path] = []
    for rel_path in body.files:
        # Accept both relative (to outputs/) and absolute paths
        fp = Path(rel_path)
        if not fp.is_absolute():
            fp = OUTPUT_DIR / rel_path
        if not fp.exists():
            raise HTTPException(404, f"File không tồn tại: {rel_path}")
        resolved_files.append(fp)

    if not resolved_files:
        raise HTTPException(400, "Chưa chọn file nào.")

    # Always include the project name as a tag (auto-tag)
    all_tags = list(body.tags)
    if body.project and body.project not in all_tags:
        all_tags.insert(0, body.project)

    # Create background task
    task_id = str(uuid.uuid4())[:8]
    _upload_tasks[task_id] = {
        "status": "pending",
        "total": len(resolved_files),
        "completed": 0,
        "current_file": "",
        "current_step": "",
        "results": [],
        "errors": [],
    }

    # Run upload in background
    asyncio.create_task(
        _run_upload(task_id, resolved_files, body.project, all_tags,
                    body.folder_id or HGSTOCK_DEFAULT_FOLDER_ID),
    )

    return JSONResponse({
        "task_id": task_id,
        "total_files": len(resolved_files),
        "message": f"Đang upload {len(resolved_files)} file(s)...",
    })


@router.get("/upload-progress/{task_id}")
async def hgstock_progress(task_id: str) -> JSONResponse:
    """Poll upload progress for a given task."""
    task = _upload_tasks.get(task_id)
    if not task:
        raise HTTPException(404, "Task không tồn tại.")
    return JSONResponse(task)


@router.get("/output-files")
async def list_output_files() -> JSONResponse:
    """List all image/video/audio files in the outputs directory (recursive)."""
    files: list[dict[str, Any]] = []
    for subdir in ("image", "video"):
        folder = OUTPUT_DIR / subdir
        if not folder.exists():
            continue
        for f in sorted(folder.rglob("*")):
            if not f.is_file() or f.name.startswith("."):
                continue
            ext = f.suffix.lstrip(".").lower()
            media_type = detect_media_type(f)
            # Relative path from OUTPUT_DIR for the upload API
            rel = f.relative_to(OUTPUT_DIR).as_posix()
            files.append({
                "name": f.name,
                "path": rel,
                "size": f.stat().st_size,
                "media_type": media_type,
                "media_label": ["image", "audio", "video"][media_type],
                "ext": ext,
            })

    return JSONResponse({"files": files})


# ── Background upload runner ──────────────────────────────────────────
async def _run_upload(
    task_id: str,
    files: list[Path],
    project: str,
    tags: list[str],
    folder_id: str,
) -> None:
    """Run the full upload flow for each file, updating task progress."""
    task = _upload_tasks[task_id]
    task["status"] = "running"

    for i, fp in enumerate(files):
        task["current_file"] = fp.name
        task["completed"] = i

        def on_progress(step: str, current: int, total: int) -> None:
            task["current_step"] = step

        try:
            # Use project name as title prefix
            title = f"{project} - {fp.stem}"

            result = await _client.upload_file(
                file_path=fp,
                folder_id=folder_id,
                title=title,
                tags=tags,
                sub_genre=project,
                on_progress=on_progress,
            )
            task["results"].append({
                "file": fp.name,
                "hgstock_id": result.get("id", ""),
                "code": result.get("code", ""),
                "url": result.get("fileContentUrl", ""),
            })
        except Exception as exc:
            log.exception("Upload failed for %s", fp.name)
            task["errors"].append({
                "file": fp.name,
                "error": str(exc),
            })

    task["completed"] = len(files)
    task["current_file"] = ""
    task["current_step"] = ""
    task["status"] = "done" if not task["errors"] else "partial"
