"""Shakker.ai image-generation endpoints.

Mirrors routers/image.py's structure (DB-authoritative progress counters,
per-item generators reusable by batch + retry, WS broadcasts) but talks to
Shakker via ShakkerClient instead of Google Flow.

Key differences from the Flow image path:
  • Separate account pool (shakker_accounts) + ShakkerClient — so Shakker
    retry lives HERE, not in tasks.py (keeps the Flow retry path untouched).
  • No reCAPTCHA / 403 circuit-breaker, no cooldown — Shakker queues
    server-side (concurrent=1) and accepts back-to-back submits, so we just
    fan out and poll.
  • Task config (checkpoint, LoRAs, reference image, aspect) is the SAME for
    every prompt in a batch ("sticky settings"), stored once on the task row
    in character_images_json (reused as a generic JSON blob).

WS events (all carry kind="shakker" so the frontend reducer can tell Shakker
apart from Flow image/video):
  task_started / task_progress / task_completed / task_error
  item_status / item_progress / item_completed / item_error
  shakker_token_expired   (account needs re-login — frontend shows banner)
"""
from __future__ import annotations
import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel

from ..database import db
from ..config import OUTPUT_DIR, TaskStatus, ItemStatus, get_save_dir, project_item_stem
from ..ws_hub import hub
from ..queue_manager import shakker_queue as queue
from ..services.shakker_client import ShakkerClient, ShakkerError, DEFAULT_BASE_TYPE
from ..services.error_messages import friendly_shakker_error

log = logging.getLogger("redone.shakker_router")
router = APIRouter(prefix="/api/shakker", tags=["shakker"])

_active_tasks: dict[int, asyncio.Task] = {}

# Shakker accounts are concurrent=1 server-side: only ONE task may be
# "initiating" at a time. The web UI spaces its /shake submits ~1s apart.
# We enforce the same minimum gap GLOBALLY (across all parallel items +
# tasks) via this lock so fanned-out batches don't collide with
# "task is being initiated" errors.
_submit_lock = asyncio.Lock()
_last_submit_ts = [0.0]
_SUBMIT_MIN_GAP_S = 1.2


async def _spaced_submit(client: ShakkerClient, payload: dict) -> str:
    """Submit one /shake call, serialized + spaced ≥ _SUBMIT_MIN_GAP_S apart."""
    async with _submit_lock:
        gap = time.time() - _last_submit_ts[0]
        if gap < _SUBMIT_MIN_GAP_S:
            await asyncio.sleep(_SUBMIT_MIN_GAP_S - gap)
        gid = await client.submit_generate(payload)
        _last_submit_ts[0] = time.time()
        return gid

# ── Catalog cache (search results) ───────────────────────────────────
# Shakker catalog (models/LoRAs) changes slowly; cache 10 min so repeated
# searches / pagination don't hammer Shakker. Keyed by the query tuple.
_catalog_cache: dict[tuple, tuple[float, dict]] = {}
_CATALOG_TTL_S = 600.0


def _cache_get(key: tuple) -> Optional[dict]:
    hit = _catalog_cache.get(key)
    if hit and (time.time() - hit[0]) < _CATALOG_TTL_S:
        return hit[1]
    return None


def _cache_put(key: tuple, value: dict) -> None:
    _catalog_cache[key] = (time.time(), value)
    # Bound cache size
    if len(_catalog_cache) > 200:
        oldest = sorted(_catalog_cache.items(), key=lambda kv: kv[1][0])[:50]
        for k, _ in oldest:
            _catalog_cache.pop(k, None)


# ── Account picking + client ─────────────────────────────────────────

def _pick_shakker_account() -> Optional[dict]:
    """Pick the enabled shakker account with the most usable power + a token."""
    accounts = [
        a for a in db.get_shakker_accounts()
        if a.get("enabled") and a.get("token")
    ]
    accounts.sort(key=lambda a: -(a.get("usable_power") or 0))
    return accounts[0] if accounts else None


def _make_client(acc: dict) -> ShakkerClient:
    return ShakkerClient(
        token=acc["token"],
        webid=acc.get("webid"),
        user_uuid=acc.get("user_uuid"),
    )


async def _flag_token_expired(acc: dict, reason: str) -> None:
    """Mark a shakker account's token expired + broadcast a banner event."""
    try:
        db.update_shakker_account(acc["id"], status="TOKEN_EXPIRED", status_msg=reason)
    except Exception:
        pass
    await hub.broadcast("shakker_token_expired", {
        "account_id": acc["id"],
        "email": acc.get("email"),
        "reason": reason,
    })


def _is_token_dead(err: Exception) -> bool:
    raw = str(getattr(err, "raw", "") or err).lower()
    return any(s in raw for s in ("401", "403", "hết hạn", "phiên shakker",
                                  "unauthorized", "未登录", "登录"))


# ── DB-authoritative progress helpers (kind="shakker") ───────────────

def _count_items(task_id: int) -> dict:
    items = db.get_task_items(task_id)
    done = sum(1 for it in items if it.get("status") == ItemStatus.COMPLETED.value)
    err = sum(1 for it in items if it.get("status") == ItemStatus.ERROR.value)
    gen = sum(1 for it in items if it.get("status") == ItemStatus.GENERATING.value)
    pend = sum(1 for it in items if it.get("status") == ItemStatus.PENDING.value)
    return {"done": done, "error": err, "generating": gen, "pending": pend, "total": len(items)}


async def _broadcast_progress(task_id: int) -> dict:
    c = _count_items(task_id)
    db.update_task(task_id, done_count=c["done"], error_count=c["error"])
    await hub.broadcast("task_progress", {
        "task_id": task_id, "done": c["done"], "error": c["error"],
        "total": c["total"], "kind": "shakker",
    })
    return c


async def _maybe_finalize(task_id: int) -> None:
    c = _count_items(task_id)
    if c["generating"] == 0 and c["pending"] == 0:
        task = db.get_task(task_id)
        if task and task.get("status") != TaskStatus.COMPLETED.value:
            db.update_task(task_id, status=TaskStatus.COMPLETED.value,
                           finished_at=str(time.time()))
            await hub.broadcast("task_completed", {
                "task_id": task_id, "done": c["done"], "error": c["error"],
                "kind": "shakker",
            })


def _task_config(task: dict) -> dict:
    """Parse the sticky gen settings stored on the task row."""
    try:
        return json.loads(task.get("character_images_json") or "{}")
    except Exception:
        return {}


# ── Per-item generator (reused by batch + retry) ─────────────────────

async def generate_shakker_item(client: ShakkerClient, task: dict, item: dict) -> bool:
    """Generate + download ONE Shakker image. Updates DB + broadcasts.
    Returns True on success, False on handled failure. Raises ShakkerError
    only for token-dead so the caller can stop the batch + flag the account.
    """
    task_id = task["id"]
    item_id = item["id"]
    cfg = _task_config(task)
    aspect = task.get("aspect_ratio") or "1:1"

    # Paused mid-batch: leave this item PENDING and bail before reserving so it
    # can be resumed later.
    if queue.is_paused(task_id):
        return False

    await hub.broadcast("item_status", {
        "task_id": task_id, "item_id": item_id,
        "status": ItemStatus.GENERATING.value, "kind": "shakker",
    })
    db.update_item(item_id, status=ItemStatus.GENERATING.value, error_message=None)

    # Hub internal-credit reserve (separate from Shakker's own "power"; no-op
    # when Hub off/unreachable). Only a genuine out-of-credit blocks gen.
    from ..services import hub_client
    _model = str(task.get("image_model") or "")
    # Reserve a small estimate up-front (the real Shakker "power" cost is only
    # known after gen); the commit below trues it up to the actual power so a
    # member's used credit reflects the shared account's real spend.
    _cost = 1
    _res = await hub_client.reserve(kind="shakker", model=_model, credit_cost=_cost, prompt=item.get("prompt", ""))
    _rid = _res.get("reservation_id")
    if not _res.get("ok", True):
        _msg = _res.get("message") or "Hết credit nội bộ — liên hệ lead để được cấp thêm."
        db.update_item(item_id, status=ItemStatus.ERROR.value, error_message=_msg)
        await hub.broadcast("item_error", {"task_id": task_id, "item_id": item_id, "error": _msg, "kind": "shakker"})
        await _broadcast_progress(task_id)
        return False

    try:
        payload = client.build_payload(
            item["prompt"],
            checkpoint_id=cfg.get("checkpoint_id") or 1508012,
            base_type=cfg.get("base_type") or DEFAULT_BASE_TYPE,
            aspect=aspect,
            loras=cfg.get("loras") or [],
            negative_prompt=cfg.get("negative_prompt") or "",
            ref_image_url=cfg.get("ref_image_url"),
            ref_strength=cfg.get("ref_strength", 0.25),
        )
        gid = await _spaced_submit(client, payload)

        async def _on_progress(status):
            await hub.broadcast("item_progress", {
                "task_id": task_id, "item_id": item_id, "kind": "shakker",
                "percent": status.get("percent") or 0,
                "queue_num": status.get("queue_num") or 0,
                "state": status.get("state"),
            })

        result = await client.wait_for_completion(gid, on_progress=_on_progress)

        if result["state"] != "success" or not result.get("images"):
            raw = result.get("error") or "Shakker không trả ảnh"
            raise ShakkerError(friendly_shakker_error(raw), raw=raw)

        # One image per item (count=1). Take the first.
        img = result["images"][0]
        if img.get("nsfw"):
            raise ShakkerError(
                "Ảnh bị Shakker đánh dấu nhạy cảm (NSFW) — chỉnh prompt rồi gen lại.",
                raw="nsfw flagged",
            )

        data = await client.download_result(img["url"])
        out_dir = get_save_dir("image", f"shakker_{task_id}", task.get("name"))
        out_path = out_dir / f"{project_item_stem(task, item_id)}.png"
        out_path.write_bytes(data)

        # Persist gen metadata (seed/sampler info from shakker) for tooltip.
        extra = json.loads(item.get("extra_json") or "{}")
        extra["shakker_info"] = img.get("info") or ""
        extra["power"] = result.get("power") or 0
        extra["generate_id"] = gid
        db.update_item(
            item_id,
            status=ItemStatus.COMPLETED.value,
            output_path=str(out_path),
            credit_cost=result.get("power") or 0,
            extra_json=json.dumps(extra),
            error_message=None,
        )
        await hub.broadcast("item_completed", {
            "task_id": task_id, "item_id": item_id,
            "output_path": str(out_path), "kind": "shakker",
            "power": result.get("power") or 0,
        })
        _real_power = int(result.get("power") or 0)
        await hub_client.commit_result(_rid, "done", kind="shakker", model=_model,
                                       credit_cost=_real_power, prompt=item.get("prompt", ""),
                                       path=str(out_path), is_video=False)
        return True

    except ShakkerError as ex:
        friendly = str(ex)
        raw = getattr(ex, "raw", friendly)
        db.update_item(item_id, status=ItemStatus.ERROR.value, error_message=friendly)
        await hub.broadcast("item_error", {
            "task_id": task_id, "item_id": item_id,
            "error": friendly, "error_detail": raw, "kind": "shakker",
        })
        await hub_client.commit_result(_rid, "error", kind="shakker", model=_model,
                                       credit_cost=_cost, prompt=item.get("prompt", ""))
        if _is_token_dead(ex):
            raise  # let caller stop the batch + flag account
        return False
    except Exception as ex:
        raw = str(ex)
        friendly = friendly_shakker_error(raw)
        db.update_item(item_id, status=ItemStatus.ERROR.value, error_message=friendly)
        await hub.broadcast("item_error", {
            "task_id": task_id, "item_id": item_id,
            "error": friendly, "error_detail": raw, "kind": "shakker",
        })
        await hub_client.commit_result(_rid, "error", kind="shakker", model=_model,
                                       credit_cost=_cost, prompt=item.get("prompt", ""))
        return False
    finally:
        await _broadcast_progress(task_id)


# ── Batch runner (queue worker) ──────────────────────────────────────

async def _process_shakker_task(task_id: int):
    task = db.get_task(task_id)
    items = db.get_task_items(task_id)
    if not task or not items:
        return
    db.update_task(task_id, status=TaskStatus.RUNNING.value, started_at=str(time.time()))
    await hub.broadcast("task_started", {"task_id": task_id, "kind": "shakker"})

    acc = _pick_shakker_account()
    if not acc:
        db.update_task(task_id, status=TaskStatus.ERROR.value)
        await hub.broadcast("task_error", {
            "task_id": task_id, "kind": "shakker",
            "error": "Chưa có tài khoản Shakker — mở shakker.ai trong Chrome để đồng bộ",
        })
        return

    client = _make_client(acc)
    try:
        # Concurrency is UNLIMITED ("không giới hạn theo Shakker"): fan out ALL
        # prompts at once. The actual /shake submits are still spaced ≥1.2s
        # apart GLOBALLY by _spaced_submit to avoid "task is being initiated"
        # collisions; only the polling/waiting runs concurrently — so every
        # item flips to "Đang tạo" right away while images stream back.
        pending = [it for it in items if it.get("status") != ItemStatus.COMPLETED.value]

        results = await asyncio.gather(
            *(generate_shakker_item(client, task, it) for it in pending),
            return_exceptions=True,
        )
        if queue.is_paused(task_id):
            await queue.mark_paused(task_id)
            return
        token_dead = any(
            isinstance(r, ShakkerError) and _is_token_dead(r) for r in results
        )

        if token_dead:
            await _flag_token_expired(acc, "Token Shakker hết hạn khi đang gen")
            db.update_task(task_id, status=TaskStatus.ERROR.value)
            await hub.broadcast("task_error", {
                "task_id": task_id, "kind": "shakker",
                "error": "Phiên Shakker hết hạn — mở shakker.ai đăng nhập lại rồi gen lại",
            })
            return

        # Refresh account credit after the batch (best-effort).
        try:
            credits = await client.check_credits()
            db.update_shakker_account(acc["id"], **{
                "tier": credits["tier"], "total_power": credits["total_power"],
                "used_power": credits["used_power"], "usable_power": credits["usable_power"],
                "concurrent": credits["concurrent"], "expiry": credits["expiry"],
            })
            await hub.broadcast("shakker_account_updated", {"id": acc["id"], **credits})
        except Exception:
            pass

        await _maybe_finalize(task_id)
    except Exception as e:
        log.exception("Shakker task crashed")
        db.update_task(task_id, status=TaskStatus.ERROR.value)
        await hub.broadcast("task_error", {"task_id": task_id, "error": str(e), "kind": "shakker"})
    finally:
        _active_tasks.pop(task_id, None)


# ── Detached retry runner (works WHILE task still running) ────────────

async def _retry_shakker_items_runner(task: dict, item_ids: list[int], force: bool = False) -> None:
    # Shakker does NOT go through the Chrome bridge (direct httpx, self-limited
    # to ~1 submit/1.2s + server concurrency=1), so there is no bridge priority
    # to set — a regen just runs detached as soon as the spacing lock frees.
    # With force=True, already-COMPLETED items are regenerated (overwrite in
    # place); with force=False only non-completed items run (retry-failed).
    task_id = task["id"]
    acc = _pick_shakker_account()
    if not acc:
        await hub.broadcast("task_error", {
            "task_id": task_id, "kind": "shakker",
            "error": "Chưa có tài khoản Shakker để gen lại",
        })
        return
    client = _make_client(acc)
    try:
        targets = []
        for iid in item_ids:
            it = db.get_item(iid)
            if not it:
                continue
            if not force and it.get("status") == ItemStatus.COMPLETED.value:
                continue
            targets.append(it)
        if not targets:
            await _maybe_finalize(task_id)
            return

        results = await asyncio.gather(
            *(generate_shakker_item(client, task, it) for it in targets),
            return_exceptions=True,
        )
        if any(isinstance(r, ShakkerError) and _is_token_dead(r) for r in results):
            await _flag_token_expired(acc, "Token hết hạn khi gen lại")
        await _maybe_finalize(task_id)
    except Exception:
        log.exception(f"shakker retry runner crashed task={task_id}")
        try:
            await _maybe_finalize(task_id)
        except Exception:
            pass


# ── Request models ───────────────────────────────────────────────────

class LoRASpec(BaseModel):
    model_id: int
    version_id: int
    weight: float = 0.8
    base_type: Optional[str] = None
    name: Optional[str] = ""
    trigger_word: Optional[str] = ""


class StartShakkerRequest(BaseModel):
    prompts: list[str]
    checkpoint_id: int = 1508012           # default Shakker Zeno-1
    base_type: int = DEFAULT_BASE_TYPE
    aspect_ratio: str = "1:1"
    loras: list[LoRASpec] = []
    negative_prompt: str = ""
    ref_image_url: Optional[str] = None    # already uploaded via /upload-ref
    ref_strength: float = 0.25
    count_per_prompt: int = 1
    concurrent: int = 1          # ignored — concurrency is unlimited (all prompts fan out at once)
    task_name: Optional[str] = None


# ── Endpoints: generation ────────────────────────────────────────────

@router.post("/generate")
async def start_shakker_task(body: StartShakkerRequest):
    if not body.prompts:
        raise HTTPException(400, "Cần ít nhất 1 prompt")
    if body.count_per_prompt < 1 or body.count_per_prompt > 4:
        raise HTTPException(400, "count_per_prompt phải từ 1 đến 4")
    if not _pick_shakker_account():
        raise HTTPException(400, "Chưa có tài khoản Shakker khả dụng — mở shakker.ai trong Chrome")

    expanded = []
    for p in body.prompts:
        p = (p or "").strip()
        if not p:
            continue
        for _ in range(body.count_per_prompt):
            expanded.append(p)
    if not expanded:
        raise HTTPException(400, "Tất cả prompt đều rỗng")

    # Sticky settings stored once on the task row.
    config = {
        "checkpoint_id": body.checkpoint_id,
        "base_type": body.base_type,
        "loras": [lo.model_dump() for lo in body.loras],
        "negative_prompt": body.negative_prompt,
        "ref_image_url": body.ref_image_url,
        "ref_strength": body.ref_strength,
    }

    task_name = (body.task_name or "").strip() or f"shakker_{int(time.time())}"
    from ..services import hub_client
    task_id = db.create_task(
        name=task_name,
        mode="shakker",
        image_model=str(body.checkpoint_id),
        aspect_ratio=body.aspect_ratio,
        concurrent=len(expanded),    # unlimited — all prompts gen concurrently
        total_count=len(expanded),
        status=TaskStatus.PENDING.value,
        character_images_json=json.dumps(config),
        user_email=hub_client.current_user_email(),
    )
    for p in expanded:
        db.add_task_item(task_id, p)

    position = await queue.enqueue("shakker", task_id, _process_shakker_task)
    return {
        "task_id": task_id,
        "items": len(expanded),
        "queue_position": position,
        "queued": position > 0,
    }


@router.post("/cancel/{task_id}")
async def cancel_shakker(task_id: int):
    ok = await queue.cancel(task_id)
    if not ok:
        db.update_task(task_id, status=TaskStatus.CANCELLED.value)
        await hub.broadcast("task_cancelled", {"task_id": task_id, "kind": "shakker"})
    return {"ok": True, "queue_cancel": ok}


@router.post("/item/{item_id}/retry")
async def retry_shakker_item(item_id: int):
    """Regenerate a SINGLE shakker item — ERROR/PENDING or already-COMPLETED
    (explicit "Gen lại" → overwrite in place)."""
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(404, "Không tìm thấy item")
    task = db.get_task(item["task_id"])
    if not task:
        raise HTTPException(404, "Không tìm thấy task")
    if task.get("status") in (TaskStatus.COMPLETED.value, TaskStatus.ERROR.value,
                              TaskStatus.CANCELLED.value):
        db.update_task(task["id"], status=TaskStatus.RUNNING.value, finished_at=None)
        await hub.broadcast("task_started", {"task_id": task["id"], "retried": True, "kind": "shakker"})
    asyncio.create_task(_retry_shakker_items_runner(task, [item_id], force=True))
    return {"ok": True, "item_id": item_id}


@router.post("/{task_id}/retry-failed")
async def retry_shakker_failed(task_id: int):
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    items = db.get_task_items(task_id)
    failed_ids = [it["id"] for it in items if it.get("status") == ItemStatus.ERROR.value]
    if not failed_ids:
        return {"ok": True, "retried": 0}
    if task.get("status") in (TaskStatus.COMPLETED.value, TaskStatus.ERROR.value,
                              TaskStatus.CANCELLED.value):
        db.update_task(task_id, status=TaskStatus.RUNNING.value, finished_at=None)
    await hub.broadcast("task_started", {"task_id": task_id, "retried": True, "kind": "shakker"})
    asyncio.create_task(_retry_shakker_items_runner(task, failed_ids))
    return {"ok": True, "retried": len(failed_ids)}


class ShakkerRetryItemsRequest(BaseModel):
    item_ids: list[int]


@router.post("/{task_id}/retry-items")
async def retry_shakker_items(task_id: int, body: ShakkerRetryItemsRequest):
    """Regenerate a SPECIFIC LIST of shakker items (gallery "Gen lại" toolbar
    over the ticked cards). force=True → overwrite COMPLETED in place."""
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    ids = [iid for iid in (body.item_ids or []) if db.get_item(iid)]
    if not ids:
        return {"ok": True, "retried": 0}
    if task.get("status") in (TaskStatus.COMPLETED.value, TaskStatus.ERROR.value,
                              TaskStatus.CANCELLED.value):
        db.update_task(task_id, status=TaskStatus.RUNNING.value, finished_at=None)
    await hub.broadcast("task_started", {"task_id": task_id, "retried": True, "kind": "shakker"})
    asyncio.create_task(_retry_shakker_items_runner(task, ids, force=True))
    return {"ok": True, "retried": len(ids)}


# ── Endpoints: catalog + account ─────────────────────────────────────

@router.get("/account")
async def shakker_account():
    """Current best shakker account + live credits for the page chip."""
    acc = _pick_shakker_account()
    if not acc:
        return {"ok": False, "account": None}
    return {
        "ok": True,
        "account": {
            "id": acc["id"], "email": acc.get("email"),
            "tier": acc.get("tier"), "usable_power": acc.get("usable_power"),
            "total_power": acc.get("total_power"), "expiry": acc.get("expiry"),
            "status": acc.get("status"),
        },
    }


@router.get("/models")
async def shakker_models(search: str = "", base_type: Optional[int] = None,
                         page: int = 1, page_size: int = 24):
    acc = _pick_shakker_account()
    if not acc:
        raise HTTPException(400, "Chưa có tài khoản Shakker")
    key = ("models", search, base_type, page, page_size)
    cached = _cache_get(key)
    if cached:
        return cached
    client = _make_client(acc)
    try:
        data = await client.list_models(search=search, base_type=base_type,
                                        page=page, page_size=page_size)
    except ShakkerError as e:
        if _is_token_dead(e):
            await _flag_token_expired(acc, str(e))
        raise HTTPException(502, friendly_shakker_error(getattr(e, "raw", str(e))))
    _cache_put(key, data)
    return data


@router.get("/loras")
async def shakker_loras(search: str = "", base_type: Optional[int] = None,
                        page: int = 1, page_size: int = 24):
    acc = _pick_shakker_account()
    if not acc:
        raise HTTPException(400, "Chưa có tài khoản Shakker")
    key = ("loras", search, base_type, page, page_size)
    cached = _cache_get(key)
    if cached:
        return cached
    client = _make_client(acc)
    try:
        data = await client.list_loras(search=search, base_type=base_type,
                                       page=page, page_size=page_size)
    except ShakkerError as e:
        if _is_token_dead(e):
            await _flag_token_expired(acc, str(e))
        raise HTTPException(502, friendly_shakker_error(getattr(e, "raw", str(e))))
    _cache_put(key, data)
    return data


@router.post("/upload-ref")
async def upload_reference(file: UploadFile = File(...)):
    """Upload a single reference image to Shakker OSS, return the CDN URL to
    pass back in /generate's ref_image_url."""
    acc = _pick_shakker_account()
    if not acc:
        raise HTTPException(400, "Chưa có tài khoản Shakker")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "File rỗng")
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(400, "Ảnh quá lớn (tối đa 20MB)")
    ext = "jpeg"
    fn = (file.filename or "").lower()
    if fn.endswith(".png"):
        ext = "png"
    elif fn.endswith(".webp"):
        ext = "webp"
    client = _make_client(acc)
    try:
        url = await client.upload_reference_image(raw, ext=ext)
    except ShakkerError as e:
        if _is_token_dead(e):
            await _flag_token_expired(acc, str(e))
        raise HTTPException(502, friendly_shakker_error(getattr(e, "raw", str(e))))
    return {"ok": True, "url": url}
