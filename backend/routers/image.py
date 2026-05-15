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
        await client.ensure_token()

        model = task["image_model"]
        aspect = task["aspect_ratio"]
        parallelism = max(1, min(task.get("concurrent") or 1, len(items)))
        log.info(f"Image task {task_id}: {len(items)} items, parallelism={parallelism}")

        counters = {"done": 0, "error": 0}
        counter_lock = asyncio.Lock()
        semaphore = asyncio.Semaphore(parallelism)

        import random as _rng

        async def _process_one(item):
            async with semaphore:
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

                    db.update_item(
                        item["id"],
                        status=ItemStatus.COMPLETED.value,
                        output_path=str(out_path),
                    )
                    async with counter_lock:
                        counters["done"] += 1
                        d, e = counters["done"], counters["error"]
                    await hub.broadcast("item_completed", {
                        "task_id": task_id, "item_id": item["id"],
                        "output_path": str(out_path),
                        "kind": "image",
                        "width": result.get("width"),
                        "height": result.get("height"),
                    })
                except Exception as ex:
                    db.update_item(item["id"], status=ItemStatus.ERROR.value, error_message=str(ex))
                    async with counter_lock:
                        counters["error"] += 1
                        d, e = counters["done"], counters["error"]
                    await hub.broadcast("item_error", {
                        "task_id": task_id, "item_id": item["id"], "error": str(ex),
                    })

                db.update_task(task_id, done_count=d, error_count=e)
                await hub.broadcast("task_progress", {
                    "task_id": task_id, "done": d, "error": e, "total": len(items),
                })

        await asyncio.gather(
            *(_process_one(item) for item in items),
            return_exceptions=True,
        )

        done = counters["done"]
        err = counters["error"]
        db.update_task(task_id, status=TaskStatus.COMPLETED.value, finished_at=str(time.time()))
        await hub.broadcast("task_completed", {
            "task_id": task_id, "done": done, "error": err, "kind": "image",
        })
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


@router.post("/upscale/{item_id}")
async def upscale_existing(item_id: int, resolution: str = "4k"):
    """Upscale an already-generated image to 2K/4K via Google Labs."""
    # Find the item + its task to get the media_id
    task = None
    item = None
    for t in db.list_tasks(limit=200):
        items = db.get_task_items(t["id"])
        for it in items:
            if it["id"] == item_id:
                task = t
                item = it
                break
        if item:
            break
    if not item:
        raise HTTPException(404, "Item not found")
    extra = json.loads(item.get("extra_json") or "{}")
    media_id = extra.get("media_id")
    if not media_id:
        raise HTTPException(400, "Item không có media_id (cần generate qua endpoint /start)")

    acc = _pick_account()
    if not acc:
        raise HTTPException(400, "Không có account khả dụng")
    try:
        from ..services import browser_manager as bm_mod, flow_client as fc_mod
        bm = bm_mod.BrowserManager()
        page = await bm.get_page(acc["id"], acc["email"], cookie_path=acc.get("cookie_path"))
        client = fc_mod.FlowClient(page, cookie_path=acc.get("cookie_path") or "", account_email=acc["email"])
        await client.ensure_token()
        r = await client.upscale_image(media_id, resolution=resolution)
        out_dir = OUTPUT_DIR / "image" / "upscaled"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"upscaled_{item_id}_{resolution}.png"
        ok = await client.download_image(r["download_url"], str(out_path))
        if not ok:
            raise RuntimeError("Download failed")
        return {"ok": True, "path": str(out_path), "url": f"/files/{out_path.relative_to(OUTPUT_DIR).as_posix()}"}
    except Exception as e:
        raise HTTPException(500, str(e))
