"""Task management endpoints — list all jobs across kinds + cancel/delete."""
from __future__ import annotations
import asyncio
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
from ..config import OUTPUT_DIR, slugify_folder, TaskStatus, ItemStatus

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


# ── Per-item / failed-only retry (works WHILE the task is still running) ──
#
# Unlike /retry (which re-enqueues the whole task through the sequential
# queue and is blocked while RUNNING/PENDING), these regenerate individual
# items in a detached background coroutine with their OWN flow client. The
# main queue worker — if it's still processing this task — only touches the
# items it snapshotted at start (the PENDING ones); items that already
# reached ERROR are done as far as the loop is concerned, so retrying them
# out-of-band never double-processes anything. DB-authoritative counters
# (see content/image `_broadcast_progress`) keep the totals consistent
# across both writers.

async def _retry_items_runner(task: dict, item_ids: list[int]) -> None:
    """Background: regenerate `item_ids` for `task` using a fresh client.

    Items already COMPLETED are skipped. Picks the image vs video single-item
    generator based on task.mode. Runs in batches of task.concurrent. On a
    dead session it disables the account and stops. Always finalizes the task
    (flip to COMPLETED if nothing is left pending/generating) and closes the
    client.
    """
    from . import content as content_mod, image as image_mod
    from ..services import flow_client as fc_mod
    from ..services.flow_factory import make_flow_client, get_page_for_account

    task_id = task["id"]
    mode = (task.get("mode") or "").lower()
    if mode == "image":
        gen_fn = image_mod.generate_image_item
        finalize = image_mod._maybe_finalize
        pick = image_mod._pick_account
    else:
        gen_fn = content_mod.generate_content_item
        finalize = content_mod._maybe_finalize
        pick = content_mod._pick_account

    acc = pick()
    if not acc:
        await hub.broadcast("task_error", {
            "task_id": task_id, "error": "Không có account khả dụng để gen lại",
        })
        return

    client = None
    try:
        page = await get_page_for_account(acc)
        client = make_flow_client(
            page=page,
            cookie_path=acc.get("cookie_path") or "",
            account_email=acc["email"],
        )
        try:
            await client.ensure_token()
        except fc_mod.SessionDeadError as sde:
            db.update_account(acc["id"], enabled=0)
            await hub.broadcast("account_session_dead", {
                "account_id": acc["id"], "email": acc["email"], "reason": sde.reason,
            })
            await hub.broadcast("task_error", {
                "task_id": task_id,
                "error": f"Session {acc['email']} hết hạn — login lại ở tab Tài Khoản",
            })
            return

        # Re-fetch each item fresh; skip any that are already done.
        targets = []
        for iid in item_ids:
            it = db.get_item(iid)
            if it and it.get("status") != ItemStatus.COMPLETED.value:
                targets.append(it)
        if not targets:
            await finalize(task_id)
            return

        parallelism = max(1, min(task.get("concurrent") or 1, len(targets)))
        batches = [targets[i:i + parallelism] for i in range(0, len(targets), parallelism)]
        for batch in batches:
            results = await asyncio.gather(
                *(gen_fn(client, task, it) for it in batch),
                return_exceptions=True,
            )
            # Stop early if the account died mid-retry.
            if any(isinstance(r, fc_mod.SessionDeadError) for r in results):
                db.update_account(acc["id"], enabled=0)
                await hub.broadcast("account_session_dead", {
                    "account_id": acc["id"], "email": acc["email"],
                    "reason": "session dead during retry",
                })
                break
        await finalize(task_id)
    except Exception:
        log.exception(f"retry runner crashed task={task_id}")
        # Best effort: still try to finalize so the UI doesn't hang in RUNNING.
        try:
            await finalize(task_id)
        except Exception:
            pass
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:
                pass


@router.post("/item/{item_id}/retry")
async def retry_item(item_id: int):
    """Regenerate a SINGLE failed/pending item — even while the parent task is
    still generating other items. Returns immediately; progress streams over
    WebSocket (item_status → item_completed/item_error)."""
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(404, "Không tìm thấy item")
    if item.get("status") == ItemStatus.COMPLETED.value:
        raise HTTPException(400, "Item đã hoàn thành — không cần gen lại")
    task = db.get_task(item["task_id"])
    if not task:
        raise HTTPException(404, "Không tìm thấy task của item")

    # Flip a finished task back to RUNNING so the UI shows in-progress again.
    if task.get("status") in (
        TaskStatus.COMPLETED.value, TaskStatus.ERROR.value, TaskStatus.CANCELLED.value,
    ):
        db.update_task(task["id"], status=TaskStatus.RUNNING.value, finished_at=None)
        await hub.broadcast("task_started", {"task_id": task["id"], "retried": True})

    asyncio.create_task(_retry_items_runner(task, [item_id]))
    return {"ok": True, "item_id": item_id}


@router.post("/{task_id}/retry-failed")
async def retry_failed(task_id: int):
    """Regenerate ALL currently-failed items of a task — works while the task
    is still running. Returns immediately; progress streams over WebSocket."""
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    items = db.get_task_items(task_id)
    failed_ids = [it["id"] for it in items if it.get("status") == ItemStatus.ERROR.value]
    if not failed_ids:
        return {"ok": True, "retried": 0}

    if task.get("status") in (
        TaskStatus.COMPLETED.value, TaskStatus.ERROR.value, TaskStatus.CANCELLED.value,
    ):
        db.update_task(task_id, status=TaskStatus.RUNNING.value, finished_at=None)
    await hub.broadcast("task_started", {"task_id": task_id, "retried": True})

    asyncio.create_task(_retry_items_runner(task, failed_ids))
    return {"ok": True, "retried": len(failed_ids)}


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
