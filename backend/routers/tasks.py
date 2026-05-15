"""Task management endpoints — list all jobs across kinds + cancel/delete."""
from __future__ import annotations
import logging
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from fastapi import APIRouter, HTTPException

from ..database import db
from ..queue_manager import queue
from ..ws_hub import hub
from ..config import OUTPUT_DIR, slugify_folder

log = logging.getLogger("navtools.tasks")
router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def _annotate(task: dict) -> dict:
    """Add queue position + progress percent to a DB task row."""
    pos = queue.position_of(task["id"])
    total = task.get("total_count") or 0
    done = task.get("done_count") or 0
    err = task.get("error_count") or 0
    progress = round(((done + err) / total) * 100, 1) if total else 0
    return {
        **task,
        "queue_position": pos,                 # 0 = running, ≥1 = queued, -1 = not in queue
        "progress_percent": progress,
    }


@router.get("")
async def list_tasks(limit: int = 200):
    """All tasks (newest first) with queue + progress info."""
    rows = db.list_tasks(limit=limit)
    return {
        "tasks": [_annotate(r) for r in rows],
        "queue": queue.snapshot(),
    }


@router.get("/{task_id}")
async def get_task(task_id: int):
    t = db.get_task(task_id)
    if not t:
        raise HTTPException(404, "Task not found")
    items = db.get_task_items(task_id)
    return {
        "task": _annotate(t),
        "items": items,
        "queue": queue.snapshot(),
    }


@router.post("/{task_id}/cancel")
async def cancel_task(task_id: int):
    """Cancel a queued or running task (kind-agnostic)."""
    ok = await queue.cancel(task_id)
    if not ok:
        # Maybe task already finished, just update DB
        from ..config import TaskStatus
        db.update_task(task_id, status=TaskStatus.CANCELLED.value)
        await hub.broadcast("task_cancelled", {"task_id": task_id})
    return {"ok": True, "queue_cancel": ok}


@router.post("/{task_id}/retry")
async def retry_task(task_id: int):
    """Re-enqueue a failed / cancelled task.

    - Items with status=COMPLETED stay completed (their output files exist)
    - Items with status=ERROR / PENDING get reset to PENDING for re-processing
    - Picks the right runner based on task.mode
    """
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    if task["status"] in ("PENDING", "RUNNING"):
        raise HTTPException(400, "Task đang chạy / chờ — không thể retry")

    # Reset error items back to PENDING; recompute counters
    from ..config import ItemStatus
    items = db.get_task_items(task_id)
    done = 0
    for it in items:
        if it["status"] in (ItemStatus.ERROR.value, ItemStatus.PENDING.value):
            db.update_item(it["id"], status=ItemStatus.PENDING.value, error_message=None)
        elif it["status"] == ItemStatus.COMPLETED.value:
            done += 1
    db.update_task(task_id,
                   status="PENDING",
                   done_count=done,
                   error_count=0,
                   finished_at=None)

    # Pick the right runner based on task mode
    mode = (task.get("mode") or "").lower()
    if mode == "image":
        from . import image as image_mod
        runner = image_mod._process_image_task
        kind = "image"
    elif mode == "long_video":
        from . import long_video as lv_mod
        runner = lv_mod._run_long_video
        kind = "long_video"
    else:  # t2v / i2v / fallback
        from . import content as content_mod
        runner = content_mod._process_task
        kind = "content"

    pos = await queue.enqueue(kind, task_id, runner)
    await hub.broadcast("task_started", {"task_id": task_id, "retried": True})
    return {"ok": True, "queue_position": pos, "kind": kind}


@router.get("/_/queue")
async def queue_state():
    """Get a snapshot of the queue (current + waiting)."""
    return queue.snapshot()


def _resolve_task_folder(task: dict) -> Path | None:
    """Find the directory where a task's outputs live.

    Strategy: look at the first item that has a non-empty output_path and
    take its parent dir (most reliable). If no items have output yet, try
    composing the path from <kind>/<created_date>/<task_name>.
    """
    items = db.get_task_items(task["id"])
    for it in items:
        op = it.get("output_path")
        if op:
            p = Path(op).parent
            if p.exists():
                return p

    # Fallback: compose by convention
    mode = (task.get("mode") or "").lower()
    if mode in ("image",):
        kind = "image"
    else:
        kind = "video"

    # Use task's created_at date (UTC string "YYYY-MM-DD HH:MM:SS")
    created = task.get("created_at") or ""
    date_part = created[:10] if len(created) >= 10 else datetime.now().strftime("%Y-%m-%d")
    folder_name = slugify_folder(task.get("name") or "", fallback=f"task_{task['id']}")

    # Try permanent first, then pending
    for base in (OUTPUT_DIR, OUTPUT_DIR / "_pending"):
        cand = base / kind / date_part / folder_name
        if cand.exists():
            return cand
    return None


@router.post("/{task_id}/open-folder")
async def open_folder(task_id: int):
    """Open the OS file explorer at the task's output folder."""
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")

    folder = _resolve_task_folder(task)
    if not folder or not folder.exists():
        raise HTTPException(
            404,
            "Chưa có thư mục output cho task này (task chưa render xong file nào)",
        )

    folder_str = str(folder.resolve())
    try:
        if sys.platform == "win32":
            os.startfile(folder_str)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", folder_str])
        else:
            subprocess.Popen(["xdg-open", folder_str])
    except Exception as e:
        log.exception("open-folder failed")
        raise HTTPException(500, f"Không mở được folder: {e}")

    return {"ok": True, "path": folder_str}
