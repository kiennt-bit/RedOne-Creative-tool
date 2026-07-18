"""Chỉnh màu hàng loạt — batch color grading for images + videos.

One color spec (13 base sliders + per-band HSL) is applied to N files through
the SAME sequential queue / pause / resume / cancel machinery as every other
task (mode="batch_color"), so it shows up in "Quản lý task" as usual.

Reuses the video-editor render stack end to end: color_filter() builds the
filter chain, ffcmd.run() streams progress + kills ffmpeg on cancel. The color
spec is persisted on the task row (character_images_json) so Resume re-renders
without the frontend resubmitting — same trick as video_render.

Preview endpoints render on the SERVER with the same ffmpeg + same chain, so
what the user sees (and color-picks from) is exactly what the export produces.
Browser CSS filters are deliberately not used: they decode color differently
and have no notion of HSL bands.
"""
from __future__ import annotations
import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..database import db
from ..config import OUTPUT_DIR, DATA_DIR, TaskStatus, ItemStatus, slugify_folder
from ..ws_hub import hub
from ..queue_manager import queue
from ..services.render.color import color_filter
from ..services.render import ffcmd
from ..services.render.ffcmd import VIDEO_EXTS, IMAGE_EXTS
from ..services.ffmpeg_utils import find_ffmpeg, subprocess_no_window_kwargs
from .video_editor import _inside_outputs, _rel_url

log = logging.getLogger("redone.batch_color")
router = APIRouter(prefix="/api/batch-color", tags=["batch-color"])

PENDING_DIR = OUTPUT_DIR / "_pending"
PRESETS_KEY = "batch_color_presets"
# Audio can be stream-copied only when the source container is mp4-family;
# anything else (mkv/webm audio codecs) is transcoded to AAC to fit the
# output .mp4 container.
COPY_AUDIO_EXTS = {".mp4", ".mov", ".m4v"}


class StartRequest(BaseModel):
    files: list[str]
    color: dict = {}
    suffix: str = "_mau"


class PreviewRequest(BaseModel):
    path: str
    color: dict = {}
    ts: float = 0.0          # seek position (video only)
    max_w: int = 854


class PreviewClipRequest(BaseModel):
    path: str
    color: dict = {}
    ts: float = 0.0
    dur: float = 4.0


class PresetSave(BaseModel):
    name: str
    color: dict = {}


def _kind(p: Path) -> str:
    return "image" if p.suffix.lower() in IMAGE_EXTS else "video"


def _safe_suffix(s: str) -> str:
    out = "".join(ch for ch in (s or "") if ch.isalnum() or ch in "-_")
    return out[:24] or "_mau"


# ───────────────────────────── Batch export ─────────────────────────────

@router.post("/start")
async def start(body: StartRequest):
    files: list[Path] = []
    for f in body.files:
        p = _inside_outputs(f)
        if not p.exists():
            raise HTTPException(400, f"Không tìm thấy file: {f}")
        if p.suffix.lower() not in (VIDEO_EXTS | IMAGE_EXTS):
            raise HTTPException(400, f"Định dạng không hỗ trợ: {p.name}")
        files.append(p)
    if not files:
        raise HTTPException(400, "Chưa chọn file nào.")
    if not color_filter(body.color or {}):
        raise HTTPException(400, "Chưa chỉnh thông số màu nào.")

    from ..services import hub_client
    name = f"chinh_mau_{int(time.time())}"
    task_id = db.create_task(
        name=name,
        mode="batch_color",
        total_count=len(files),
        status=TaskStatus.PENDING.value,
        user_email=hub_client.current_user_email(),
        character_images_json=json.dumps({
            "batch_color": True,
            "color": body.color or {},
            "suffix": _safe_suffix(body.suffix),
            "files": [str(p) for p in files],
        }),
    )
    for p in files:
        db.add_task_item(task_id, p.name)
    position = await queue.enqueue("batch_color", task_id, _process_batch_color_task)
    return {"task_id": task_id, "queue_position": position, "queued": position > 0}


def _build_args(src: Path, dst: Path, colf: str) -> list[str]:
    args = ["-i", str(src), "-vf", colf]
    if _kind(src) == "image":
        args += ["-frames:v", "1", "-update", "1"]
    else:
        args += ["-c:v", "libx264", "-preset", "medium", "-crf", "18",
                 "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        if src.suffix.lower() in COPY_AUDIO_EXTS:
            args += ["-c:a", "copy"]
        else:
            args += ["-c:a", "aac", "-b:a", "192k"]
    args.append(str(dst))
    return args


async def _process_batch_color_task(task_id: int):
    task = db.get_task(task_id)
    items = db.get_task_items(task_id)
    if not task or not items:
        return
    cfg = json.loads(task.get("character_images_json") or "{}")
    color = cfg.get("color") or {}
    suffix = _safe_suffix(cfg.get("suffix") or "_mau")
    colf = color_filter(color)
    if not colf:
        db.update_task(task_id, status=TaskStatus.ERROR.value,
                       finished_at=str(time.time()))
        return

    file_by_name = {Path(f).name: Path(f) for f in cfg.get("files") or []}
    out_dir = OUTPUT_DIR / "batch_color" / f"{task_id}_{slugify_folder(task.get('name') or '', fallback='mau')}"
    out_dir.mkdir(parents=True, exist_ok=True)

    db.update_task(task_id, status=TaskStatus.RUNNING.value, started_at=str(time.time()))
    await hub.broadcast("task_started", {"task_id": task_id, "kind": "batch_color"})

    total = len(items)
    done = err = 0

    def _should_cancel() -> bool:
        return queue.is_cancelled(task_id) or queue.is_paused(task_id)

    for idx, item in enumerate(items):
        if item.get("status") == ItemStatus.COMPLETED.value:
            done += 1
            continue
        iid = item["id"]
        src = file_by_name.get(item.get("prompt") or "")
        if not src or not src.exists():
            db.update_item(iid, status=ItemStatus.ERROR.value,
                           error_message="File nguồn không còn tồn tại")
            err += 1
            continue

        ext = ".mp4" if _kind(src) == "video" else src.suffix.lower()
        dst = out_dir / f"{src.stem}{suffix}{ext}"
        if dst.exists():
            dst = out_dir / f"{src.stem}{suffix}_{iid}{ext}"

        db.update_item(iid, status=ItemStatus.GENERATING.value, error_message=None)
        info = await ffcmd.probe(str(src))

        async def _on_progress(pct: float, _msg: str, _iid=iid, _idx=idx, _name=src.name):
            await hub.broadcast("batch_color_progress", {
                "task_id": task_id, "item_id": _iid, "index": _idx, "total": total,
                "name": _name, "percent": round(pct, 1),
            })

        try:
            rc, errtxt = await ffcmd.run(
                _build_args(src, dst, colf),
                total_dur=info.get("duration") or 0.0,
                on_progress=_on_progress, should_cancel=_should_cancel,
            )
        except asyncio.CancelledError:
            db.update_item(iid, status=ItemStatus.PENDING.value, error_message=None)
            dst.unlink(missing_ok=True)
            raise
        except Exception as e:
            log.exception("batch color item failed")
            rc, errtxt = 1, str(e)

        if rc != 0 or not dst.exists():
            db.update_item(iid, status=ItemStatus.ERROR.value,
                           error_message=(errtxt or "ffmpeg lỗi")[-400:])
            err += 1
        else:
            done += 1
            db.update_item(iid, status=ItemStatus.COMPLETED.value,
                           output_path=str(dst), completed_at=str(time.time()))
            await hub.broadcast("item_completed", {
                "task_id": task_id, "item_id": iid,
                "output_path": str(dst), "url": _rel_url(dst), "kind": "batch_color",
            })
        db.update_task(task_id, done_count=done, error_count=err)

    status = TaskStatus.COMPLETED.value if done > 0 or err == 0 else TaskStatus.ERROR.value
    db.update_task(task_id, status=status, done_count=done, error_count=err,
                   finished_at=str(time.time()))
    await hub.broadcast("task_completed", {
        "task_id": task_id, "done": done, "error": err, "kind": "batch_color",
    })


# ───────────────────────────── Previews ─────────────────────────────

async def _run_ffmpeg_once(args: list[str], timeout: float = 30.0) -> tuple[int, str]:
    """One-shot ffmpeg (no progress streaming) for previews."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise HTTPException(500, "Không tìm thấy ffmpeg.")
    proc = await asyncio.create_subprocess_exec(
        ffmpeg, "-y", "-hide_banner", "-nostdin", *[str(a) for a in args],
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        **subprocess_no_window_kwargs(),
    )
    try:
        _, errb = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, "Render preview quá thời gian.")
    return proc.returncode or 0, errb.decode("utf-8", "replace")[-400:]


@router.post("/preview")
async def preview(body: PreviewRequest):
    """One frame, scaled down, through the EXACT export filter chain → JPEG
    bytes. This is what the user color-picks from, so it must be ffmpeg-decoded
    (browser-decoded pixels would land on the wrong HSL band)."""
    src = _inside_outputs(body.path)
    if not src.exists():
        raise HTTPException(404, "Không tìm thấy file.")
    colf = color_filter(body.color or {})
    max_w = max(160, min(1920, int(body.max_w or 854)))
    vf = (colf + "," if colf else "") + f"scale=min({max_w}\\,iw):-2"

    PENDING_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PENDING_DIR / f"bcprev_{uuid.uuid4().hex}.jpg"
    args = []
    if _kind(src) == "video" and body.ts > 0:
        args += ["-ss", ffcmd.fmt(body.ts)]
    args += ["-i", str(src), "-vf", vf, "-frames:v", "1", "-q:v", "3", str(tmp)]
    try:
        rc, errtxt = await _run_ffmpeg_once(args)
        if rc != 0 or not tmp.exists():
            raise HTTPException(500, f"Render preview lỗi: {errtxt}")
        data = tmp.read_bytes()
    finally:
        tmp.unlink(missing_ok=True)
    return Response(content=data, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@router.post("/preview-clip")
async def preview_clip(body: PreviewClipRequest):
    """3-5s low-res clip through the EXACT export chain — the "Xem thử"
    button. Written under outputs/_pending (auto-cleaned by lifespan)."""
    src = _inside_outputs(body.path)
    if not src.exists():
        raise HTTPException(404, "Không tìm thấy file.")
    if _kind(src) != "video":
        raise HTTPException(400, "Xem thử chỉ áp dụng cho video.")
    colf = color_filter(body.color or {})
    dur = max(1.0, min(8.0, float(body.dur or 4.0)))
    vf = (colf + "," if colf else "") + "scale=min(854\\,iw):-2"

    PENDING_DIR.mkdir(parents=True, exist_ok=True)
    out = PENDING_DIR / f"bcclip_{uuid.uuid4().hex}.mp4"
    args = ["-ss", ffcmd.fmt(max(0.0, body.ts)), "-t", ffcmd.fmt(dur),
            "-i", str(src), "-vf", vf,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(out)]
    rc, errtxt = await _run_ffmpeg_once(args, timeout=60.0)
    if rc != 0 or not out.exists():
        out.unlink(missing_ok=True)
        raise HTTPException(500, f"Render xem thử lỗi: {errtxt}")
    return {"url": _rel_url(out)}


# ───────────────────────────── Image thumbnails ─────────────────────────────
# The picker grid must NOT load full-size originals (a page of 4K PNGs chokes
# the browser's decoder). Small JPEGs are generated with Pillow and cached on
# disk, keyed by (path, mtime, width) so edits invalidate naturally.

THUMB_DIR = DATA_DIR / "thumbs"


def _make_thumb_sync(src: Path, out: Path, w: int) -> None:
    from PIL import Image
    im = Image.open(src)
    im = im.convert("RGB")
    im.thumbnail((w, w * 4))
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    im.save(out, "JPEG", quality=78)


@router.get("/thumb")
async def thumb(path: str, w: int = 240):
    src = _inside_outputs(path)
    if not src.exists():
        raise HTTPException(404, "Không tìm thấy file.")
    if src.suffix.lower() not in IMAGE_EXTS:
        raise HTTPException(400, "Chỉ tạo thumbnail cho ảnh.")
    w = max(64, min(512, int(w or 240)))
    import hashlib
    key = hashlib.sha1(f"{src}|{src.stat().st_mtime}|{w}".encode()).hexdigest()
    out = THUMB_DIR / f"{key}.jpg"
    if not out.exists():
        try:
            await asyncio.to_thread(_make_thumb_sync, src, out, w)
        except Exception as e:
            raise HTTPException(500, f"Tạo thumbnail lỗi: {e}")
    from fastapi.responses import FileResponse
    return FileResponse(out, media_type="image/jpeg",
                        headers={"Cache-Control": "max-age=86400"})


# ───────────────────────────── Presets ─────────────────────────────

@router.get("/presets")
async def list_presets():
    return {"presets": db.get_setting(PRESETS_KEY, []) or []}


@router.post("/presets")
async def save_preset(body: PresetSave):
    name = (body.name or "").strip()[:48]
    if not name:
        raise HTTPException(400, "Preset cần có tên.")
    presets = [p for p in (db.get_setting(PRESETS_KEY, []) or [])
               if p.get("name") != name]
    presets.append({"name": name, "color": body.color or {}})
    db.set_setting(PRESETS_KEY, presets[-50:])
    return {"ok": True, "count": len(presets)}


@router.delete("/presets/{name}")
async def delete_preset(name: str):
    presets = [p for p in (db.get_setting(PRESETS_KEY, []) or [])
               if p.get("name") != name]
    db.set_setting(PRESETS_KEY, presets)
    return {"ok": True}
