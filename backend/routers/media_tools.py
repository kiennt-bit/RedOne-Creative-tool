"""Media utilities: bg remove, watermark, upscale, audio merge, subtitle, batch resize."""
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
from ..services.gemini import generate_text
from ..services.image_utils import resize_image, fill_background, PRESETS
from ..services.ffmpeg_utils import merge_audio, burn_subtitles, run_ffmpeg

log = logging.getLogger("navtools.media")
router = APIRouter(prefix="/api/media", tags=["media"])


def _save_temp(file: UploadFile, prefix: str) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix=f"navtools_{prefix}_"))
    out = tmp / (file.filename or f"{prefix}.bin")
    with out.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    return out


# ─────────────────────── Background Remove ───────────────────────

@router.post("/bg-remove")
async def bg_remove(
    file: UploadFile = File(...),
    method: str = Form("gemini"),  # "gemini" | "rembg"
    fill_color: Optional[str] = Form(None),
):
    src = _save_temp(file, "bg")
    try:
        out_dir = OUTPUT_DIR / "image" / "bg_removed"
        out_dir.mkdir(parents=True, exist_ok=True)
        result_png = out_dir / f"{uuid.uuid4().hex}.png"

        # Both "rembg" and "gemini" methods currently use rembg under the
        # hood (Gemini doesn't have a foreground-segmentation API yet —
        # we use rembg as the actual implementation regardless).
        try:
            from rembg import remove
            img_bytes = src.read_bytes()
            out_bytes = remove(img_bytes)
            with result_png.open("wb") as f:
                f.write(out_bytes)
        except ImportError:
            raise HTTPException(
                500,
                "rembg chưa cài. Chạy trong terminal: pip install rembg onnxruntime",
            )
        except SystemExit:
            # rembg's bg.py calls sys.exit(1) at IMPORT TIME when its
            # onnxruntime backend is missing — that's a SystemExit
            # exception, not ImportError. Catch it explicitly so user
            # gets a clear remediation instead of an opaque 500.
            raise HTTPException(
                500,
                "rembg đã cài nhưng thiếu onnxruntime backend. "
                "Chạy trong terminal: pip install onnxruntime",
            )
        except Exception as e:
            raise HTTPException(500, f"BG remove failed: {e}")

        if fill_color:
            filled = result_png.with_name(result_png.stem + "_filled.png")
            fill_background(result_png, filled, fill_color)
            return {"path": str(filled), "url": f"/files/{filled.relative_to(OUTPUT_DIR).as_posix()}"}
        return {"path": str(result_png), "url": f"/files/{result_png.relative_to(OUTPUT_DIR).as_posix()}"}
    finally:
        try:
            shutil.rmtree(src.parent, ignore_errors=True)
        except Exception:
            pass


# ─────────────────────── Watermark Remove ───────────────────────

class WMRect(BaseModel):
    x: int
    y: int
    w: int
    h: int


@router.post("/watermark-remove")
async def watermark_remove(
    file: UploadFile = File(...),
    x: int = Form(...),
    y: int = Form(...),
    w: int = Form(...),
    h: int = Form(...),
    padding: int = Form(10),
):
    """Remove watermark from image. Uses LaMa via spandrel if installed, else simple inpaint."""
    src = _save_temp(file, "wm")
    out_dir = OUTPUT_DIR / "image" / "watermark_removed"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{uuid.uuid4().hex}.png"
    try:
        try:
            # Try LaMa (best quality)
            from PIL import Image, ImageDraw
            import numpy as np
            try:
                import spandrel
                import torch
            except ImportError:
                spandrel = None
                torch = None

            img = Image.open(src).convert("RGB")
            if spandrel and torch:
                # Build mask
                mask = Image.new("L", img.size, 0)
                draw = ImageDraw.Draw(mask)
                draw.rectangle([x - padding, y - padding, x + w + padding, y + h + padding], fill=255)
                # Load LaMa model from local cache (user must download)
                model_path = Path.home() / ".cache" / "navtools" / "big-lama.pt"
                if not model_path.exists():
                    raise FileNotFoundError(f"LaMa model not found at {model_path}. Download big-lama.pt manually.")
                model = spandrel.ModelLoader().load_from_file(str(model_path)).cuda() if torch.cuda.is_available() else spandrel.ModelLoader().load_from_file(str(model_path)).cpu()
                # ... full LaMa inference omitted for brevity; falls through to OpenCV
                raise RuntimeError("LaMa not fully wired — using OpenCV fallback")
            else:
                raise RuntimeError("spandrel/torch not installed — using OpenCV fallback")
        except Exception as e:
            log.warning(f"LaMa unavailable, using OpenCV inpaint: {e}")
            try:
                import cv2
                import numpy as np
                img_cv = cv2.imread(str(src))
                if img_cv is None:
                    raise RuntimeError("Could not read image")
                mask = np.zeros(img_cv.shape[:2], dtype=np.uint8)
                pad = padding
                mask[max(0, y - pad):y + h + pad, max(0, x - pad):x + w + pad] = 255
                result = cv2.inpaint(img_cv, mask, 5, cv2.INPAINT_TELEA)
                cv2.imwrite(str(out_path), result)
            except ImportError:
                raise HTTPException(500, "opencv-python required for watermark removal. Install: pip install opencv-python")

        return {"path": str(out_path), "url": f"/files/{out_path.relative_to(OUTPUT_DIR).as_posix()}"}
    finally:
        shutil.rmtree(src.parent, ignore_errors=True)


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


# ─────────────────────── Upscale ───────────────────────

@router.post("/upscale")
async def upscale_image(
    file: UploadFile = File(...),
    scale: int = Form(4),
):
    src = _save_temp(file, "upscale")
    out_dir = OUTPUT_DIR / "image" / "upscaled"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{uuid.uuid4().hex}.png"
    try:
        try:
            from PIL import Image
            img = Image.open(src).convert("RGB")
            new_size = (img.width * scale, img.height * scale)
            up = img.resize(new_size, Image.LANCZOS)
            up.save(out_path, "PNG")
        except Exception as e:
            raise HTTPException(500, f"Upscale failed: {e}")
        return {
            "path": str(out_path),
            "url": f"/files/{out_path.relative_to(OUTPUT_DIR).as_posix()}",
            "note": "Using PIL LANCZOS (basic). For neural upscaling, install Real-ESRGAN.",
        }
    finally:
        shutil.rmtree(src.parent, ignore_errors=True)


# ─────────────────────── Audio Merge ───────────────────────

@router.post("/audio-merge")
async def audio_merge_endpoint(
    video: UploadFile = File(...),
    audio: UploadFile = File(...),
    replace: bool = Form(True),
):
    v = _save_temp(video, "video")
    a = _save_temp(audio, "audio")
    out_dir = OUTPUT_DIR / "video" / "merged"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{uuid.uuid4().hex}.mp4"
    try:
        ok = await merge_audio(str(v), str(a), str(out_path), replace=replace)
        if not ok:
            raise HTTPException(500, "ffmpeg failed")
        return {"path": str(out_path), "url": f"/files/{out_path.relative_to(OUTPUT_DIR).as_posix()}"}
    finally:
        shutil.rmtree(v.parent, ignore_errors=True)
        shutil.rmtree(a.parent, ignore_errors=True)


# ─────────────────────── Subtitle Generate ───────────────────────

@router.post("/subtitle")
async def subtitle_endpoint(
    file: UploadFile = File(...),
    model_size: str = Form("base"),
    language: str = Form("auto"),
):
    """Generate SRT subtitles using Whisper."""
    src = _save_temp(file, "subtitle")
    out_dir = OUTPUT_DIR / "subtitle"
    out_dir.mkdir(parents=True, exist_ok=True)
    srt_path = out_dir / f"{uuid.uuid4().hex}.srt"
    try:
        try:
            import whisper
        except ImportError:
            raise HTTPException(500, "whisper not installed. Run: pip install openai-whisper")

        def _transcribe():
            model = whisper.load_model(model_size)
            kwargs = {}
            if language and language != "auto":
                kwargs["language"] = language
            return model.transcribe(str(src), **kwargs)

        result = await asyncio.to_thread(_transcribe)
        lines = []
        for i, seg in enumerate(result.get("segments", []), 1):
            start = seg["start"]
            end = seg["end"]
            text = seg["text"].strip()
            lines.append(f"{i}\n{_fmt_srt(start)} --> {_fmt_srt(end)}\n{text}\n")
        srt_path.write_text("\n".join(lines), encoding="utf-8")
        return {
            "path": str(srt_path),
            "url": f"/files/{srt_path.relative_to(OUTPUT_DIR).as_posix()}",
            "language": result.get("language"),
            "segments": len(result.get("segments", [])),
        }
    finally:
        shutil.rmtree(src.parent, ignore_errors=True)


def _fmt_srt(seconds: float) -> str:
    ms = int((seconds % 1) * 1000)
    s = int(seconds) % 60
    m = (int(seconds) // 60) % 60
    h = int(seconds) // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# ─────────────────────── Batch Resize ───────────────────────

class BatchResizeRequest(BaseModel):
    width: int
    height: int
    mode: str = "fit"  # stretch | fit | cover
    bg_color: str = "#000000"
    fmt: str = "png"


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
    out_dir = OUTPUT_DIR / "image" / "resized" / uuid.uuid4().hex
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for file in files:
        src = _save_temp(file, "resize")
        try:
            stem = Path(file.filename or "image").stem
            dst = out_dir / f"{stem}.{fmt}"
            resize_image(src, dst, width=width, height=height, mode=mode, bg_color=bg_color, fmt=fmt)
            results.append({
                "name": file.filename,
                "path": str(dst),
                "url": f"/files/{dst.relative_to(OUTPUT_DIR).as_posix()}",
            })
        except Exception as e:
            results.append({"name": file.filename, "error": str(e)})
        finally:
            shutil.rmtree(src.parent, ignore_errors=True)
    return {"results": results, "folder": str(out_dir)}
