"""Video watermark removal orchestrator.

Pipeline (mirrors the standalone Red One Creative Tools Electron app):
  1. ffmpeg → extract every frame to a temp dir as %05d.png
  2. ffmpeg → alpha-extract the user-supplied mask PNG and resize to frame size
  3. python subprocess → backend/services/lama_inpaint.py <method> in mask out
     (parses JSON progress lines from stdout, broadcasts WS events)
  4. ffmpeg → re-encode frames to MP4 (libx264 crf=18) + copy original audio

Method selection:
  • "lama"    — best quality. Needs torch + simple_lama_inpainting + big-lama.pt
  • "opencv"  — fast fallback. Needs cv2 only.
  • "auto"    — try lama, fall back to opencv if any dep is missing.

External Python is REQUIRED. The bundled EXE cannot self-execute lama_inpaint.py
because PyInstaller --windowed disables stdlib subprocess execution of the
frozen binary as Python. Same model the standalone tool uses.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Awaitable, Callable, Optional

from .ffmpeg_utils import find_ffmpeg
from ..config import IS_FROZEN

log = logging.getLogger("navtools.watermark_video")

# Type alias: an async progress callback. (status_label, percent_0_100)
ProgressCB = Callable[[str, float], Awaitable[None]]


# ── Resource path resolution ──────────────────────────────────────────

def _bundled_root() -> Path:
    """Where bundled data lives.

    Frozen (PyInstaller --onedir): `sys._MEIPASS` is the temp dir into which
        the bundle was extracted; resources/ + services/ are under there.
    Dev: the repo root (3 levels up from this file).
    """
    if IS_FROZEN and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    # backend/services/watermark_video.py → repo root is .parent.parent.parent
    return Path(__file__).resolve().parent.parent.parent


def get_lama_script() -> Path:
    """Path to the inpaint subprocess script (bundled as data in EXE)."""
    return _bundled_root() / "backend" / "services" / "lama_inpaint.py"


def get_default_veo_mask() -> Path:
    """Bundled Veo3 watermark mask (1920×1080, "Veo" text bottom-right)."""
    return _bundled_root() / "backend" / "resources" / "veo3watermark.png"


# ── External Python detection ─────────────────────────────────────────

_PYTHON_CACHE: Optional[str] = None


def detect_python() -> Optional[str]:
    """Find an external Python interpreter for spawning the inpaint script.

    Frozen EXE can't run itself as Python; we need a separately-installed
    python3 to actually execute lama_inpaint.py. Search order:
      1. PYTHON env var (explicit override)
      2. `python` / `python3` on PATH
      3. Windows registry (`py -3`)
      4. Common install paths (PythonXY in AppData / Program Files)

    Cached after first hit. Returns None if no Python found.
    """
    global _PYTHON_CACHE
    if _PYTHON_CACHE:
        return _PYTHON_CACHE

    # When running in dev (not frozen), sys.executable IS a real Python and
    # has access to the same site-packages we developed against. Use it.
    if not IS_FROZEN:
        _PYTHON_CACHE = sys.executable
        return _PYTHON_CACHE

    env_py = os.environ.get("PYTHON")
    if env_py and Path(env_py).exists():
        _PYTHON_CACHE = env_py
        return env_py

    for name in ("python3", "python", "py"):
        found = shutil.which(name)
        if found:
            _PYTHON_CACHE = found
            return found

    # Windows-only fallback paths
    if sys.platform == "win32":
        candidates = [
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python",
            Path("C:/Program Files/Python311"),
            Path("C:/Program Files/Python312"),
            Path("C:/Program Files/Python313"),
        ]
        for c in candidates:
            if c.exists():
                for sub in c.rglob("python.exe"):
                    _PYTHON_CACHE = str(sub)
                    return str(sub)
    return None


async def _check_module(python: str, module: str) -> bool:
    """Return True if external Python can import the module."""
    proc = await asyncio.create_subprocess_exec(
        python, "-c", f"import {module}",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    return (await proc.wait()) == 0


def _builtin_cv2_available() -> bool:
    """Is cv2 importable from the same process that runs this code?

    In a frozen EXE the PyInstaller bundle ships opencv-python under
    `_internal/`, so cv2 imports cleanly without any external Python or
    user setup. In dev mode this only succeeds if the developer ran
    `pip install opencv-python`. Either way, when True we can run the
    OpenCV inpainting method IN-PROCESS — skip the subprocess hop.
    """
    try:
        import cv2  # noqa: F401
        return True
    except Exception:
        return False


def _builtin_torch_available() -> bool:
    """Whether torch is importable in-process. Almost always False because
    we deliberately exclude torch from the EXE bundle (too big). Returns
    True only if the running environment happens to have torch installed
    (dev mode, or user manually pip-installed into the bundle directory)."""
    try:
        import torch  # noqa: F401
        return True
    except Exception:
        return False


async def lama_status() -> dict:
    """Report whether everything LaMa needs is installed + cached.

    Returned by the /api/media/lama-status endpoint so the UI can light up
    the right "ready" chips and surface concrete fix instructions.

    Detection priority for each component:
      - cv2:         in-process first (bundled into EXE), fall back to
                     external Python's `import cv2`
      - torch:       same dual check — frozen bundles usually exclude it
      - simple_lama: same
      - model:       filesystem check in well-known cache locations
    """
    py = detect_python()
    have_builtin_cv2 = _builtin_cv2_available()
    info: dict = {
        "python": py,
        "python_ok": bool(py),
        "ffmpeg": find_ffmpeg(),
        "ffmpeg_ok": bool(find_ffmpeg()),
        "cv2": have_builtin_cv2,
        "torch": _builtin_torch_available(),
        "simple_lama": False,
        "model_path": None,
        "model_ok": False,
        "cuda": False,
        "lama_ok": False,
        "opencv_ok": have_builtin_cv2,    # built-in OpenCV is enough
        "opencv_inprocess": have_builtin_cv2,
    }

    # Even if we have a builtin, also probe the external Python so the UI
    # can show the user where their `pip install` would land. Only run
    # subprocess probes if we don't already know the answer.
    if py:
        if not info["cv2"]:
            info["cv2"] = await _check_module(py, "cv2")
            info["opencv_ok"] = info["cv2"]
        if not info["torch"]:
            info["torch"] = await _check_module(py, "torch")
        info["simple_lama"] = await _check_module(py, "simple_lama_inpainting")

    if info["torch"] and py:
        # Check CUDA availability via the external Python (the one that
        # will actually run the LaMa subprocess). Skip if no external
        # Python — even if our bundle has torch we won't use it for LaMa
        # (LaMa always runs via subprocess to isolate GPU memory).
        proc = await asyncio.create_subprocess_exec(
            py, "-c", "import torch; print(int(torch.cuda.is_available()))",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await proc.communicate()
        info["cuda"] = bool(out and out.strip() == b"1")

    # Look for big-lama.pt in standard locations
    home = Path.home()
    candidates = [
        home / ".cache" / "torch" / "hub" / "checkpoints" / "big-lama.pt",
        home / ".cache" / "redone" / "models" / "big-lama.pt",
        home / "AppData" / "Roaming" / "toolshelper" / "models"
            / "hub" / "checkpoints" / "big-lama.pt",
    ]
    for c in candidates:
        if c.exists() and c.stat().st_size > 100 * 1024 * 1024:
            info["model_path"] = str(c)
            info["model_ok"] = True
            break

    info["lama_ok"] = bool(
        info["python_ok"] and info["ffmpeg_ok"]
        and info["torch"] and info["simple_lama"] and info["model_ok"]
    )
    return info


async def resolve_method(requested: str) -> str:
    """Translate `auto` to a concrete method based on availability.

    Priority:
      • lama if all deps installed (best quality, slowest)
      • opencv otherwise (works out-of-box in bundled EXE because cv2
        is collected into _internal/)
    """
    if requested in ("opencv", "lama", "sttn", "propainter"):
        return requested
    # auto
    st = await lama_status()
    if st["lama_ok"]:
        return "lama"
    if st["opencv_ok"]:
        return "opencv"
    # Nothing works — raise so the caller can show a clean error
    raise RuntimeError(
        "Không có engine inpaint khả dụng. cv2 chưa import được — "
        "bản EXE đáng lẽ phải bundle sẵn opencv-python. Bạn đang chạy dev "
        "mode? Chạy: pip install opencv-python"
    )


# ── ffprobe helper for fps + dimensions ───────────────────────────────

async def _probe_video(path: Path) -> dict:
    """Get fps + width + height of a video. Tries ffprobe, falls back to ffmpeg."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        proc = await asyncio.create_subprocess_exec(
            ffprobe, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-of", "json", str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await proc.communicate()
        try:
            data = json.loads(out.decode("utf-8"))
            s = data.get("streams", [{}])[0]
            num, den = (s.get("r_frame_rate") or "24/1").split("/")
            fps = float(num) / float(den) if float(den) else 24.0
            return {"fps": round(fps, 2), "width": int(s.get("width") or 1920),
                    "height": int(s.get("height") or 1080)}
        except Exception as e:
            log.warning(f"ffprobe parse failed: {e}")

    # Fallback: use ffmpeg -i and parse stderr (not ideal but works)
    ffmpeg = find_ffmpeg()
    proc = await asyncio.create_subprocess_exec(
        ffmpeg, "-i", str(path),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    import re
    text = (err or b"").decode("utf-8", errors="replace")
    dim_m = re.search(r"(\d{3,5})x(\d{3,5})", text)
    fps_m = re.search(r"(\d+(?:\.\d+)?)\s*fps", text)
    return {
        "fps": float(fps_m.group(1)) if fps_m else 24.0,
        "width": int(dim_m.group(1)) if dim_m else 1920,
        "height": int(dim_m.group(2)) if dim_m else 1080,
    }


# ── Main entry point ──────────────────────────────────────────────────

async def remove_watermark_from_video(
    input_video: Path,
    output_video: Path,
    mask_path: Optional[Path] = None,
    method: str = "auto",
    device: str = "auto",       # auto / cpu / cuda / split
    gpu_ratio: int = 70,
    on_progress: Optional[ProgressCB] = None,
) -> Path:
    """Run the full watermark-removal pipeline on a single video.

    Args:
        input_video:   Source MP4
        output_video:  Where to write the cleaned MP4 (parent dir auto-created)
        mask_path:     PNG mask (white = inpaint region). Falls back to the
                       bundled Veo3 mask if None.
        method:        "auto" | "opencv" | "lama" | "sttn" | "propainter"
        device:        "auto" | "cpu" | "cuda" | "split"
        gpu_ratio:     0-100, percent of frames on GPU when device="split"
        on_progress:   async callback(status_label: str, percent: float)

    Returns the output_video path on success. Raises RuntimeError otherwise.
    All temp files are cleaned up in finally — even on cancellation.
    """
    async def _emit(msg: str, pct: float) -> None:
        if on_progress:
            try:
                await on_progress(msg, pct)
            except Exception as e:
                log.warning(f"progress callback raised: {e}")

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("FFmpeg không tìm thấy. Cài: pip install imageio-ffmpeg.")

    method = await resolve_method(method)
    await _emit(f"Engine: {method.upper()}", 1)

    # OpenCV runs IN-PROCESS (cv2 bundled into the EXE → no Python subprocess
    # needed). LaMa still needs the subprocess path because torch is too big
    # to bundle. The wizard installs torch + simple_lama_inpainting + model
    # into an external Python that we then spawn.
    use_subprocess = (method != "opencv") or not _builtin_cv2_available()

    python = None
    if use_subprocess:
        python = detect_python()
        if not python:
            raise RuntimeError(
                "Cần cài Python 3 + torch + simple-lama-inpainting để dùng "
                "LaMa AI. Hoặc chọn method=opencv (chạy luôn trong EXE)."
            )

    lama_script = get_lama_script()
    if use_subprocess and not lama_script.exists():
        raise RuntimeError(f"Script inpaint không có ở: {lama_script}")

    mask_src = mask_path or get_default_veo_mask()
    if not Path(mask_src).exists():
        raise RuntimeError(f"Mask file không tồn tại: {mask_src}")

    info = await _probe_video(input_video)
    fps = info["fps"]
    width = info["width"]
    height = info["height"]
    log.info(f"Video: {width}x{height} @ {fps}fps")

    work_dir = Path(tempfile.mkdtemp(prefix=f"navtools_wm_{os.getpid()}_"))
    frames_in = work_dir / "in"
    frames_out = work_dir / "out"
    mask_resized = work_dir / "mask.png"
    frames_in.mkdir(parents=True)
    frames_out.mkdir(parents=True)

    try:
        # 1. Extract frames
        await _emit("Tách frames…", 2)
        proc = await asyncio.create_subprocess_exec(
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(input_video),
            "-vf", f"scale={width}:{height}",
            str(frames_in / "%05d.png"),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(
                "Tách frames thất bại: "
                + (err.decode("utf-8", errors="replace") if err else "")
            )

        # 2. Prepare mask (alphaextract + resize to video dims)
        await _emit("Chuẩn bị mask…", 5)
        proc = await asyncio.create_subprocess_exec(
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(mask_src),
            "-vf", f"format=rgba,alphaextract,scale={width}:{height}",
            str(mask_resized),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            # Mask might be grayscale PNG without alpha — fall back to direct resize
            log.info("alphaextract failed, retrying as grayscale")
            proc = await asyncio.create_subprocess_exec(
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(mask_src),
                "-vf", f"format=gray,scale={width}:{height}",
                str(mask_resized),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError("Mask preparation failed")

        # 3. Run inpaint — either in-process (OpenCV, fastest startup) or
        #    via subprocess (LaMa, needs external Python with torch).
        await _emit("Đang xóa watermark…", 8)

        if not use_subprocess:
            # IN-PROCESS path: import lama_inpaint and call run_opencv()
            # directly. Saves the subprocess spawn overhead and lets us
            # forward progress without parsing JSON from stdout. The
            # callback runs synchronously (cv2 work is mostly C, GIL gets
            # released) but the event loop is blocked while we crunch,
            # which is fine for short videos and acceptable for long ones.
            await _emit("In-process OpenCV (bundled)…", 9)
            loop = asyncio.get_running_loop()

            def _sync_cb(payload: dict) -> None:
                # lama_inpaint emits the same payload shape as in CLI mode.
                # Translate to our async _emit on the event loop thread.
                if "progress" in payload:
                    p = float(payload["progress"])
                    pct = 8 + (p / 100.0) * 77
                    label = (
                        f"OpenCV {payload.get('frame','?')}/{payload.get('total','?')}"
                        if "frame" in payload else f"OpenCV {p:.0f}%"
                    )
                    asyncio.run_coroutine_threadsafe(_emit(label, pct), loop)
                elif payload.get("status") == "done":
                    asyncio.run_coroutine_threadsafe(_emit("Hoàn tất inpaint", 85), loop)
                elif "status" in payload:
                    asyncio.run_coroutine_threadsafe(_emit(payload["status"], 50), loop)
                # `error` payloads will raise out of run_opencv as RuntimeError
                # so we don't need to handle them here.

            try:
                # Run in a thread because cv2.inpaint is CPU-bound and would
                # otherwise block the event loop for the entire pipeline.
                from . import lama_inpaint as _li
                await asyncio.to_thread(
                    _li.run_opencv, frames_in, mask_resized, frames_out, _sync_cb,
                )
            except Exception as e:
                raise RuntimeError(f"OpenCV inpaint thất bại: {e}")
        else:
            # SUBPROCESS path: external Python runs lama_inpaint.py and
            # streams JSON progress lines.
            args = [
                python, str(lama_script), method,
                str(frames_in), str(mask_resized), str(frames_out),
                "--device", device, "--gpu-ratio", str(gpu_ratio),
            ]
            log.info(f"spawn: {' '.join(args)}")
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            async def _drain_stdout():
                """Parse JSON progress lines. Each line = one script event."""
                assert proc.stdout
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        break
                    try:
                        msg = json.loads(line.decode("utf-8").strip())
                    except Exception:
                        continue
                    if "error" in msg:
                        # Don't raise here — let wait() pick up non-zero exit
                        log.warning(f"inpaint error: {msg['error']}")
                        continue
                    if msg.get("status") == "done":
                        await _emit("Hoàn tất inpaint", 85)
                    elif "progress" in msg:
                        # Script emits 0-100; map into our 8-85 working range
                        p = float(msg["progress"])
                        pct = 8 + (p / 100.0) * 77
                        label = (
                            f"AI inpainting {msg.get('frame','?')}/{msg.get('total','?')}"
                            if "frame" in msg else f"AI inpainting {p:.0f}%"
                        )
                        await _emit(label, pct)
                    elif "status" in msg:
                        await _emit(msg["status"], 50)

            async def _drain_stderr():
                assert proc.stderr
                buf = b""
                while True:
                    line = await proc.stderr.readline()
                    if not line:
                        break
                    buf += line
                    log.debug(f"inpaint stderr: {line.decode('utf-8', errors='replace').rstrip()}")
                return buf

            stdout_task = asyncio.create_task(_drain_stdout())
            stderr_task = asyncio.create_task(_drain_stderr())
            rc = await proc.wait()
            await stdout_task
            stderr_buf = await stderr_task
            if rc != 0:
                tail = stderr_buf.decode("utf-8", errors="replace")[-500:]
                raise RuntimeError(f"Inpaint exited with code {rc}: {tail}")

        # Sanity: at least some frames must have been written
        n_out = sum(1 for _ in frames_out.glob("*.png"))
        if n_out == 0:
            raise RuntimeError("Inpaint không sinh ra frame nào — chắc lỗi script.")

        # 4. Re-encode video
        await _emit("Re-encode video…", 88)
        output_video.parent.mkdir(parents=True, exist_ok=True)
        proc = await asyncio.create_subprocess_exec(
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-framerate", str(fps),
            "-i", str(frames_out / "%05d.png"),
            "-i", str(input_video),
            "-map", "0:v", "-map", "1:a?",         # keep original audio if present
            "-c:v", "libx264", "-crf", "18", "-preset", "medium",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            str(output_video),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(
                "Re-encode thất bại: "
                + (err.decode("utf-8", errors="replace") if err else "")
            )

        await _emit("Hoàn tất", 100)
        return output_video

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
