"""Media utilities: video watermark removal, subtitle, batch resize."""
from __future__ import annotations
import asyncio
import io
import logging
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..config import OUTPUT_DIR
from ..services.image_utils import resize_image, PRESETS
from ..services.ffmpeg_utils import find_ffmpeg, subprocess_no_window_kwargs, run_ffmpeg

log = logging.getLogger("redone.media")
router = APIRouter(prefix="/api/media", tags=["media"])


def _save_temp(file: UploadFile, prefix: str) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix=f"redone_{prefix}_"))
    out = tmp / (file.filename or f"{prefix}.bin")
    with out.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    return out


# ─────────────────────── Video Watermark Remove (LaMa / OpenCV) ───────────────────────

@router.get("/lama-status")
async def lama_status(force: bool = False):
    """Report Python / ffmpeg / cv2 / torch / model availability.

    UI uses this on the watermark page to show whether LaMa is ready or only
    OpenCV fallback works, and to point the user to the right install step.

    Results are cached for 60s in the service to avoid spawning subprocess
    probes (which flash CMD windows on Windows) every time the user
    navigates back to the page. Pass `?force=true` from the "Kiểm tra lại"
    button to bypass the cache after an install.
    """
    from ..services.watermark_video import lama_status as _ls
    return await _ls(force=force)


@router.post("/video-watermark-remove")
async def video_watermark_remove(
    file: UploadFile = File(...),
    mask: Optional[UploadFile] = File(None),
    method: str = Form("auto"),       # auto | opencv | lama | sttn | propainter
    device: str = Form("auto"),       # auto | cpu | cuda | split
    gpu_ratio: int = Form(70),
    use_default_mask: bool = Form(True),  # if True and no mask uploaded, use veo3 mask
):
    """Remove watermark/logo from a single video.

    Pipeline:
      1. Save uploaded video to temp
      2. Resolve mask: uploaded custom > bundled Veo3 (when use_default_mask) > error
      3. Call watermark_video.remove_watermark_from_video() with WS progress broadcasts
      4. Return permanent output path under outputs/video/watermark_removed/<date>/

    Progress is also streamed via WebSocket — frontend can use either the
    response (blocking) or subscribe to `watermark_*` events for realtime UI.
    """
    from ..ws_hub import hub
    from ..services.watermark_video import (
        remove_watermark_from_video, get_default_veo_mask,
    )
    from datetime import datetime as _dt

    src_video = _save_temp(file, "wmv")
    mask_path: Optional[Path] = None
    mask_tmp_dir: Optional[Path] = None

    if mask is not None:
        mask_saved = _save_temp(mask, "wmv_mask")
        mask_path = mask_saved
        mask_tmp_dir = mask_saved.parent
    elif use_default_mask:
        mask_path = get_default_veo_mask()
        if not mask_path.exists():
            raise HTTPException(500, f"Built-in Veo mask không tồn tại: {mask_path}")
    else:
        raise HTTPException(400, "Phải upload mask hoặc bật use_default_mask")

    today = _dt.now().strftime("%Y-%m-%d")
    out_dir = OUTPUT_DIR / "video" / "watermark_removed" / today
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(file.filename or "video").stem or "video"
    out_path = out_dir / f"{stem} [RedOne].mp4"
    # Avoid collisions with existing file from a previous run
    counter = 1
    while out_path.exists():
        out_path = out_dir / f"{stem} [RedOne]_{counter}.mp4"
        counter += 1

    job_id = uuid.uuid4().hex[:8]

    async def _emit(label: str, pct: float) -> None:
        await hub.broadcast("watermark_progress", {
            "job_id": job_id, "status": label, "progress": round(pct, 1),
            "source": str(src_video.name),
        })

    await hub.broadcast("watermark_started", {
        "job_id": job_id, "source": file.filename,
        "method": method, "device": device,
    })
    try:
        result = await remove_watermark_from_video(
            input_video=src_video,
            output_video=out_path,
            mask_path=mask_path,
            method=method,
            device=device,
            gpu_ratio=gpu_ratio,
            on_progress=_emit,
        )
        rel = result.relative_to(OUTPUT_DIR).as_posix()
        payload = {
            "job_id": job_id,
            "ok": True,
            "path": str(result),
            "url": f"/files/{rel}",
        }
        await hub.broadcast("watermark_completed", payload)
        return payload
    except Exception as e:
        log.exception("video-watermark-remove failed")
        await hub.broadcast("watermark_error", {"job_id": job_id, "error": str(e)})
        raise HTTPException(500, str(e))
    finally:
        shutil.rmtree(src_video.parent, ignore_errors=True)
        if mask_tmp_dir:
            shutil.rmtree(mask_tmp_dir, ignore_errors=True)


class VideoWatermarkBatchRequest(BaseModel):
    """Body for /video-watermark-remove-batch.

    Items reference EXISTING video files on disk (not uploads) — typical use
    case is "select N already-generated videos in the gallery and clean them
    all". Custom mask is not supported here; use the single-file endpoint for
    that case.
    """
    paths: list[str]
    method: str = "auto"
    device: str = "auto"
    gpu_ratio: int = 70


@router.post("/video-watermark-remove-batch")
async def video_watermark_remove_batch(body: VideoWatermarkBatchRequest):
    """Sequentially clean watermark from N gallery videos using the built-in
    Veo3 mask. Broadcasts WS progress per video. Returns list of outputs."""
    from ..ws_hub import hub
    from ..services.watermark_video import (
        remove_watermark_from_video, get_default_veo_mask,
    )
    from datetime import datetime as _dt

    if not body.paths:
        raise HTTPException(400, "paths rỗng")

    # Resolve paths — must be inside OUTPUT_DIR for safety, must exist
    resolved: list[Path] = []
    skipped: list[dict] = []
    for p in body.paths:
        try:
            pp = Path(p).resolve()
            pp.relative_to(OUTPUT_DIR.resolve())   # raises if outside
            if not pp.exists():
                skipped.append({"path": p, "error": "Không tồn tại"})
                continue
            resolved.append(pp)
        except Exception:
            skipped.append({"path": p, "error": "Path không hợp lệ"})

    if not resolved:
        raise HTTPException(400, "Không có file nào hợp lệ để xử lý")

    mask_path = get_default_veo_mask()
    today = _dt.now().strftime("%Y-%m-%d")
    out_dir = OUTPUT_DIR / "video" / "watermark_removed" / today
    out_dir.mkdir(parents=True, exist_ok=True)

    job_id = uuid.uuid4().hex[:8]
    total = len(resolved)
    completed: list[dict] = []
    errors: list[dict] = []

    await hub.broadcast("watermark_batch_started", {
        "job_id": job_id, "total": total, "method": body.method,
    })

    for idx, src in enumerate(resolved, 1):
        stem = src.stem
        out_path = out_dir / f"{stem} [RedOne].mp4"
        counter = 1
        while out_path.exists():
            out_path = out_dir / f"{stem} [RedOne]_{counter}.mp4"
            counter += 1

        async def _emit(label: str, pct: float, _src=src.name, _idx=idx) -> None:
            # Map per-video 0..100 into the batch's slice
            global_pct = ((_idx - 1) + pct / 100.0) / total * 100
            await hub.broadcast("watermark_progress", {
                "job_id": job_id,
                "source": _src,
                "status": f"[{_idx}/{total}] {label}",
                "progress": round(global_pct, 1),
            })

        try:
            result = await remove_watermark_from_video(
                input_video=src,
                output_video=out_path,
                mask_path=mask_path,
                method=body.method,
                device=body.device,
                gpu_ratio=body.gpu_ratio,
                on_progress=_emit,
            )
            rel = result.relative_to(OUTPUT_DIR).as_posix()
            entry = {"src": str(src), "path": str(result), "url": f"/files/{rel}"}
            completed.append(entry)
            await hub.broadcast("watermark_item_completed", {
                "job_id": job_id, "index": idx, "total": total, **entry,
            })
        except Exception as e:
            log.warning(f"watermark batch item {src} failed: {e}")
            errors.append({"src": str(src), "error": str(e)})
            await hub.broadcast("watermark_item_error", {
                "job_id": job_id, "index": idx, "total": total,
                "src": str(src), "error": str(e),
            })

    await hub.broadcast("watermark_batch_done", {
        "job_id": job_id, "total": total,
        "completed": len(completed), "errors": len(errors),
    })

    return {
        "ok": True,
        "job_id": job_id,
        "completed": completed,
        "errors": errors + skipped,
    }


# ─────────────────────── Subtitle Generate ───────────────────────

def _whisper_load_audio(path: str, sr: int = 16000):
    """Decode an audio/video file to a 16kHz mono float32 numpy array using the
    bundled ffmpeg.

    Replicates `whisper.audio.load_audio` but resolves the binary via
    `find_ffmpeg()` instead of spawning a bare `ffmpeg` from PATH. Whisper
    hardcodes the command name `ffmpeg`, which raises WinError 2 on machines
    that only have imageio-ffmpeg's versioned binary (ffmpeg-win-*.exe) and no
    system ffmpeg. We then hand the resulting array to `model.transcribe()`,
    so Whisper never shells out to ffmpeg itself.
    """
    import numpy as np
    import subprocess
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise HTTPException(
            500,
            "Không tìm thấy ffmpeg để xử lý audio. Cài 'imageio-ffmpeg' "
            "(pip install imageio-ffmpeg) hoặc cài ffmpeg vào PATH rồi thử lại.",
        )
    cmd = [
        ffmpeg, "-nostdin", "-threads", "0", "-i", path,
        "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", str(sr), "-",
    ]
    try:
        out = subprocess.run(
            cmd, capture_output=True, check=True,
            **subprocess_no_window_kwargs(),
        ).stdout
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode("utf-8", "replace")[-500:]
        raise HTTPException(500, f"ffmpeg giải mã audio thất bại: {err}")
    return np.frombuffer(out, np.int16).flatten().astype(np.float32) / 32768.0


# In-memory subtitle jobs: job_id -> {status, percent, stage, url, path, ...}.
# Process-lifetime only — a server restart drops running jobs (the frontend
# surfaces a friendly "mất tiến trình" and lets the user re-run).
_subtitle_jobs: dict = {}


@router.post("/subtitle")
async def subtitle_endpoint(
    file: UploadFile = File(...),
    model_size: str = Form("base"),
    language: str = Form("auto"),
):
    """Start a Whisper subtitle job in the BACKGROUND and return its job_id.

    Progress is polled via GET /subtitle-status/{job_id}. Running detached
    (instead of blocking the request) is what lets the UI survive tab
    navigation and show a live %.
    """
    src = _save_temp(file, "subtitle")
    job_id = uuid.uuid4().hex
    _subtitle_jobs[job_id] = {
        "status": "running", "percent": 0, "stage": "Đang chuẩn bị…",
        "filename": file.filename,
    }
    # Trim old finished jobs so the dict can't grow unbounded.
    if len(_subtitle_jobs) > 50:
        for k in list(_subtitle_jobs)[:-50]:
            _subtitle_jobs.pop(k, None)
    asyncio.create_task(_run_subtitle_job(job_id, src, model_size, language))
    return {"job_id": job_id}


@router.get("/subtitle-status/{job_id}")
async def subtitle_status(job_id: str):
    j = _subtitle_jobs.get(job_id)
    if not j:
        raise HTTPException(404, "Không tìm thấy job phụ đề (server có thể đã khởi động lại)")
    return {"job_id": job_id, **j}


async def _run_subtitle_job(job_id: str, src: Path, model_size: str, language: str) -> None:
    job = _subtitle_jobs.get(job_id)
    if job is None:
        return
    out_dir = OUTPUT_DIR / "subtitle"
    out_dir.mkdir(parents=True, exist_ok=True)
    srt_path = out_dir / f"{uuid.uuid4().hex}.srt"
    try:
        try:
            import whisper
        except ImportError:
            job.update(status="error", error="whisper chưa cài. Chạy: pip install openai-whisper")
            return

        def _transcribe():
            # Decode with the bundled ffmpeg and feed Whisper a numpy array, so
            # Whisper's own load_audio() (bare `ffmpeg` on PATH) is never hit.
            audio = _whisper_load_audio(str(src))
            job.update(percent=5, stage="Đang tải model Whisper…")
            model = whisper.load_model(model_size)
            job.update(percent=10, stage="Đang nhận diện giọng nói…")
            kwargs = {}
            if language and language != "auto":
                kwargs["language"] = language
            # Report % by hooking Whisper's internal tqdm frame counter
            # (verbose=False keeps the bar enabled but silent). If the hook ever
            # breaks across versions, fall back to a plain transcribe.
            try:
                import whisper.transcribe as _wt
                _orig_tqdm = _wt.tqdm.tqdm

                def _make_bar(*a, **k):
                    bar = _orig_tqdm(*a, **k)
                    _orig_update = bar.update

                    def _update(n=1):
                        _orig_update(n)
                        if bar.total:
                            job["percent"] = min(98, 10 + int(bar.n / bar.total * 88))
                    bar.update = _update
                    return bar

                _wt.tqdm.tqdm = _make_bar
                try:
                    return model.transcribe(audio, verbose=False, **kwargs)
                finally:
                    _wt.tqdm.tqdm = _orig_tqdm
            except Exception:
                return model.transcribe(audio, **kwargs)

        result = await asyncio.to_thread(_transcribe)

        lines = []
        for i, seg in enumerate(result.get("segments", []), 1):
            lines.append(
                f"{i}\n{_fmt_srt(seg['start'])} --> {_fmt_srt(seg['end'])}\n{seg['text'].strip()}\n"
            )
        srt_path.write_text("\n".join(lines), encoding="utf-8")
        job.update(
            status="done", percent=100, stage="Hoàn tất",
            path=str(srt_path),
            url=f"/files/{srt_path.relative_to(OUTPUT_DIR).as_posix()}",
            language=result.get("language"),
            segments=len(result.get("segments", [])),
        )
    except Exception as e:
        job.update(status="error", error=f"Tạo phụ đề thất bại: {e}")
    finally:
        shutil.rmtree(src.parent, ignore_errors=True)


def _fmt_srt(seconds: float) -> str:
    ms = int((seconds % 1) * 1000)
    s = int(seconds) % 60
    m = (int(seconds) // 60) % 60
    h = int(seconds) // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# ─────────────────────── Batch Resize (ảnh + video) ───────────────────────

class BatchResizeRequest(BaseModel):
    width: int
    height: int
    mode: str = "fit"  # stretch | fit | cover
    bg_color: str = "#000000"
    fmt: str = "png"


# Extensions treated as video → resized with ffmpeg (everything else = image).
_VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
               ".wmv", ".flv", ".mpg", ".mpeg", ".ts", ".3gp"}


def _is_video_name(name: str | None) -> bool:
    return Path(name or "").suffix.lower() in _VIDEO_EXTS


async def _resize_video(src: Path, dst: Path, width: int, height: int,
                        mode: str, bg_color: str) -> None:
    """Resize a video to width×height using the same fit/cover/stretch
    semantics as the image path. Re-encodes with libx264 + AAC audio."""
    # ffmpeg color syntax wants 0xRRGGBB; the UI sends #RRGGBB.
    color = (bg_color or "#000000").replace("#", "0x")
    if mode == "stretch":
        vf = f"scale={width}:{height}"
    elif mode == "cover":
        vf = (f"scale={width}:{height}:force_original_aspect_ratio=increase,"
              f"crop={width}:{height}")
    else:  # fit — keep aspect ratio, letterbox padding with bg_color
        vf = (f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
              f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:{color}")
    code, out = await run_ffmpeg([
        "-i", str(src),
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(dst),
    ], timeout=1800)
    if code != 0:
        raise RuntimeError(f"ffmpeg resize failed: {out[-400:]}")


@router.get("/resize-presets")
async def resize_presets():
    return {"presets": PRESETS}


@router.post("/batch-resize")
async def batch_resize(
    files: list[UploadFile] = File(...),
    width: int = Form(...),
    height: int = Form(...),
    mode: str = Form("fit"),
    bg_color: str = Form("#000000"),
    fmt: str = Form("png"),
):
    """Resize a batch of images and/or videos to width×height.

    Images use Pillow (`resize_image`) and honour the `fmt` field; videos are
    re-encoded to MP4 with ffmpeg (the `fmt` field is ignored for video).
    """
    batch_id = uuid.uuid4().hex
    img_dir = OUTPUT_DIR / "image" / "resized" / batch_id
    vid_dir = OUTPUT_DIR / "video" / "resized" / batch_id
    results = []
    for file in files:
        src = _save_temp(file, "resize")
        try:
            stem = Path(file.filename or "media").stem
            if _is_video_name(file.filename):
                vid_dir.mkdir(parents=True, exist_ok=True)
                dst = vid_dir / f"{stem}.mp4"
                await _resize_video(src, dst, width, height, mode, bg_color)
                kind = "video"
            else:
                img_dir.mkdir(parents=True, exist_ok=True)
                dst = img_dir / f"{stem}.{fmt}"
                resize_image(src, dst, width=width, height=height, mode=mode, bg_color=bg_color, fmt=fmt)
                kind = "image"
            results.append({
                "name": file.filename,
                "type": kind,
                "path": str(dst),
                "url": f"/files/{dst.relative_to(OUTPUT_DIR).as_posix()}",
            })
        except Exception as e:
            results.append({"name": file.filename, "error": str(e)})
        finally:
            shutil.rmtree(src.parent, ignore_errors=True)
    return {"results": results}
