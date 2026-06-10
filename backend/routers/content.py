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
    video_model_for, interpolation_model_for, get_save_dir, clamp_duration,
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
    loop: bool = False               # I2V "Loop video": reuse the image as first+last frame
    task_name: Optional[str] = None


_active_tasks: dict[int, asyncio.Task] = {}


def _pick_account() -> Optional[dict]:
    accounts = [a for a in db.get_accounts() if a["enabled"]]
    accounts.sort(key=lambda a: -(a.get("credit") or 0))
    if accounts:
        return accounts[0]
    # Vertex AI uses the baked service account — no Google login needed. On a
    # fresh machine with no accounts, return a synthetic one so gen proceeds.
    # Other modes (extension/playwright) still require a real account.
    from ..services.flow_factory import is_vertex_mode, synthetic_vertex_account
    if is_vertex_mode():
        return synthetic_vertex_account()
    return None


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


# ── DB-authoritative progress helpers ───────────────────────────────
# Counts come straight from the task_items table rather than an in-memory
# counter dict. This matters because items can now be regenerated OUT of the
# main batch loop (per-item retry / retry-all endpoints) while the loop may
# still be running other items. A shared in-memory counter would race; the DB
# is the single source of truth so every writer converges to the same numbers.

def _count_items(task_id: int) -> dict:
    items = db.get_task_items(task_id)
    done = sum(1 for it in items if it.get("status") == ItemStatus.COMPLETED.value)
    err = sum(1 for it in items if it.get("status") == ItemStatus.ERROR.value)
    gen = sum(1 for it in items if it.get("status") == ItemStatus.GENERATING.value)
    pend = sum(1 for it in items if it.get("status") == ItemStatus.PENDING.value)
    return {"done": done, "error": err, "generating": gen, "pending": pend, "total": len(items)}


async def _broadcast_progress(task_id: int) -> dict:
    """Recompute counts from DB, persist to the task row, broadcast progress."""
    c = _count_items(task_id)
    db.update_task(task_id, done_count=c["done"], error_count=c["error"])
    await hub.broadcast("task_progress", {
        "task_id": task_id, "done": c["done"], "error": c["error"], "total": c["total"],
    })
    return c


async def _maybe_finalize(task_id: int) -> None:
    """Mark the task COMPLETED + broadcast — but ONLY when no item is still
    pending/generating. Safe to call from a retry path while the main batch
    loop is still working: the guard means whoever finishes the last item
    flips the task, and the COMPLETED-status check prevents a double event.
    """
    c = _count_items(task_id)
    if c["generating"] == 0 and c["pending"] == 0:
        task = db.get_task(task_id)
        if task and task.get("status") != TaskStatus.COMPLETED.value:
            db.update_task(task_id, status=TaskStatus.COMPLETED.value,
                           finished_at=str(time.time()))
            await hub.broadcast("task_completed", {
                "task_id": task_id, "done": c["done"], "error": c["error"],
            })


async def generate_content_item(client, task: dict, item: dict) -> bool:
    """Generate + wait + download ONE video item.

    Updates the DB row, broadcasts item_status / item_completed / item_error
    and task_progress. Returns True on success, False on a handled failure.
    Re-raises SessionDeadError so the caller can disable the dead account.

    This is the single reusable unit of work shared by the batch loop
    (`_process_task`) AND the per-item / retry-failed endpoints — that's what
    lets a retry run even while the parent task is still generating others.
    Error messages are passed through `friendly_error()` so the gallery shows
    something actionable; the raw string rides along as `error_detail`.
    """
    import random as _rng
    from ..services import flow_client as fc_mod
    from ..services.error_messages import friendly_error

    task_id = task["id"]
    item_id = item["id"]
    quality = task["quality"]
    aspect = task["aspect_ratio"]

    # Mark GENERATING in the DB *before* the jitter sleep. A regen-from-done
    # flips this item COMPLETED→GENERATING; writing the status first (rather
    # than after sleeping) closes the window where a sibling item finishing
    # could trip _maybe_finalize into broadcasting task_completed prematurely.
    db.update_item(item_id, status=ItemStatus.GENERATING.value, error_message=None)
    await hub.broadcast("item_status", {
        "task_id": task_id, "item_id": item_id,
        "status": ItemStatus.GENERATING.value,
    })
    # Small jitter so concurrent items don't hit Google at the exact same ms.
    await asyncio.sleep(_rng.uniform(0.0, 1.5))
    try:
        ref_image_path = None
        loop = False
        if item.get("extra_json"):
            extra = json.loads(item["extra_json"])
            ref_image_path = extra.get("reference_image")
            loop = bool(extra.get("loop"))
        ref_media = None
        if ref_image_path and Path(ref_image_path).exists():
            ref_media = await client.upload_image(ref_image_path)

        # "Loop video" only applies with a reference image — it reuses that
        # image as BOTH first and last frame (interpolation) so the clip ends
        # where it started. No ref image → nothing to loop.
        loop = loop and bool(ref_media)
        mode = "i2v" if ref_media else "t2v"
        # Omni Flash doesn't support I2V yet — fall back to Veo 3.1 Lite [LP]
        # (free queue) when a ref image is set.
        eff_quality = quality
        if quality == "omni_flash" and ref_media:
            log.warning(
                f"Item {item_id}: Omni Flash + ref image not supported; "
                f"falling back to lite_lp for this item"
            )
            eff_quality = "lite_lp"
        duration_s = int(task.get("duration") or 8)
        if loop:
            # Interpolation model (first+last frame). Omni Flash has none → lite_lp.
            model_key = interpolation_model_for(eff_quality)
        else:
            model_key = video_model_for(eff_quality, mode, duration_s)

        done_state = None
        last_err = None
        for attempt in range(MAX_ITEM_RETRIES):
            workflow = await client.generate_video(
                prompt=item["prompt"],
                model_key=model_key,
                aspect_ratio=aspect,
                reference_image=ref_media,
                end_image=(ref_media if loop else None),   # same image → loop
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
                    f"Item {item_id} attempt {attempt + 1}/{MAX_ITEM_RETRIES} "
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
        out_path = ext_dir / f"item_{item_id}.mp4"
        ok = await client.download_to(media_id, str(out_path))
        if not ok:
            raise RuntimeError("Download failed")

        db.update_item(item_id, status=ItemStatus.COMPLETED.value,
                       output_path=str(out_path), error_message=None)
        await hub.broadcast("item_completed", {
            "task_id": task_id, "item_id": item_id,
            "output_path": str(out_path),
        })
        return True
    except fc_mod.SessionDeadError:
        msg = ("Phiên đăng nhập của tài khoản đã hết hạn — đăng nhập lại ở "
               "tab Tài Khoản rồi gen lại.")
        db.update_item(item_id, status=ItemStatus.ERROR.value, error_message=msg)
        await hub.broadcast("item_error", {
            "task_id": task_id, "item_id": item_id, "error": msg,
        })
        raise   # propagate so caller can disable the account
    except Exception as ex:
        raw = str(ex)
        friendly = friendly_error(raw)
        db.update_item(item_id, status=ItemStatus.ERROR.value, error_message=friendly)
        await hub.broadcast("item_error", {
            "task_id": task_id, "item_id": item_id,
            "error": friendly, "error_detail": raw,
        })
        return False
    finally:
        await _broadcast_progress(task_id)


async def _process_task(task_id: int):
    task = db.get_task(task_id)
    items = db.get_task_items(task_id)
    if not task or not items:
        return
    # Normal generation = bridge priority class 2 (below regen=0, upscale=1).
    from ..services.browser_bridge import set_gen_priority, next_gen_seq
    set_gen_priority(2, next_gen_seq())
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

        # Process only items that aren't already COMPLETED. Each prompt is now
        # attempted INDEPENDENTLY — there is no longer a 403 "circuit breaker"
        # that cancels the rest of the batch after N consecutive failures.
        # Failures are recorded per-item; the user retries them via the
        # per-item "Gen lại" button or "Gen lại tất cả lỗi".
        pending = [
            it for it in items
            if it.get("status") != ItemStatus.COMPLETED.value
        ]
        batches = [
            pending[i:i + parallelism]
            for i in range(0, len(pending), parallelism)
        ]

        session_dead_err: Optional[fc_mod.SessionDeadError] = None
        for batch_idx, batch in enumerate(batches):
            batch_results = await asyncio.gather(
                *(generate_content_item(client, task, it) for it in batch),
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

        await _maybe_finalize(task_id)
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
                if body.loop:
                    extra["loop"] = True   # reuse this image as the last frame too
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
