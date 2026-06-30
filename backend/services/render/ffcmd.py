"""FFmpeg execution + probing helpers for the render pipeline.

Thin layer over ffmpeg_utils (one source of truth for the binary lookup + the
Windows no-console-flash flags). Adds: a runner that streams `-progress` for a
0..100 percent + cooperative cancel, an ffprobe wrapper, and small formatters.
"""
from __future__ import annotations
import asyncio
import json
import logging
from pathlib import Path
from typing import Awaitable, Callable, Optional

from ..ffmpeg_utils import find_ffmpeg, find_ffprobe, subprocess_no_window_kwargs

log = logging.getLogger("redone.render")

ProgressCb = Callable[[float, str], Awaitable[None]]
CancelCb = Callable[[], bool]

VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}


def fmt(x) -> str:
    """ffmpeg-safe number (no scientific notation, trimmed)."""
    return f"{float(x):.4f}".rstrip("0").rstrip(".") or "0"


def kind_of(path: str, declared: str = "") -> str:
    if declared in ("video", "image", "audio", "text"):
        return declared
    ext = Path(path).suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in AUDIO_EXTS:
        return "audio"
    return "video"


def _parse_progress_line(line: str) -> Optional[float]:
    line = line.strip()
    if line.startswith("out_time_ms=") or line.startswith("out_time_us="):
        try:
            return int(line.split("=", 1)[1]) / 1_000_000.0
        except ValueError:
            return None
    if line.startswith("out_time="):
        try:
            h, m, s = line.split("=", 1)[1].split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
        except ValueError:
            return None
    return None


async def probe(path: str) -> dict:
    """ffprobe → {duration, width, height, has_audio}. Best-effort."""
    info = {"duration": 0.0, "width": 0, "height": 0, "has_audio": False}
    ffprobe = find_ffprobe()
    if not ffprobe:
        return info
    try:
        proc = await asyncio.create_subprocess_exec(
            ffprobe, "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", path,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            **subprocess_no_window_kwargs(),
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        data = json.loads(out.decode("utf-8", "replace") or "{}")
    except Exception as e:
        log.warning(f"ffprobe failed for {path}: {e}")
        return info
    for st in data.get("streams", []):
        ct = st.get("codec_type")
        if ct == "audio":
            info["has_audio"] = True
        elif ct == "video":
            info["width"] = int(st.get("width") or 0)
            info["height"] = int(st.get("height") or 0)
    try:
        info["duration"] = float(data.get("format", {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        pass
    return info


async def run(args: list, total_dur: float = 0.0,
              on_progress: Optional[ProgressCb] = None,
              should_cancel: Optional[CancelCb] = None,
              pct_lo: float = 0.0, pct_hi: float = 100.0,
              timeout: int = 7200) -> tuple[int, str]:
    """Run one ffmpeg command, streaming progress into [pct_lo, pct_hi].
    Kills the process on cancel (raises asyncio.CancelledError)."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("Không tìm thấy ffmpeg. Cài ffmpeg hoặc `pip install imageio-ffmpeg`.")
    cmd = [ffmpeg, "-y", "-hide_banner", "-nostdin", "-progress", "pipe:1", "-nostats", *args]
    log.info("ffmpeg %s", " ".join(str(a) for a in cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        **subprocess_no_window_kwargs(),
    )
    err_chunks: list[bytes] = []

    async def _drain():
        try:
            while True:
                ch = await proc.stderr.read(4096)
                if not ch:
                    break
                err_chunks.append(ch)
                if len(err_chunks) > 80:
                    del err_chunks[:40]
        except Exception:
            pass

    drain = asyncio.create_task(_drain())
    span = max(0.0, pct_hi - pct_lo)
    last = -1.0
    try:
        while True:
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
            except asyncio.TimeoutError:
                proc.kill()
                raise RuntimeError("ffmpeg quá thời gian")
            if not line:
                break
            if should_cancel and should_cancel():
                proc.kill()
                raise asyncio.CancelledError()
            secs = _parse_progress_line(line.decode("utf-8", "replace"))
            if secs is not None and total_dur > 0 and on_progress:
                pct = pct_lo + max(0.0, min(1.0, secs / total_dur)) * span
                if pct - last >= 1.0:
                    last = pct
                    try:
                        await on_progress(min(pct, pct_hi), "Đang dựng video…")
                    except Exception:
                        pass
        await proc.wait()
    except asyncio.CancelledError:
        try:
            proc.kill(); await proc.wait()
        except Exception:
            pass
        raise
    finally:
        drain.cancel()
        try:
            await drain
        except Exception:
            pass
    return proc.returncode or 0, b"".join(err_chunks).decode("utf-8", "replace")
