"""Long video generation — generate first scene + extend N-1 times + concat."""
from __future__ import annotations
import asyncio
import json
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel

from ..database import db
from ..config import (
    OUTPUT_DIR, TaskStatus, ItemStatus, video_model_for, EXTEND_MODEL_MAP,
    get_save_dir, clamp_duration,
)
from ..queue_manager import queue
from ..ws_hub import hub
from ..services.ffmpeg_utils import concat_videos

log = logging.getLogger("redone.longvideo")
router = APIRouter(prefix="/api/long-video", tags=["long_video"])


class LongVideoRequest(BaseModel):
    prompts: list[str]
    quality: str = "fast"
    aspect_ratio: str = "16:9"
    duration: int = 8                # per-scene duration: 4|6|8 (10 for omni_flash)
    start_image_path: Optional[str] = None
    task_name: Optional[str] = None


_active_jobs: dict[int, asyncio.Task] = {}


async def _run_long_video(task_id: int):
    task = db.get_task(task_id)
    items = db.get_task_items(task_id)
    if not task or not items:
        return
    db.update_task(task_id, status=TaskStatus.RUNNING.value)
    await hub.broadcast("task_started", {"task_id": task_id})

    accounts = [a for a in db.get_accounts() if a["enabled"]]
    if not accounts:
        db.update_task(task_id, status=TaskStatus.ERROR.value)
        await hub.broadcast("task_error", {"task_id": task_id, "error": "Không có account"})
        return
    acc = max(accounts, key=lambda a: a.get("credit") or 0)

    client = None
    try:
        from ..services import flow_client as fc_mod
        from ..services.flow_factory import make_flow_client, get_page_for_account
        from ..services import hub_client
        from ..config import cost_for_model_key
        page = await get_page_for_account(acc)
        client = make_flow_client(
            page=page,
            cookie_path=acc.get("cookie_path") or "",
            account_email=acc["email"],
        )
        await client.ensure_token()

        quality = task["quality"]
        extend_key = EXTEND_MODEL_MAP.get(quality, EXTEND_MODEL_MAP["lite_lp"])
        clips: list[str] = []
        prev_media_id: Optional[str] = None
        prev_workflow_id: Optional[str] = None

        for idx, item in enumerate(items):
            db.update_item(item["id"], status=ItemStatus.GENERATING.value)
            await hub.broadcast("scene_started", {"task_id": task_id, "scene": idx + 1, "item_id": item["id"]})
            try:
                # Hub internal-credit reserve per scene (no-op when Hub off/unreachable).
                _model = extend_key if idx > 0 else video_model_for(quality, "t2v", int(task.get("duration") or 8))
                _cost = cost_for_model_key(_model)
                _res = await hub_client.reserve(kind="video", model=_model, credit_cost=_cost, prompt=item.get("prompt", ""))
                _rid = _res.get("reservation_id")
                if not _res.get("ok", True):
                    raise RuntimeError(_res.get("message") or "Hết credit nội bộ — liên hệ lead để được cấp thêm.")
                if idx == 0:
                    extra = json.loads(item.get("extra_json") or "{}")
                    ref_media = None
                    start_image = extra.get("start_image")
                    if start_image and Path(start_image).exists():
                        ref_media = await client.upload_image(start_image)
                    mode = "i2v" if ref_media else "t2v"
                    duration_s = int(task.get("duration") or 8)
                    eff_quality = quality
                    if quality == "omni_flash" and ref_media:
                        log.warning(
                            "Omni Flash + start image not supported; "
                            "falling back to lite_lp for the first scene"
                        )
                        eff_quality = "lite_lp"
                    first_key = video_model_for(eff_quality, mode, duration_s)
                    wf = await client.generate_video(
                        prompt=item["prompt"],
                        model_key=first_key,
                        aspect_ratio=task["aspect_ratio"],
                        reference_image=ref_media,
                        duration=duration_s,
                    )
                else:
                    wf = await client.extend_video(
                        prompt=item["prompt"],
                        media_id=prev_media_id,
                        workflow_id=prev_workflow_id,
                        model_key=extend_key,
                        aspect_ratio=task["aspect_ratio"],
                    )

                state = await client.wait_for_completion(wf)
                if not state or state.get("state") == "FAILED":
                    raise RuntimeError(state.get("error") if state else "Scene generation failed")

                media_id = (
                    state.get("name")
                    or state.get("media_id")
                    or state.get("video_id")
                )
                if not media_id:
                    raise RuntimeError("Cảnh sinh xong nhưng response không có media_id")
                prev_media_id = media_id
                prev_workflow_id = state.get("workflowId") or state.get("workflow_id") or wf

                out_dir = get_save_dir("video", f"long_{task_id}", task.get("name"))
                clip_path = out_dir / f"scene_{idx + 1}.mp4"
                ok = await client.download_to(media_id, str(clip_path))
                if not ok:
                    raise RuntimeError("Download failed")
                clips.append(str(clip_path))
                db.update_item(item["id"], status=ItemStatus.COMPLETED.value, output_path=str(clip_path))
                await hub.broadcast("scene_done", {
                    "task_id": task_id, "scene": idx + 1, "item_id": item["id"],
                    "output_path": str(clip_path),
                })
                await hub_client.commit_result(_rid, "done", kind="video", model=_model,
                                               credit_cost=_cost, prompt=item.get("prompt", ""),
                                               path=str(clip_path), is_video=True)
            except Exception as e:
                db.update_item(item["id"], status=ItemStatus.ERROR.value, error_message=str(e))
                await hub.broadcast("scene_failed", {
                    "task_id": task_id, "scene": idx + 1, "item_id": item["id"], "error": str(e),
                })
                try:
                    await hub_client.commit_result(locals().get("_rid"), "error", kind="video",
                                                   model=locals().get("_model", ""),
                                                   credit_cost=locals().get("_cost", 0),
                                                   prompt=item.get("prompt", ""))
                except Exception:
                    pass
                raise

        # Concat
        final_path = get_save_dir("video", f"long_{task_id}", task.get("name")) / "final.mp4"
        await hub.broadcast("concat_started", {"task_id": task_id, "clips": len(clips)})
        ok = await concat_videos(clips, str(final_path), re_encode=True)
        if not ok:
            raise RuntimeError("Concat failed")

        db.update_task(task_id, status=TaskStatus.COMPLETED.value, output_folder=str(final_path))
        await hub.broadcast("task_completed", {
            "task_id": task_id, "final_path": str(final_path),
        })
    except Exception as e:
        log.exception("Long video task failed")
        db.update_task(task_id, status=TaskStatus.ERROR.value)
        await hub.broadcast("task_error", {"task_id": task_id, "error": str(e)})
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:
                pass
        _active_jobs.pop(task_id, None)


@router.post("/start")
async def start_long_video(body: LongVideoRequest):
    if len(body.prompts) < 2:
        raise HTTPException(400, "Cần ít nhất 2 prompt cho video dài")
    if len(body.prompts) > 20:
        raise HTTPException(400, "Tối đa 20 prompts")
    task_name = (body.task_name or "").strip() or f"long_video_{int(time.time())}"
    safe_duration = clamp_duration(body.quality, body.duration)
    from ..services import hub_client
    task_id = db.create_task(
        name=task_name,
        mode="long_video",
        quality=body.quality,
        aspect_ratio=body.aspect_ratio,
        duration=safe_duration,
        total_count=len(body.prompts),
        status=TaskStatus.PENDING.value,
        user_email=hub_client.current_user_email(),
    )
    for i, p in enumerate(body.prompts):
        extra = {}
        if i == 0 and body.start_image_path:
            extra["start_image"] = body.start_image_path
        db.add_task_item(task_id, p, extra=extra or None)
    position = await queue.enqueue("long_video", task_id, _run_long_video)
    return {
        "task_id": task_id,
        "scenes": len(body.prompts),
        "queue_position": position,
        "queued": position > 0,
    }


@router.post("/cancel/{task_id}")
async def cancel(task_id: int):
    ok = await queue.cancel(task_id)
    if not ok:
        db.update_task(task_id, status=TaskStatus.CANCELLED.value)
        await hub.broadcast("task_cancelled", {"task_id": task_id})
    return {"ok": True, "queue_cancel": ok}
