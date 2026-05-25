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

# Once N items fail back-to-back with a Google reCAPTCHA verdict (403 /
# unusual_activity), the rest of the task is essentially doomed because
# Google's risk score for this session won't recover without ~10-15 minutes
# of inactivity. Trip the circuit at that point so the remaining items
# don't waste credit + clock time on calls that are guaranteed to fail.
CIRCUIT_THRESHOLD = 3


def _read_cooldown_range() -> tuple[float, float]:
    """Read (min, max) batch cooldown seconds from settings.

    Defaults to (5, 10) — randomized pauses in that range mimic natural
    user pacing and avoid the constant-gap signature that flagged the old
    fixed-cooldown approach.

    Returns a tuple clamped so:
      - both values are non-negative
      - max >= min (silently swaps if user entered them backwards)
    """
    def _to_float(key: str, default: float) -> float:
        try:
            v = db.get_setting(key, default)
            return max(0.0, float(v))
        except (TypeError, ValueError):
            return default

    cd_min = _to_float("batch_cooldown_min_seconds", 5.0)
    cd_max = _to_float("batch_cooldown_max_seconds", 10.0)
    if cd_max < cd_min:
        cd_min, cd_max = cd_max, cd_min
    return cd_min, cd_max


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

    client = None
    try:
        from ..services import flow_client as fc_mod
        from ..services.flow_factory import make_flow_client, get_page_for_account
        page = await get_page_for_account(acc)  # None in extension mode
        client = make_flow_client(
            page=page,
            cookie_path=acc.get("cookie_path") or "",
            account_email=acc["email"],
        )
        try:
            await client.ensure_token()
        except fc_mod.SessionDeadError as sde:
            await _handle_session_dead(task_id, acc, sde)
            return

        quality = task["quality"]
        aspect = task["aspect_ratio"]
        parallelism = max(1, min(task.get("concurrent") or 1, len(items)))
        # Random pause between batches — applied AFTER each batch of
        # `parallelism` items finishes, before launching the next.
        # Randomization (not a fixed value) is intentional: a constant
        # N-second gap is itself a signature Google's rate-detector can
        # pick up. Drawing from a uniform [min, max] interval mimics
        # natural user pacing.
        cd_min, cd_max = _read_cooldown_range()
        log.info(
            f"Task {task_id}: processing {len(items)} items "
            f"(batch_size={parallelism}, cooldown={cd_min}-{cd_max}s)"
        )

        # Shared mutable counters guarded by a lock.
        # Pre-seed `done` with items that are already COMPLETED — happens on
        # retry where /api/tasks/{id}/retry keeps the completed items intact
        # and only resets ERROR/PENDING ones. Without this pre-seed, the
        # progress chip would jump from "0/8" back to "5/8" as we walk
        # through the completed items in the loop.
        initial_done = sum(
            1 for it in items if it.get("status") == ItemStatus.COMPLETED.value
        )
        counters = {"done": initial_done, "error": 0}
        counter_lock = asyncio.Lock()

        # Per-task 403 circuit breaker — stops launching new items once
        # Google has flagged the session 3 times in a row.
        from ..services.circuit_breaker import CircuitBreaker
        breaker = CircuitBreaker(threshold=CIRCUIT_THRESHOLD)

        import random as _rng

        async def _process_one(item, idx):
            """Generate + wait + download a single item, respecting the semaphore.

            Items already COMPLETED are skipped entirely (they keep their
            output_path from the previous successful run). This is the
            retry path — only ERROR/PENDING items get regenerated.
            """
            # Skip COMPLETED items — DON'T re-generate already-good videos.
            # The retry endpoint left these untouched on purpose; if we
            # called generate_video for them, we'd burn credit on items
            # the user already has output for.
            if item.get("status") == ItemStatus.COMPLETED.value:
                return

            # Concurrency is bounded by the outer batch loop (each batch is
            # gathered with at most `parallelism` items). No semaphore needed.
            if True:
                # Fast-fail if the circuit has tripped — don't waste a
                # generation slot on a call we know will 403.
                if await breaker.is_open():
                    cooldown_msg = (
                        "Skipped — 403 reCAPTCHA cooldown. Có thể bấm 'Gen "
                        "lại lỗi' ngay (nếu thử ngay vẫn fail thì đợi vài "
                        "phút để Google reset risk score)."
                    )
                    db.update_item(item["id"], status=ItemStatus.ERROR.value,
                                   error_message=cooldown_msg)
                    async with counter_lock:
                        counters["error"] += 1
                        d, e = counters["done"], counters["error"]
                    await hub.broadcast("item_error", {
                        "task_id": task_id, "item_id": item["id"],
                        "error": cooldown_msg,
                    })
                    db.update_task(task_id, done_count=d, error_count=e)
                    await hub.broadcast("task_progress", {
                        "task_id": task_id, "done": d, "error": e, "total": len(items),
                    })
                    return

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
                    # Safety: Omni Flash doesn't support I2V yet — fallback
                    # to Veo 3.1 Lite [LP] (free queue) when ref image is set.
                    eff_quality = quality
                    if quality == "omni_flash" and ref_media:
                        log.warning(
                            f"Item {item['id']}: Omni Flash + ref image not supported by Google; "
                            f"falling back to lite_lp for this item"
                        )
                        eff_quality = "lite_lp"
                    duration_s = int(task.get("duration") or 8)
                    model_key = video_model_for(eff_quality, mode, duration_s)

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
                    await breaker.record_success()   # reset the 403 streak
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
                    err_str = str(ex)
                    # Update the circuit. record_failure() returns True
                    # exactly once — on the transition from closed→open —
                    # so we broadcast the "tripped" event only once.
                    tripped_now = await breaker.record_failure(err_str)
                    if tripped_now:
                        log.warning(
                            f"Task {task_id}: 403 circuit tripped after "
                            f"{CIRCUIT_THRESHOLD} consecutive reCAPTCHA failures"
                        )
                        await hub.broadcast("task_circuit_tripped", {
                            "task_id": task_id,
                            "threshold": CIRCUIT_THRESHOLD,
                            "message": (
                                f"{CIRCUIT_THRESHOLD} items liên tiếp bị 403 — "
                                f"đã pause task. Bấm 'Gen lại N lỗi' để retry "
                                f"ngay (nếu vẫn fail thì đợi vài phút)."
                            ),
                        })
                    db.update_item(item["id"], status=ItemStatus.ERROR.value, error_message=err_str)
                    async with counter_lock:
                        counters["error"] += 1
                        d, e = counters["done"], counters["error"]
                    await hub.broadcast("item_error", {
                        "task_id": task_id, "item_id": item["id"], "error": err_str,
                    })
                # Progress update
                db.update_task(task_id, done_count=d, error_count=e)
                await hub.broadcast("task_progress", {
                    "task_id": task_id, "done": d, "error": e, "total": len(items),
                })

        # Batch-by-batch processing. Each batch of `parallelism` items runs
        # concurrently via gather; after a batch finishes we sleep
        # `cooldown_seconds` before launching the next. The user-configured
        # cooldown is the key knob for tuning vs Google's rate detection.
        #
        # Already-COMPLETED items (from a retry path) are skipped here too —
        # they were excluded from the work, so we don't waste a batch slot
        # on a no-op `_process_one`.
        pending = [
            (idx, it) for idx, it in enumerate(items)
            if it.get("status") != ItemStatus.COMPLETED.value
        ]
        batches = [
            pending[i:i + parallelism]
            for i in range(0, len(pending), parallelism)
        ]

        session_dead_err: Optional[fc_mod.SessionDeadError] = None
        for batch_idx, batch in enumerate(batches):
            # If the circuit tripped during the previous batch, don't even
            # launch the next one — mark them all as skipped and break.
            if await breaker.is_open():
                cooldown_msg = (
                    "Skipped — 403 reCAPTCHA cooldown. Bấm 'Gen lại lỗi' để retry."
                )
                for _, it in batch:
                    db.update_item(it["id"], status=ItemStatus.ERROR.value,
                                   error_message=cooldown_msg)
                    async with counter_lock:
                        counters["error"] += 1
                        d, e = counters["done"], counters["error"]
                    await hub.broadcast("item_error", {
                        "task_id": task_id, "item_id": it["id"],
                        "error": cooldown_msg,
                    })
                    db.update_task(task_id, done_count=d, error_count=e)
                    await hub.broadcast("task_progress", {
                        "task_id": task_id, "done": d, "error": e, "total": len(items),
                    })
                # Also flush remaining batches as skipped so progress
                # completes (otherwise the chip stalls at N/Total).
                for remaining in batches[batch_idx + 1:]:
                    for _, it in remaining:
                        db.update_item(it["id"], status=ItemStatus.ERROR.value,
                                       error_message=cooldown_msg)
                        async with counter_lock:
                            counters["error"] += 1
                            d, e = counters["done"], counters["error"]
                        await hub.broadcast("item_error", {
                            "task_id": task_id, "item_id": it["id"],
                            "error": cooldown_msg,
                        })
                        db.update_task(task_id, done_count=d, error_count=e)
                        await hub.broadcast("task_progress", {
                            "task_id": task_id, "done": d, "error": e,
                            "total": len(items),
                        })
                break

            batch_results = await asyncio.gather(
                *(_process_one(it, idx) for idx, it in batch),
                return_exceptions=True,
            )

            # Surface SessionDead at batch boundary — no point sleeping +
            # running more batches if the account is dead.
            for r in batch_results:
                if isinstance(r, fc_mod.SessionDeadError):
                    session_dead_err = r
                    break
            if session_dead_err:
                break

            # Cooldown between batches — random in [cd_min, cd_max]. Skip
            # if this was the last batch or if range is 0..0.
            is_last_batch = (batch_idx == len(batches) - 1)
            if cd_max > 0 and not is_last_batch:
                import random as _rnd
                wait_s = round(_rnd.uniform(cd_min, cd_max), 1)
                await hub.broadcast("task_batch_cooldown", {
                    "task_id": task_id,
                    "seconds": wait_s,
                    "min": cd_min,
                    "max": cd_max,
                    "batch_done": batch_idx + 1,
                    "batch_total": len(batches),
                })
                log.info(
                    f"Task {task_id}: batch {batch_idx + 1}/{len(batches)} done, "
                    f"sleeping {wait_s}s (random in [{cd_min}, {cd_max}]) "
                    f"before next batch"
                )
                await asyncio.sleep(wait_s)

        if session_dead_err is not None:
            await _handle_session_dead(task_id, acc, session_dead_err)
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
        if client is not None:
            try:
                await client.close()
            except Exception:
                pass
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


# Max edge length for reference images sent to Google Flow. Google's
# generation pipeline downsamples anything larger internally — keeping
# bigger files only slows our upload (base64 inflates by ~33% on top of
# the wire transfer). 2048px preserves enough detail for character /
# style references; smaller is also fine.
REF_IMAGE_MAX_EDGE = 2048


@router.post("/upload-image")
async def upload_image(file: UploadFile = File(...)):
    """Upload reference/character image to temp folder.

    Auto-resizes any image whose long edge exceeds REF_IMAGE_MAX_EDGE
    (2048px). 4K phone photos are commonly 4032×3024 — a 6-8 MB JPEG
    becomes a 800 KB JPEG with no visible quality loss for reference
    purposes. EXIF metadata is also stripped (often adds 100+ KB of
    GPS/camera info that's pointless for Google).

    Returns the SAVED path (post-resize) so downstream code stays
    unchanged.
    """
    img_dir = OUTPUT_DIR / "uploaded_images"
    img_dir.mkdir(parents=True, exist_ok=True)
    ext = (Path(file.filename or "img.png").suffix or ".png").lower()
    # Force common-case extensions to keep PIL happy
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"):
        ext = ".png"
    out = img_dir / f"{uuid.uuid4().hex}{ext}"
    with out.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    # Resize if needed. Wrapped in try/except so an unusual format that
    # PIL can't open still falls through with the raw file (better to
    # have a slow upload than to reject the user's file).
    try:
        from PIL import Image, ImageOps
        with Image.open(out) as img:
            # Honour EXIF orientation flag BEFORE we strip metadata
            img = ImageOps.exif_transpose(img)
            w, h = img.size
            long_edge = max(w, h)
            if long_edge > REF_IMAGE_MAX_EDGE:
                scale = REF_IMAGE_MAX_EDGE / long_edge
                new_w = int(round(w * scale))
                new_h = int(round(h * scale))
                img = img.resize((new_w, new_h), Image.LANCZOS)
                log.info(
                    f"upload-image: resized {w}x{h} → {new_w}x{new_h} "
                    f"({file.filename})"
                )
                # Save back. Use JPEG quality 90 for jpegs, lossless for
                # png/webp. Convert RGBA → RGB only when saving JPEG.
                save_kwargs = {}
                fmt = (img.format or "").upper()
                lower_ext = ext.lower()
                if lower_ext in (".jpg", ".jpeg"):
                    if img.mode in ("RGBA", "P"):
                        img = img.convert("RGB")
                    save_kwargs = {"quality": 90, "optimize": True}
                elif lower_ext == ".png":
                    save_kwargs = {"optimize": True}
                elif lower_ext == ".webp":
                    save_kwargs = {"quality": 90, "method": 4}
                img.save(out, **save_kwargs)
    except Exception as e:
        log.warning(f"upload-image: resize skipped ({e}) — saving raw")

    return {"path": str(out), "name": file.filename}
