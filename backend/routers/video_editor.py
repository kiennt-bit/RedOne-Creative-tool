"""Trình dựng video — project store + media library + render task.

A multi-track timeline (video/image/text/audio clips, xfade transitions, ASS
text, per-clip color) is rendered to one MP4 through the SAME sequential
queue / pause / resume / cancel machinery as every other task
(mode="video_render"), so it shows up in "Quản lý task" with the usual
controls. Shipped in v1.5.0.

  - Projects:   CRUD on the `projects` table (editor state stored as JSON).
  - My media:   list the user's own media (app outputs + uploads) to drop on
                the timeline — NOT a stock marketplace.
  - Upload:     persist a user file under outputs/ so it is /files-servable.
  - Render:     enqueue a `video_render` task → services/video_compose.

The render config (the timeline spec) is persisted on the task row
(`character_images_json`) so Resume can re-render after a pause/restart without
the frontend resubmitting — mirrors how flow_upscale stores its config there.
"""
from __future__ import annotations
import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel

from ..database import db
from ..config import OUTPUT_DIR, TaskStatus, ItemStatus, get_save_dir, slugify_folder
from ..ws_hub import hub
from ..queue_manager import queue
from ..services import video_compose
from ..services.video_compose import VIDEO_EXTS, IMAGE_EXTS, AUDIO_EXTS

log = logging.getLogger("redone.video_editor")
router = APIRouter(prefix="/api/video-editor", tags=["video-editor"])

UPLOAD_DIR = OUTPUT_DIR / "video_editor" / "uploads"
MEDIA_EXTS = VIDEO_EXTS | IMAGE_EXTS | AUDIO_EXTS
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024  # 1 GB per file


def _now() -> str:
    """SQLite-style UTC timestamp, matching datetime('now')."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _media_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in IMAGE_EXTS:
        return "image"
    return "video"


def _rel_url(path: Path) -> Optional[str]:
    """`/files/...` URL for a path inside OUTPUT_DIR, else None."""
    try:
        return f"/files/{path.resolve().relative_to(OUTPUT_DIR.resolve()).as_posix()}"
    except ValueError:
        return None


def _inside_outputs(p: str) -> Path:
    """Resolve a path and ensure it lives under OUTPUT_DIR (clips can only come
    from the user's own media — uploads + app outputs). Raises 400 otherwise."""
    cand = Path(p).resolve()
    try:
        cand.relative_to(OUTPUT_DIR.resolve())
    except ValueError:
        raise HTTPException(400, f"File ngoài thư mục outputs: {p}")
    return cand


# ───────────────────────────── Projects ─────────────────────────────

class ProjectCreate(BaseModel):
    name: str = "Dự án mới"


class ProjectSave(BaseModel):
    name: Optional[str] = None
    data: dict = {}


@router.get("/projects")
async def list_projects():
    return {"projects": db.list_projects()}


@router.post("/projects")
async def create_project(body: ProjectCreate):
    name = (body.name or "").strip() or "Dự án mới"
    pid = db.create_project(name, data_json="{}")
    return {"id": pid, "name": name}


@router.get("/projects/{project_id}")
async def get_project(project_id: int):
    p = db.get_project(project_id)
    if not p:
        raise HTTPException(404, "Không tìm thấy dự án")
    try:
        p["data"] = json.loads(p.get("data_json") or "{}")
    except (TypeError, ValueError):
        p["data"] = {}
    return p


@router.put("/projects/{project_id}")
async def save_project(project_id: int, body: ProjectSave):
    if not db.get_project(project_id):
        raise HTTPException(404, "Không tìm thấy dự án")
    fields = {"data_json": json.dumps(body.data or {}), "updated_at": _now()}
    if body.name is not None:
        fields["name"] = body.name.strip() or "Dự án mới"
    db.update_project(project_id, **fields)
    return {"ok": True}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: int):
    db.delete_project(project_id)
    return {"ok": True}


# ─────────────────────────── Media library ──────────────────────────

def _scan_media_sync(type_str: str, limit: int) -> dict:
    wanted = {
        "all": {"video", "image", "audio"},
        "video": {"video"}, "image": {"image"}, "audio": {"audio"},
    }.get(type_str, {"video", "image", "audio"})
    
    items: list[dict] = []
    base = OUTPUT_DIR.resolve()
    
    # Target folders to scan recursively based on type
    paths_to_scan = []
    if "video" in wanted:
        paths_to_scan.append((base / "video", True))
        paths_to_scan.append((base / "video_editor" / "uploads", True))
    if "image" in wanted:
        paths_to_scan.append((base / "image", True))
    if "audio" in wanted:
        paths_to_scan.append((base / "audio", True))
    
    # Also scan outputs root shallowly
    paths_to_scan.append((base, False))
    
    seen_paths = set()
    for d, recursive in paths_to_scan:
        if not d.exists() or not d.is_dir():
            continue
        try:
            iterator = d.rglob("*") if recursive else d.iterdir()
            for p in iterator:
                if not p.is_file() or p in seen_paths:
                    continue
                seen_paths.add(p)
                ext = p.suffix.lower()
                if ext not in MEDIA_EXTS:
                    continue
                mt = _media_type(p)
                if mt not in wanted:
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                items.append({
                    "path": str(p),
                    "url": _rel_url(p),
                    "name": p.name,
                    "type": mt,
                    "mtime": st.st_mtime,
                    "size": st.st_size,
                })
        except OSError:
            continue
            
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return {"media": items[: max(1, min(limit, 2000))], "total": len(items)}


@router.get("/my-media")
async def my_media(type: str = "all", limit: int = 300):
    """List the user's own media (app outputs + editor uploads), newest first.
    Runs filesystem I/O in a thread to keep the event loop responsive.
    """
    return await asyncio.to_thread(_scan_media_sync, type, limit)


@router.post("/upload")
async def upload_media(file: UploadFile = File(...)):
    """Save a user-provided media file under outputs/ so it is /files-servable
    and shows up in the timeline. Validates extension + size."""
    raw_name = Path(file.filename or "media").name
    ext = Path(raw_name).suffix.lower()
    if ext not in MEDIA_EXTS:
        raise HTTPException(400, f"Định dạng không hỗ trợ: {ext or '(không rõ)'}")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    safe_stem = slugify_folder(Path(raw_name).stem, fallback="media")
    dst = UPLOAD_DIR / f"{safe_stem}_{uuid.uuid4().hex[:8]}{ext}"
    written = 0
    try:
        with dst.open("wb") as f:
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "File quá lớn (tối đa 1GB)")
                f.write(chunk)
    except HTTPException:
        dst.unlink(missing_ok=True)
        raise
    except Exception as e:
        dst.unlink(missing_ok=True)
        log.exception("upload failed")
        raise HTTPException(500, f"Tải lên thất bại: {e}")
    return {
        "path": str(dst),
        "url": _rel_url(dst),
        "name": raw_name,
        "type": _media_type(dst),
        "size": written,
    }


# ───────────────────────────── Render ────────────────────────────────

class RenderRequest(BaseModel):
    name: Optional[str] = None
    project_id: Optional[int] = None
    quality: Optional[str] = "HD"   # HD | 2K | 4K (encode bitrate tier)
    spec: dict


@router.post("/render")
async def render(body: RenderRequest):
    spec = body.spec or {}
    spec["quality"] = (body.quality or "HD")
    # New multi-track spec: clips live under tracks[]. (Accept a flat clips[]
    # list too, for forward/backward safety.)
    clips = []
    for tr in spec.get("tracks") or []:
        clips.extend(tr.get("clips") or [])
    clips.extend(spec.get("clips") or [])
    if not clips:
        raise HTTPException(400, "Timeline trống — thêm ít nhất 1 clip rồi xuất.")
    # Media clips may only reference the user's own files (inside outputs/).
    # Text clips have no path — skip them.
    for c in clips:
        p = c.get("path")
        if not p:
            if (c.get("kind") or "") == "text":
                continue
            raise HTTPException(400, "Có clip thiếu đường dẫn file.")
        resolved = _inside_outputs(p)
        if not resolved.exists():
            raise HTTPException(400, f"Không tìm thấy file: {p}")

    name = (body.name or "").strip() or f"video_{int(time.time())}"
    from ..services import hub_client
    task_id = db.create_task(
        name=name,
        mode="video_render",
        total_count=1,
        status=TaskStatus.PENDING.value,
        project_id=body.project_id,
        user_email=hub_client.current_user_email(),
        character_images_json=json.dumps({
            "video_render": True,
            "project_id": body.project_id,
            "spec": spec,
        }),
    )
    db.add_task_item(task_id, name)
    position = await queue.enqueue("video_render", task_id, _process_video_render_task)
    return {"task_id": task_id, "queue_position": position, "queued": position > 0}


async def _process_video_render_task(task_id: int):
    """Queue runner for a video render. Goes through the SAME pause/resume/
    cancel machinery as gen tasks: a pause/cancel cancels the asyncio task →
    we kill ffmpeg + (on pause) the item is reset to PENDING so Resume
    re-renders. The timeline spec is read back from the task row, so Resume
    needs no resubmit from the frontend."""
    task = db.get_task(task_id)
    items = db.get_task_items(task_id)
    if not task or not items:
        return
    item = items[0]
    iid = item["id"]

    db.update_task(task_id, status=TaskStatus.RUNNING.value, started_at=str(time.time()))
    await hub.broadcast("task_started", {"task_id": task_id, "kind": "video_editor"})

    cfg = json.loads(task.get("character_images_json") or "{}")
    spec = cfg.get("spec") or {}

    out_dir = get_save_dir("video", task_id, task.get("name"))
    stem = slugify_folder(task.get("name") or "", fallback=f"video_{task_id}")
    out_path = out_dir / f"{stem}_{task_id}.mp4"

    db.update_item(iid, status=ItemStatus.GENERATING.value, error_message=None)
    await hub.broadcast("item_status", {
        "task_id": task_id, "item_id": iid, "status": ItemStatus.GENERATING.value,
    })

    async def _on_progress(pct: float, msg: str):
        await hub.broadcast("video_render_progress", {
            "task_id": task_id, "item_id": iid,
            "percent": round(pct, 1), "message": msg,
        })

    def _should_cancel() -> bool:
        return queue.is_cancelled(task_id) or queue.is_paused(task_id)

    try:
        await video_compose.render_timeline(
            spec, str(out_path),
            on_progress=_on_progress, should_cancel=_should_cancel,
        )
    except asyncio.CancelledError:
        # Paused/cancelled — leave the item resumable; the queue worker writes
        # the PAUSED/CANCELLED task status. Best-effort remove the partial file.
        db.update_item(iid, status=ItemStatus.PENDING.value, error_message=None)
        try:
            out_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise
    except Exception as e:
        log.exception("video render failed")
        db.update_item(iid, status=ItemStatus.ERROR.value, error_message=str(e))
        db.update_task(task_id, status=TaskStatus.ERROR.value, error_count=1,
                       finished_at=str(time.time()))
        await hub.broadcast("task_error", {"task_id": task_id, "error": str(e)})
        return

    db.update_item(iid, status=ItemStatus.COMPLETED.value, output_path=str(out_path),
                   completed_at=str(time.time()))
    db.update_task(task_id, status=TaskStatus.COMPLETED.value, done_count=1,
                   finished_at=str(time.time()))
    rel = _rel_url(out_path)
    await hub.broadcast("item_completed", {
        "task_id": task_id, "item_id": iid,
        "output_path": str(out_path), "url": rel, "kind": "video_editor",
    })
    await hub.broadcast("task_completed", {
        "task_id": task_id, "done": 1, "error": 0, "kind": "video_editor",
    })
