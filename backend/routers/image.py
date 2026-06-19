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
from ..config import OUTPUT_DIR, TaskStatus, ItemStatus, get_save_dir, project_item_stem
from ..ws_hub import hub
from ..queue_manager import queue

log = logging.getLogger("redone.image")
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
    if accounts:
        return accounts[0]
    # Vertex AI uses the baked service account — no Google login needed. On a
    # fresh machine with no accounts, return a synthetic one so gen proceeds.
    # Other modes (extension/playwright) still require a real account.
    from ..services.flow_factory import is_vertex_mode, synthetic_vertex_account
    if is_vertex_mode():
        return synthetic_vertex_account()
    return None


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


# ── DB-authoritative progress helpers (image variant) ───────────────
# Mirror content.py's helpers but broadcast with kind="image" so the image
# gallery's WS reducer can tell events apart. Counts come from the DB so the
# main batch loop and the per-item/retry-all endpoints can run concurrently
# without racing on a shared in-memory counter.

def _count_items_img(task_id: int) -> dict:
    items = db.get_task_items(task_id)
    done = sum(1 for it in items if it.get("status") == ItemStatus.COMPLETED.value)
    err = sum(1 for it in items if it.get("status") == ItemStatus.ERROR.value)
    gen = sum(1 for it in items if it.get("status") == ItemStatus.GENERATING.value)
    pend = sum(1 for it in items if it.get("status") == ItemStatus.PENDING.value)
    return {"done": done, "error": err, "generating": gen, "pending": pend, "total": len(items)}


async def _broadcast_progress_img(task_id: int) -> dict:
    c = _count_items_img(task_id)
    db.update_task(task_id, done_count=c["done"], error_count=c["error"])
    await hub.broadcast("task_progress", {
        "task_id": task_id, "done": c["done"], "error": c["error"],
        "total": c["total"], "kind": "image",
    })
    return c


async def _maybe_finalize(task_id: int) -> None:
    """Mark COMPLETED + broadcast only when nothing is pending/generating.
    See content.py._maybe_finalize for the race-safety rationale."""
    c = _count_items_img(task_id)
    if c["generating"] == 0 and c["pending"] == 0:
        task = db.get_task(task_id)
        if task and task.get("status") != TaskStatus.COMPLETED.value:
            db.update_task(task_id, status=TaskStatus.COMPLETED.value,
                           finished_at=str(time.time()))
            await hub.broadcast("task_completed", {
                "task_id": task_id, "done": c["done"], "error": c["error"],
                "kind": "image",
            })


async def generate_image_item(client, task: dict, item: dict) -> bool:
    """Generate + download ONE image item. Updates DB + broadcasts events.
    Returns True on success, False on handled failure; re-raises
    SessionDeadError. Reused by the batch loop and the retry endpoints —
    that's what lets a retry run while the parent task is still generating.
    """
    import random as _rng
    from ..services import flow_client as fc_mod
    from ..services import hub_client
    from ..services.error_messages import friendly_error

    task_id = task["id"]
    item_id = item["id"]
    model = task["image_model"]
    aspect = task["aspect_ratio"]

    # Mark GENERATING in the DB *before* the jitter sleep. A regen-from-done
    # flips this item COMPLETED→GENERATING; if we slept first the item would
    # still read COMPLETED during the sleep window, and a sibling item
    # finishing in that window could trip _maybe_finalize into broadcasting
    # task_completed prematurely. Writing the status first closes that race.
    db.update_item(item_id, status=ItemStatus.GENERATING.value, error_message=None)
    await hub.broadcast("item_status", {
        "task_id": task_id, "item_id": item_id,
        "status": ItemStatus.GENERATING.value,
        # Carry the prompt so the frontend pairs prompt↔image by item_id —
        # essential for the Storyboard view where concurrent gen can claim
        # slots out of order.
        "prompt": item.get("prompt", ""),
    })
    # Jitter to avoid hammering Google at the same ms
    await asyncio.sleep(_rng.uniform(0.0, 1.2))

    # Hub internal-credit reserve (no-op when Hub disabled/unreachable). Only a
    # genuine "out of credit" (Hub reachable) blocks the gen — any Hub problem
    # degrades to allow, so gen never breaks because of the Hub.
    # Images are FREE on Google Flow (nano_banana / imagen don't consume Flow
    # credits — per Flow's official pricing table), so deduct 0.
    _cost = 0
    _res = await hub_client.reserve(kind="image", model=model, credit_cost=_cost, prompt=item.get("prompt", ""))
    if not _res.get("ok", True):
        _msg = _res.get("message") or "Hết credit nội bộ — liên hệ lead để được cấp thêm."
        db.update_item(item_id, status=ItemStatus.ERROR.value, error_message=_msg)
        await hub.broadcast("item_error", {"task_id": task_id, "item_id": item_id, "error": _msg})
        await _broadcast_progress_img(task_id)
        return False
    _rid = _res.get("reservation_id")
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

        out_dir = get_save_dir("image", task_id, task.get("name"))
        out_path = out_dir / f"{project_item_stem(task, item_id)}.png"
        ok = await client.download_image(result["download_url"], str(out_path))
        if not ok:
            raise RuntimeError("Image download failed")

        # Nano Banana trả ảnh 16:9 ở 1376×768 (lệch tỉ lệ). Crop 2 bên về đúng
        # 1366×768. Chỉ áp dụng cho 16:9; các tỉ lệ khác giữ nguyên. Tái dùng
        # cùng resize_image(mode="cover") mà tab "Resize Hàng Loạt" dùng.
        out_w, out_h = result.get("width"), result.get("height")
        if aspect == "16:9":
            try:
                from ..services.image_utils import crop_cover_inplace
                if crop_cover_inplace(out_path, width=1366, height=768):
                    out_w, out_h = 1366, 768
            except Exception as e:
                log.warning(f"Crop 16:9 failed (giữ ảnh gốc): {e}")

        # Persist media_id so the upscale endpoint can find it later.
        extra["media_id"] = result.get("media_id")
        db.update_item(
            item_id,
            status=ItemStatus.COMPLETED.value,
            output_path=str(out_path),
            extra_json=json.dumps(extra),
            error_message=None,
        )
        await hub.broadcast("item_completed", {
            "task_id": task_id, "item_id": item_id,
            "output_path": str(out_path),
            "kind": "image",
            "width": out_w,
            "height": out_h,
            "media_id": result.get("media_id"),
            "prompt": item.get("prompt", ""),
        })
        await hub_client.commit_result(_rid, "done", kind="image", model=model,
                                       credit_cost=_cost, prompt=item.get("prompt", ""),
                                       path=str(out_path), is_video=False)
        return True
    except fc_mod.SessionDeadError:
        msg = ("Phiên đăng nhập của tài khoản đã hết hạn — đăng nhập lại ở "
               "tab Tài Khoản rồi gen lại.")
        db.update_item(item_id, status=ItemStatus.ERROR.value, error_message=msg)
        await hub.broadcast("item_error", {
            "task_id": task_id, "item_id": item_id, "error": msg,
        })
        await hub_client.commit_result(_rid, "error", kind="image", model=model,
                                       credit_cost=_cost, prompt=item.get("prompt", ""))
        raise
    except Exception as ex:
        raw = str(ex)
        friendly = friendly_error(raw)
        db.update_item(item_id, status=ItemStatus.ERROR.value, error_message=friendly)
        await hub.broadcast("item_error", {
            "task_id": task_id, "item_id": item_id,
            "error": friendly, "error_detail": raw,
        })
        await hub_client.commit_result(_rid, "error", kind="image", model=model,
                                       credit_cost=_cost, prompt=item.get("prompt", ""))
        return False
    finally:
        await _broadcast_progress_img(task_id)


async def _process_image_task(task_id: int):
    task = db.get_task(task_id)
    items = db.get_task_items(task_id)
    if not task or not items:
        return
    # Normal generation = bridge priority class 2 (below regen=0 and
    # upscale=1). Set once at the runner top; every proxy_fetch issued by the
    # gathered per-item coroutines inherits this via the copied context.
    from ..services.browser_bridge import set_gen_priority, next_gen_seq
    set_gen_priority(2, next_gen_seq())
    db.update_task(task_id, status=TaskStatus.RUNNING.value, started_at=str(time.time()))
    await hub.broadcast("task_started", {"task_id": task_id, "kind": "image"})

    acc = _pick_account()
    if not acc:
        db.update_task(task_id, status=TaskStatus.ERROR.value)
        await hub.broadcast("task_error", {"task_id": task_id, "error": "Không có account khả dụng"})
        return

    client = None
    try:
        from ..services import flow_client as fc_mod
        from ..services.flow_factory import make_flow_client, get_page_for_account
        page = await get_page_for_account(acc)
        client = make_flow_client(
            page=page,
            cookie_path=acc.get("cookie_path") or "",
            account_email=acc["email"],
        )
        try:
            await client.ensure_token()
        except fc_mod.SessionDeadError as sde:
            await _handle_session_dead_img(task_id, acc, sde)
            return

        parallelism = max(1, min(task.get("concurrent") or 1, len(items)))
        # Random pause between batches — see content.py for rationale.
        # Shares the same settings keys so user only tunes once.
        from .content import _read_cooldown_range
        cd_min, cd_max = _read_cooldown_range()
        log.info(
            f"Image task {task_id}: {len(items)} items "
            f"(batch_size={parallelism}, cooldown={cd_min}-{cd_max}s)"
        )

        # Each prompt is attempted INDEPENDENTLY — no 403 circuit breaker that
        # cancels the rest after N consecutive failures. Failed items are
        # retried via the per-item "Gen lại" button / "Gen lại tất cả lỗi".
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
            if queue.is_paused(task_id):
                await queue.mark_paused(task_id)
                return
            batch_results = await asyncio.gather(
                *(generate_image_item(client, task, it) for it in batch),
                return_exceptions=True,
            )

            for r in batch_results:
                if isinstance(r, fc_mod.SessionDeadError):
                    session_dead_err = r
                    break
            if session_dead_err:
                break

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
                    "kind": "image",
                })
                log.info(
                    f"Image task {task_id}: batch {batch_idx + 1}/{len(batches)} "
                    f"done, sleeping {wait_s}s (random in [{cd_min}, {cd_max}])"
                )
                await asyncio.sleep(wait_s)

        if session_dead_err is not None:
            await _handle_session_dead_img(task_id, acc, session_dead_err)
            return

        await _maybe_finalize(task_id)
    except fc_mod.SessionDeadError as sde:
        await _handle_session_dead_img(task_id, acc, sde)
    except Exception as e:
        log.exception("Image task crashed")
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
    from ..services import hub_client
    task_id = db.create_task(
        name=task_name,
        mode="image",
        image_model=body.model,
        aspect_ratio=body.aspect_ratio,
        concurrent=max(1, min(body.concurrent or 1, 8)),
        total_count=len(expanded),
        status=TaskStatus.PENDING.value,
        user_email=hub_client.current_user_email(),
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
    base_dir = get_save_dir("image", task["id"], task.get("name"))
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
        out_dir = get_save_dir("image", task["id"], task.get("name")) / "upscaled"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"item_{item_id}_{resolution}.png"
        ok = await client.download_image(url, str(out_path))
        if not ok:
            raise RuntimeError("Tải ảnh upscaled thất bại")
    else:
        out_path = _save_upscaled(item_id, resolution, raw, task)

    # Giữ ĐÚNG tỉ lệ ảnh gốc — chỉ scale lên theo "cạnh dài" 2K=2560 / 4K=3840.
    # (Code cũ crop cứng về 16:9 nên ảnh 1:1, 9:16... bị méo/cắt khi so sánh.)
    up_w, up_h = r.get("width"), r.get("height")
    _LONG_EDGE = {"2k": 2560, "4k": 3840}.get(resolution.lower(), 3840)
    try:
        from ..services.image_utils import crop_cover_inplace
        from PIL import Image
        with Image.open(out_path) as _im:
            sw, sh = _im.size
        if sw >= sh:
            tw, th = _LONG_EDGE, max(1, round(_LONG_EDGE * sh / sw))
        else:
            tw, th = max(1, round(_LONG_EDGE * sw / sh)), _LONG_EDGE
        # tw:th khớp tỉ lệ gốc → crop_cover chỉ scale (không cắt) → không méo.
        crop_cover_inplace(out_path, width=tw, height=th)
        up_w, up_h = tw, th
    except Exception as e:
        log.warning(f"Resize upscale (giữ tỉ lệ gốc) failed: {e}")

    rel = out_path.relative_to(OUTPUT_DIR).as_posix()
    return {
        "item_id": item_id,
        "path": str(out_path),
        "url": f"/files/{rel}",
        "width": up_w,
        "height": up_h,
    }


@router.post("/upscale/{item_id}")
async def upscale_existing(item_id: int, resolution: str = "4k"):
    """Upscale a single already-generated image to 2K/4K via Google Labs."""
    # Upscale = bridge priority class 1: above normal gen (2), below regen (0).
    from ..services.browser_bridge import set_gen_priority, next_gen_seq
    set_gen_priority(1, next_gen_seq())
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
    client = None
    try:
        from ..services import flow_client as fc_mod
        from ..services.flow_factory import make_flow_client, get_page_for_account
        page = await get_page_for_account(acc)
        client = make_flow_client(
            page=page,
            cookie_path=acc.get("cookie_path") or "",
            account_email=acc["email"],
        )
        await client.ensure_token()
        result = await _do_upscale_one(client, item_id, media_id, resolution, task)
        return {"ok": True, **result}
    except HTTPException:
        raise
    except Exception as e:
        log.exception(f"Upscale item={item_id} failed")
        raise HTTPException(500, str(e))
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:
                pass


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
    # Upscale = bridge priority class 1: above normal gen (2), below regen (0).
    from ..services.browser_bridge import set_gen_priority, next_gen_seq
    set_gen_priority(1, next_gen_seq())
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

    client = None
    try:
        from ..services import flow_client as fc_mod
        from ..services.flow_factory import make_flow_client, get_page_for_account
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
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:
                pass
