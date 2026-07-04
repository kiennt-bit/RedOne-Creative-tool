"""Extract frames from video files using ffmpeg/ffprobe.

Used for video chaining — extract last frame from one video to use as
start image for the next video generation. Inspired by G-Labs node editor's
"Frame Extraction" node.

Requires ffmpeg + ffprobe on PATH (bundled in the EXE via bin/ffmpeg/).
"""
import asyncio
import logging
import shutil
from pathlib import Path

log = logging.getLogger("redone.frame_extractor")


def _find_ffmpeg() -> str | None:
    """Locate ffmpeg binary — check bundled bin/ first, then PATH."""
    from ..config import BASE_DIR
    bundled = Path(BASE_DIR) / "bin" / "ffmpeg" / "ffmpeg.exe"
    if bundled.exists():
        return str(bundled)
    return shutil.which("ffmpeg")


def _find_ffprobe() -> str | None:
    """Locate ffprobe binary — check bundled bin/ first, then PATH."""
    from ..config import BASE_DIR
    bundled = Path(BASE_DIR) / "bin" / "ffmpeg" / "ffprobe.exe"
    if bundled.exists():
        return str(bundled)
    return shutil.which("ffprobe")


async def extract_last_frame(
    video_path: str,
    output_path: str | None = None,
) -> str | None:
    """Extract the last frame of a video as a PNG image.

    Args:
        video_path: Path to input video file
        output_path: Optional output path. Defaults to <video>_lastframe.png

    Returns:
        Path to extracted frame image, or None on failure.
    """
    vp = Path(video_path)
    if not vp.exists():
        log.error(f"Video not found: {video_path}")
        return None

    if output_path is None:
        output_path = str(vp.with_suffix("")) + "_lastframe.png"

    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        log.error("ffmpeg not found — cannot extract frame")
        return None

    # Step 1: Get video duration with ffprobe to seek near the end
    seek_time: float | None = None
    ffprobe = _find_ffprobe()
    if ffprobe:
        try:
            proc = await asyncio.create_subprocess_exec(
                ffprobe, "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(vp),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            duration = float(stdout.decode().strip())
            # Seek to 0.1s before end
            seek_time = max(0.0, duration - 0.1)
        except (ValueError, AttributeError, OSError) as e:
            log.debug(f"ffprobe duration query failed: {e}")

    # Step 2: Extract frame using ffmpeg
    cmd = [ffmpeg, "-y"]
    if seek_time is not None:
        cmd.extend(["-ss", f"{seek_time:.3f}"])
    cmd.extend([
        "-i", str(vp),
        "-frames:v", "1",
        "-update", "1",
        output_path,
    ])

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
    except OSError as e:
        log.error(f"ffmpeg execution failed: {e}")
        return None

    if proc.returncode == 0 and Path(output_path).exists():
        size = Path(output_path).stat().st_size
        log.info(f"Extracted last frame: {output_path} ({size} bytes)")
        return output_path

    log.error(f"Frame extraction failed (rc={proc.returncode}): "
              f"{stderr.decode(errors='replace')[:300]}")
    return None


async def extract_frame_at(
    video_path: str,
    time_seconds: float,
    output_path: str | None = None,
) -> str | None:
    """Extract a frame at a specific timestamp.

    Args:
        video_path: Path to input video file
        time_seconds: Timestamp in seconds
        output_path: Optional output path. Defaults to <video>_frame_<time>.png

    Returns:
        Path to extracted frame image, or None on failure.
    """
    vp = Path(video_path)
    if not vp.exists():
        log.error(f"Video not found: {video_path}")
        return None

    if output_path is None:
        ts_str = f"{time_seconds:.1f}".replace(".", "s")
        output_path = str(vp.with_suffix("")) + f"_frame_{ts_str}.png"

    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        log.error("ffmpeg not found — cannot extract frame")
        return None

    cmd = [
        ffmpeg, "-y",
        "-ss", f"{time_seconds:.3f}",
        "-i", str(vp),
        "-frames:v", "1",
        "-update", "1",
        output_path,
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
    except OSError as e:
        log.error(f"ffmpeg execution failed: {e}")
        return None

    if proc.returncode == 0 and Path(output_path).exists():
        size = Path(output_path).stat().st_size
        log.info(f"Extracted frame at {time_seconds}s: {output_path} ({size} bytes)")
        return output_path

    log.error(f"Frame extraction failed (rc={proc.returncode}): "
              f"{stderr.decode(errors='replace')[:300]}")
    return None
