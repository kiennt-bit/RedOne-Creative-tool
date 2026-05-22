"""Image generation endpoints (Imagen / Nano Banana via Google Labs)."""
from __future__ import annotations
import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database import db
from ..config import OUTPUT_DIR, TaskStatus, ItemStatus, get_save_dir
from ..ws_hub import hub
from ..queue_manager import queue

log = logging.getLogger("navtools.image")
router = APIRouter(prefix="/api/image", tags=["image"])


class StartImageRequest(BaseModel):
    prompts: list[str]
    model: str = "nano_banana_pro"     # nano_banana_pro | nano_banana_2 | imagen_4
    aspect_ratio: str = "1:1"
    count_per_prompt: int = 1
    concurrent: int = 1                 # số luồng song song
    reference_image_paths: Optional[list[str]] = None  # already uploaded
    task_name: Optional[str] = None


_active_tasks: dict[int, asyncio.Task] = {}


def _pick_account() -> Optional[dict]:
    accounts = [a for a in db.get_accounts() if a["enabled"]]
    accounts.sort(key=lambda a: -(a.get("credit") or 0))
    return accounts[0] if accounts else None


async def _handle_session_dead_img(task_id, acc, sde):
    log.warning(f"[image] Session dead {acc['email']}: {sde.reason}")
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


async def _process_image_task(task_id: int):
    task = db.get_task(task_id)
    items = db.get_task_items(task_id)
    if not task or not items:
        return
    db.update_task(task_id, status=TaskStatus.RUNNING.value, started_at=str(time.time()))
    await hub.broadcast("task_started", {"task_id": task_id, "kind": "image"})

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
            await _handle_session_dead_img(task_id, acc, sde)
            return

        model = task["image_model"]
        aspect = task["aspect_ratio"]
        parallelism = max(1, min(task.get("concurrent") or 1, len(items)))
        log.info(f"Image task {task_id}: {len(items)} items, parallelism={parallelism}")

        counters = {"done": 0, "error": 0}
        counter_lock = asyncio.Lock()
        semaphore = asyncio.Semaphore(parallelism)

        # Per-task 403 circuit breaker — Google sometimes flags an image
        # session after a few generations; once flagged the remaining
        # items in the task all fail. Stop launching new ones after 3
        # consecutive reCAPTCHA errors so we don't burn credits.
        from ..services.circuit_breaker import CircuitBreaker
        breaker = CircuitBreaker(threshold=3)

        import random as _rng

        async def _process_one(item):
            async with semaphore:
                if await breaker.is_open():
                    cooldown_msg = (
                        "Skipped — Google reCAPTCHA cooldown đang active. "
                        "Đợi 10-15 phút rồi bấm 'Gen lại N lỗi' để retry."
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

                # Jitter to avoid hammering Google at the same ms
                await asyncio.sleep(_rng.uniform(0.0, 1.2))
                await hub.broadcast("item_status", {
                    "task_id": task_id, "item_id": item["id"],
                    "status": ItemStatus.GENERATING.value,
                })
                db.update_item(item["id"], status=ItemStatus.GENERATING.value)
                try:
                    extra = json.loads(item.get("extra_json") or "{}")
                    ref_paths = extra.get("reference_images") or []
                    ref_media_ids = []
                    for p in ref_paths:
                        if Path(p).exists():
                            try:
                                mid = await client.upload_image(p)
                                if mid:
                                    ref_media_ids.append(mid)
                            except Exception as e:
                                log.warning(f"Upload ref image failed: {e}")

                    result = await client.generate_image(
                        prompt=item["prompt"],
                        model_key=model,
                        aspect_ratio=aspect,
                        reference_images=ref_media_ids or None,
                    )

                    out_dir = get_save_dir("image", f"task_{task_id}", task.get("name"))
                    out_path = out_dir / f"item_{item['id']}.png"
                    ok = await client.download_image(result["download_url"], str(out_path))
                    if not ok:
                        raise RuntimeError("Image download failed")

                    # Persist media_id so the upscale endpoint can find it later
                    # (Google Flow upsampleImage API needs the original mediaId).
                    extra["media_id"] = result.get("media_id")
                    db.update_item(
                        item["id"],
                        status=ItemStatus.COMPLETED.value,
                        output_path=str(out_path),
                        extra_json=json.dumps(extra),
                    )
                    await breaker.record_success()   # reset 403 streak
                    async with counter_lock:
                        counters["done"] += 1
                        d, e = counters["done"], counters["error"]
                    await hub.broadcast("item_completed", {
                        "task_id": task_id, "item_id": item["id"],
                        "output_path": str(out_path),
                        "kind": "image",
                        "width": result.get("width"),
                        "height": result.get("height"),
                        "media_id": result.get("media_id"),
                    })
                except fc_mod.SessionDeadError as sde:
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
                    raise
                except Exception as ex:
                    err_str = str(ex)
                    tripped_now = await breaker.record_failure(err_str)
                    if tripped_now:
                        log.warning(
                            f"Image task {task_id}: 403 circuit tripped"
                        )
                        await hub.broadcast("task_circuit_tripped", {
                            "task_id": task_id,
                            "threshold": 3,
                            "message": (
                                "3 ảnh liên tiếp bị Google reCAPTCHA chặn — "
                                "pause task. Đợi 10-15p rồi bấm 'Gen lại N lỗi'."
                            ),
                        })
                    db.update_item(item["id"], status=ItemStatus.ERROR.value, error_message=err_str)
                    async with counter_lock:
                        counters["error"] += 1
                        d, e = counters["done"], counters["error"]
                    await hub.broadcast("item_error", {
                        "task_id": task_id, "item_id": item["id"], "error": err_str,
                    })

                db.update_task(task_id, done_count=d, error_count=e)
                await hub.broadcast("task_progress", {
                    "task_id": task_id, "done": d, "error": e, "total": len(items),
                })

        results = await asyncio.gather(
            *(_process_one(item) for item in items),
            return_exceptions=True,
        )
        # Catch session-dead surfacing from any item
        for r in results:
            if isinstance(r, fc_mod.SessionDeadError):
                await _handle_session_dead_img(task_id, acc, r)
                return

        done = counters["done"]
        err = counters["error"]
        db.update_task(task_id, status=TaskStatus.COMPLETED.value, finished_at=str(time.time()))
        await hub.broadcast("task_completed", {
            "task_id": task_id, "done": done, "error": err, "kind": "image",
        })
    except fc_mod.SessionDeadError as sde:
        await _handle_session_dead_img(task_id, acc, sde)
    except Exception as e:
        log.exception("Image task crashed")
        db.update_task(task_id, status=TaskStatus.ERROR.value)
        await hub.broadcast("task_error", {"task_id": task_id, "error": str(e)})
    finally:
        _active_tasks.pop(task_id, None)


@router.post("/start")
async def start_image_task(body: StartImageRequest):
    if not body.prompts:
        raise HTTPException(400, "Cần ít nhất 1 prompt")
    if body.count_per_prompt < 1 or body.count_per_prompt > 8:
        raise HTTPException(400, "count_per_prompt phải từ 1 đến 8")

    # Expand prompts × count_per_prompt
    expanded = []
    for p in body.prompts:
        for _ in range(body.count_per_prompt):
            expanded.append(p)

    task_name = (body.task_name or "").strip() or f"image_{int(time.time())}"
    task_id = db.create_task(
        name=task_name,
        mode="image",
        image_model=body.model,
        aspect_ratio=body.aspect_ratio,
        concurrent=max(1, min(body.concurrent or 1, 8)),
        total_count=len(expanded),
        status=TaskStatus.PENDING.value,
    )
    extra_global = {"reference_images": body.reference_image_paths} if body.reference_image_paths else None
    for p in expanded:
        db.add_task_item(task_id, p, extra=extra_global)

    position = await queue.enqueue("image", task_id, _process_image_task)
    return {
        "task_id": task_id,
        "items": len(expanded),
        "queue_position": position,
        "queued": position > 0,
    }


@router.post("/cancel/{task_id}")
async def cancel_image(task_id: int):
    ok = await queue.cancel(task_id)
    if not ok:
        db.update_task(task_id, status=TaskStatus.CANCELLED.value)
        await hub.broadcast("task_cancelled", {"task_id": task_id})
    return {"ok": True, "queue_cancel": ok}


def _find_item(item_id: int) -> tuple[Optional[dict], Optional[dict]]:
    """Look up (task, item) by item_id across all tasks. Returns (None, None)
    if not found. Only searches the last 200 tasks — enough for practical use,
    since upscale is invoked from the currently visible gallery."""
    for t in db.list_tasks(limit=200):
        for it in db.get_task_items(t["id"]):
            if it["id"] == item_id:
                return t, it
    return None, None


def _save_upscaled(item_id: int, resolution: str, raw_bytes: bytes, task: dict) -> Path:
    """Save upscaled JPEG bytes to outputs/image/<date>/<task>/upscaled/."""
    # Mirror the original task's folder so the upscaled file lives next to
    # the source — keeps everything tidy when the user opens the folder.
    base_dir = get_save_dir("image", f"task_{task['id']}", task.get("name"))
    upscale_dir = base_dir / "upscaled"
    upscale_dir.mkdir(parents=True, exist_ok=True)
    out_path = upscale_dir / f"item_{item_id}_{resolution}.jpg"
    out_path.write_bytes(raw_bytes)
    return out_path


async def _do_upscale_one(client, item_id: int, media_id: str, resolution: str, task: dict) -> dict:
    """Run one upscale call + save result. Raises on failure."""
    r = await client.upscale_image(media_id, resolution=resolution)
    raw = r.get("encoded_image")
    if not raw:
        # Fallback path: response had fifeUrl instead of encodedImage
        url = r.get("download_url")
        if not url:
            raise RuntimeError("Upscale response thiếu cả encoded_image lẫn download_url")
        out_dir = get_save_dir("image", f"task_{task['id']}", task.get("name")) / "upscaled"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"item_{item_id}_{resolution}.png"
        ok = await client.download_image(url, str(out_path))
        if not ok:
            raise RuntimeError("Tải ảnh upscaled thất bại")
    else:
        out_path = _save_upscaled(item_id, resolution, raw, task)

    rel = out_path.relative_to(OUTPUT_DIR).as_posix()
    return {
        "item_id": item_id,
        "path": str(out_path),
        "url": f"/files/{rel}",
        "width": r.get("width"),
        "height": r.get("height"),
    }


@router.post("/upscale/{item_id}")
async def upscale_existing(item_id: int, resolution: str = "4k"):
    """Upscale a single already-generated image to 2K/4K via Google Labs."""
    if resolution.lower() not in ("2k", "4k"):
        raise HTTPException(400, "resolution phải là '2k' hoặc '4k'")

    task, item = _find_item(item_id)
    if not item or not task:
        raise HTTPException(404, "Item not found")
    extra = json.loads(item.get("extra_json") or "{}")
    media_id = extra.get("media_id")
    if not media_id:
        raise HTTPException(
            400,
            "Item không có media_id — ảnh này được tạo trước khi tool lưu media_id, "
            "cần generate lại để dùng tính năng upscale."
        )

    acc = _pick_account()
    if not acc:
        raise HTTPException(400, "Không có account khả dụng")
    try:
        from ..services import browser_manager as bm_mod, flow_client as fc_mod
        bm = bm_mod.BrowserManager()
        page = await bm.get_page(acc["id"], acc["email"], cookie_path=acc.get("cookie_path"))
        client = fc_mod.FlowClient(page, cookie_path=acc.get("cookie_path") or "", account_email=acc["email"])
        await client.ensure_token()
        result = await _do_upscale_one(client, item_id, media_id, resolution, task)
        return {"ok": True, **result}
    except HTTPException:
        raise
    except Exception as e:
        log.exception(f"Upscale item={item_id} failed")
        raise HTTPException(500, str(e))


class UpscaleBatchRequest(BaseModel):
    item_ids: list[int]
    resolution: str = "4k"   # "2k" | "4k"


@router.post("/upscale-batch")
async def upscale_batch(body: UpscaleBatchRequest):
    """Upscale multiple already-generated images sequentially.

    Sequential rather than parallel because Google's reCAPTCHA gets stricter
    when we hit the API in rapid bursts from one account — burnt this lesson
    on generate_image already. Each upscale is sync (~5-10s), and the frontend
    shows live toast progress so the wait is OK.

    Broadcasts WebSocket events per item so the gallery can update the
    upscale-status chip in realtime:
      • upscale_started      {item_id, resolution}
      • upscale_completed    {item_id, resolution, path, url}
      • upscale_error        {item_id, resolution, error}
    """
    if body.resolution.lower() not in ("2k", "4k"):
        raise HTTPException(400, "resolution phải là '2k' hoặc '4k'")
    if not body.item_ids:
        raise HTTPException(400, "item_ids rỗng")

    # Resolve all items + media_ids up-front; reject batch if any item has
    # no media_id rather than partially failing mid-way.
    resolved: list[tuple[dict, dict, str]] = []
    skipped: list[dict] = []
    for iid in body.item_ids:
        task, item = _find_item(iid)
        if not item or not task:
            skipped.append({"item_id": iid, "error": "Không tìm thấy item"})
            continue
        extra = json.loads(item.get("extra_json") or "{}")
        mid = extra.get("media_id")
        if not mid:
            skipped.append({"item_id": iid, "error": "Thiếu media_id (ảnh tạo trước khi tool support upscale)"})
            continue
        resolved.append((task, item, mid))

    if not resolved:
        raise HTTPException(
            400,
            "Tất cả items đã chọn đều không có media_id — "
            "tính năng upscale chỉ áp dụng cho ảnh tạo từ phiên bản 1.0.3 trở đi."
        )

    acc = _pick_account()
    if not acc:
        raise HTTPException(400, "Không có account khả dụng")

    completed: list[dict] = []
    errors: list[dict] = []

    try:
        from ..services import browser_manager as bm_mod, flow_client as fc_mod
        bm = bm_mod.BrowserManager()
        page = await bm.get_page(acc["id"], acc["email"], cookie_path=acc.get("cookie_path"))
        client = fc_mod.FlowClient(page, cookie_path=acc.get("cookie_path") or "", account_email=acc["email"])
        try:
            await client.ensure_token()
        except fc_mod.SessionDeadError as sde:
            db.update_account(acc["id"], enabled=0)
            await hub.broadcast("account_session_dead", {
                "account_id": acc["id"], "email": acc["email"], "reason": sde.reason,
            })
            raise HTTPException(401, f"Session {acc['email']} hết hạn — login lại")

        total = len(resolved)
        await hub.broadcast("upscale_batch_started", {
            "total": total, "resolution": body.resolution,
        })

        for idx, (task, item, mid) in enumerate(resolved, 1):
            iid = item["id"]
            await hub.broadcast("upscale_started", {
                "item_id": iid, "resolution": body.resolution,
                "index": idx, "total": total,
            })
            try:
                r = await _do_upscale_one(client, iid, mid, body.resolution, task)
                completed.append(r)
                await hub.broadcast("upscale_completed", {
                    "item_id": iid, "resolution": body.resolution,
                    "path": r["path"], "url": r["url"],
                    "index": idx, "total": total,
                })
            except fc_mod.SessionDeadError as sde:
                db.update_account(acc["id"], enabled=0)
                await hub.broadcast("account_session_dead", {
                    "account_id": acc["id"], "email": acc["email"], "reason": sde.reason,
                })
                errors.append({"item_id": iid, "error": f"Session hết hạn: {sde.reason}"})
                # Stop batch — without a working session, the rest will also fail
                break
            except Exception as e:
                log.warning(f"Upscale item={iid} failed: {e}")
                errors.append({"item_id": iid, "error": str(e)})
                await hub.broadcast("upscale_error", {
                    "item_id": iid, "resolution": body.resolution,
                    "error": str(e),
                    "index": idx, "total": total,
                })

        await hub.broadcast("upscale_batch_done", {
            "total": total,
            "completed": len(completed),
            "errors": len(errors),
            "resolution": body.resolution,
        })

        return {
            "ok": True,
            "completed": completed,
            "errors": errors + skipped,
            "resolution": body.resolution,
        }
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Upscale batch crashed")
        raise HTTPException(500, str(e))
