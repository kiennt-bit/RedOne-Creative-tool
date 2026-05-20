"""Content (Text/Image-to-Video) generation endpoints."""
from __future__ import annotations
import asyncio
import json
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from ..database import db
from ..config import (
    OUTPUT_DIR, TaskStatus, ItemStatus, ASPECT_RATIOS, RESOLUTIONS,
    video_model_for, get_save_dir, clamp_duration,
)
from ..ws_hub import hub
from ..queue_manager import queue

log = logging.getLogger("navtools.content")
router = APIRouter(prefix="/api/content", tags=["content"])


class StartTaskRequest(BaseModel):
    mode: str  # "t2v" | "i2v"
    prompts: list[str]
    quality: str = "fast"            # omni_flash | lite | fast | quality | lite_lp
    aspect_ratio: str = "16:9"
    resolution: str = "720p"
    duration: int = 8                # 4 | 6 | 8 | 10 (10 only for omni_flash)
    concurrent: int = 1
    reference_images: Optional[list[str]] = None  # uploaded image paths
    character_images: Optional[dict] = None
    task_name: Optional[str] = None


_active_tasks: dict[int, asyncio.Task] = {}


def _pick_account() -> Optional[dict]:
    accounts = [a for a in db.get_accounts() if a["enabled"]]
    accounts.sort(key=lambda a: -(a.get("credit") or 0))
    return accounts[0] if accounts else None


async def _handle_session_dead(task_id, acc, sde):
    """Disable a dead account, mark task as error, broadcast UI notification."""
    log.warning(f"Session dead for account {acc['email']}: {sde.reason}")
    try:
        db.update_account(acc["id"], enabled=0)
    except Exception:
        pass
    db.update_task(task_id, status=TaskStatus.ERROR.value)
    await hub.broadcast("account_session_dead", {
        "account_id": acc["id"],
        "email": acc["email"],
        "reason": sde.reason,
    })
    await hub.broadcast("task_error", {
        "task_id": task_id,
        "error": f"Session account {acc['email']} đã hết hạn — hãy login lại trong tab Tài Khoản",
    })


# Transient errors from Google's poll response that justify an item-level retry
TRANSIENT_PATTERNS = (
    "failed to enqueue",
    "try again",
    "transient",
    "internal error",
    "media not found",
    "unavailable",
)
MAX_ITEM_RETRIES = 3


async def _process_task(task_id: int):
    task = db.get_task(task_id)
    items = db.get_task_items(task_id)
    if not task or not items:
        return
    db.update_task(task_id, status=TaskStatus.RUNNING.value, started_at=str(time.time()))
    await hub.broadcast("task_started", {"task_id": task_id})

    acc = _pick_account()
    if not acc:
        db.update_task(task_id, status=TaskStatus.ERROR.value)
        await hub.broadcast("task_error", {"task_id": task_id, "error": "Không có account khả dụng"})
        return

    try:
        from ..services import browser_manager as bm_mod, flow_client as fc_mod
        bm = bm_mod.BrowserManager()
        page = await bm.get_page(acc["id"], acc["email"], cookie_path=acc.get("cookie_path"))
        client = fc_mod.FlowClient(page, cookie_path=acc.get("cookie_path") or "", account_email=acc["email"])
        try:
            await client.ensure_token()
        except fc_mod.SessionDeadError as sde:
            await _handle_session_dead(task_id, acc, sde)
            return

        quality = task["quality"]
        aspect = task["aspect_ratio"]
        parallelism = max(1, min(task.get("concurrent") or 1, len(items)))
        log.info(f"Task {task_id}: processing {len(items)} items with parallelism={parallelism}")

        # Shared mutable counters guarded by a lock
        counters = {"done": 0, "error": 0}
        counter_lock = asyncio.Lock()
        semaphore = asyncio.Semaphore(parallelism)

        import random as _rng

        async def _process_one(item, idx):
            """Generate + wait + download a single item, respecting the semaphore."""
            async with semaphore:
                # Small jitter so concurrent items don't hit Google at the exact same ms
                await asyncio.sleep(_rng.uniform(0.0, 1.5))
                await hub.broadcast("item_status", {
                    "task_id": task_id, "item_id": item["id"],
                    "status": ItemStatus.GENERATING.value,
                })
                db.update_item(item["id"], status=ItemStatus.GENERATING.value)
                try:
                    ref_image_path = None
                    if item.get("extra_json"):
                        extra = json.loads(item["extra_json"])
                        ref_image_path = extra.get("reference_image")
                    ref_media = None
                    if ref_image_path and Path(ref_image_path).exists():
                        ref_media = await client.upload_image(ref_image_path)

                    mode = "i2v" if ref_media else "t2v"
                    # For Omni Flash, duration is encoded in the model_key
                    # itself (abra_t2v_10s). For Veo 3.1, static keys.
                    duration_s = int(task.get("duration") or 8)
                    model_key = video_model_for(quality, mode, duration_s)

                    done_state = None
                    last_err = None
                    for attempt in range(MAX_ITEM_RETRIES):
                        workflow = await client.generate_video(
                            prompt=item["prompt"],
                            model_key=model_key,
                            aspect_ratio=aspect,
                            reference_image=ref_media,
                            duration=duration_s,
                        )
                        done_state = await client.wait_for_completion(workflow)
                        if done_state and done_state.get("state") != "FAILED":
                            break
                        last_err = (done_state or {}).get("error", "") or "Generation failed"
                        if attempt < MAX_ITEM_RETRIES - 1 and any(
                            p in last_err.lower() for p in TRANSIENT_PATTERNS
                        ):
                            log.warning(
                                f"Item {item['id']} attempt {attempt + 1}/{MAX_ITEM_RETRIES} "
                                f"transient error: {last_err} — retrying"
                            )
                            await asyncio.sleep(_rng.uniform(3, 6))
                            continue
                        raise RuntimeError(last_err)

                    if not done_state or done_state.get("state") == "FAILED":
                        raise RuntimeError(last_err or "Generation failed")

                    media_id = (
                        done_state.get("name")
                        or done_state.get("media_id")
                        or done_state.get("video_id")
                    )
                    if not media_id:
                        raise RuntimeError("Video sinh xong nhưng response không có media_id")

                    ext_dir = get_save_dir("video", task_id, task.get("name"))
                    out_path = ext_dir / f"item_{item['id']}.mp4"
                    ok = await client.download_to(media_id, str(out_path))
                    if not ok:
                        raise RuntimeError("Download failed")

                    db.update_item(item["id"], status=ItemStatus.COMPLETED.value, output_path=str(out_path))
                    async with counter_lock:
                        counters["done"] += 1
                        d, e = counters["done"], counters["error"]
                    await hub.broadcast("item_completed", {
                        "task_id": task_id, "item_id": item["id"],
                        "output_path": str(out_path),
                    })
                except fc_mod.SessionDeadError as sde:
                    # Friendly error message instead of raw stack
                    db.update_item(
                        item["id"], status=ItemStatus.ERROR.value,
                        error_message=f"Session hết hạn — login lại {acc['email']}",
                    )
                    async with counter_lock:
                        counters["error"] += 1
                        d, e = counters["done"], counters["error"]
                    await hub.broadcast("item_error", {
                        "task_id": task_id, "item_id": item["id"],
                        "error": f"Session {acc['email']} hết hạn",
                    })
                    # Propagate so the outer try() can disable the account
                    raise
                except Exception as ex:
                    db.update_item(item["id"], status=ItemStatus.ERROR.value, error_message=str(ex))
                    async with counter_lock:
                        counters["error"] += 1
                        d, e = counters["done"], counters["error"]
                    await hub.broadcast("item_error", {
                        "task_id": task_id, "item_id": item["id"], "error": str(ex),
                    })
                # Progress update
                db.update_task(task_id, done_count=d, error_count=e)
                await hub.broadcast("task_progress", {
                    "task_id": task_id, "done": d, "error": e, "total": len(items),
                })

        # Launch all items concurrently; semaphore caps how many run at once
        results = await asyncio.gather(
            *(_process_one(item, idx) for idx, item in enumerate(items)),
            return_exceptions=True,
        )

        # If any item raised SessionDeadError, disable the account so the
        # queue doesn't keep picking it for future tasks.
        for r in results:
            if isinstance(r, fc_mod.SessionDeadError):
                await _handle_session_dead(task_id, acc, r)
                return

        done = counters["done"]
        err = counters["error"]
        db.update_task(task_id, status=TaskStatus.COMPLETED.value, finished_at=str(time.time()))
        await hub.broadcast("task_completed", {"task_id": task_id, "done": done, "error": err})
    except fc_mod.SessionDeadError as sde:
        await _handle_session_dead(task_id, acc, sde)
    except Exception as e:
        log.exception("Task crashed")
        db.update_task(task_id, status=TaskStatus.ERROR.value)
        await hub.broadcast("task_error", {"task_id": task_id, "error": str(e)})
    finally:
        _active_tasks.pop(task_id, None)


@router.post("/start")
async def start_content_task(body: StartTaskRequest):
    if not body.prompts:
        raise HTTPException(400, "Prompts required")
    task_name = (body.task_name or "").strip() or f"video_{int(time.time())}"
    # Clamp duration to what the chosen model actually supports
    safe_duration = clamp_duration(body.quality, body.duration)
    task_id = db.create_task(
        name=task_name,
        mode=body.mode,
        quality=body.quality,
        aspect_ratio=body.aspect_ratio,
        resolution=body.resolution,
        duration=safe_duration,
        concurrent=body.concurrent,
        total_count=len(body.prompts),
        status=TaskStatus.PENDING.value,
    )
    for i, p in enumerate(body.prompts):
        extra = {}
        # reference_images may contain None for prompts without an image
        # (mixed I2V/T2V batch) — only store the field when actually set.
        if body.reference_images and i < len(body.reference_images):
            ref = body.reference_images[i]
            if ref:
                extra["reference_image"] = ref
        db.add_task_item(task_id, p, extra=extra or None)

    position = await queue.enqueue("content", task_id, _process_task)
    return {
        "task_id": task_id,
        "items": len(body.prompts),
        "queue_position": position,
        "queued": position > 0,
    }


@router.post("/cancel/{task_id}")
async def cancel_task(task_id: int):
    ok = await queue.cancel(task_id)
    if not ok:
        db.update_task(task_id, status=TaskStatus.CANCELLED.value)
        await hub.broadcast("task_cancelled", {"task_id": task_id})
    return {"ok": True, "queue_cancel": ok}


@router.get("/tasks")
async def list_tasks(limit: int = 50):
    return {"tasks": db.list_tasks(limit)}


@router.get("/tasks/{task_id}")
async def get_task(task_id: int):
    t = db.get_task(task_id)
    if not t:
        raise HTTPException(404, "Task not found")
    return {"task": t, "items": db.get_task_items(task_id)}


@router.post("/upload-image")
async def upload_image(file: UploadFile = File(...)):
    """Upload reference/character image to temp folder."""
    img_dir = OUTPUT_DIR / "uploaded_images"
    img_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(file.filename or "img.png").suffix or ".png"
    out = img_dir / f"{uuid.uuid4().hex}{ext}"
    with out.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"path": str(out), "name": file.filename}
