"""FFmpeg wrappers for video concat, audio merge, subtitle burn.

Also exports `subprocess_no_window_kwargs()` — the canonical helper for
suppressing the CMD flash that windowed PyInstaller EXEs would otherwise
spawn for every subprocess call. Other services (`watermark_video`,
`lama_installer`) re-export this so we only have one source of truth.
"""
from __future__ import annotations
import asyncio
import shutil
import subprocess
import sys
import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger("navtools.ffmpeg")


def subprocess_no_window_kwargs() -> dict:
    """Kwargs for `asyncio.create_subprocess_exec` / `subprocess.Popen`
    that fully suppress the console window on Windows.

    Belt-and-suspenders: combines the modern `creationflags=CREATE_NO_WINDOW`
    AND the legacy `startupinfo.wShowWindow=SW_HIDE` path because we've seen
    Windows 10 / 11 edge-cases where one alone leaks a brief CMD flash
    (depends on host Python build + which event loop is in use).

    `stdin=DEVNULL` is added as a small extra — some child processes that
    fail early write a stack trace to stderr (already DEVNULL'd by caller)
    and try to read stdin, allocating a console as a side-effect.
    """
    if sys.platform != "win32":
        return {}
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = subprocess.SW_HIDE
    return {
        "creationflags": subprocess.CREATE_NO_WINDOW,
        "startupinfo": si,
        "stdin": asyncio.subprocess.DEVNULL,
    }


def find_ffmpeg() -> Optional[str]:
    """Locate ffmpeg binary."""
    p = shutil.which("ffmpeg")
    if p:
        return p
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def find_ffprobe() -> Optional[str]:
    return shutil.which("ffprobe")


async def run_ffmpeg(args: list[str], timeout: int = 600) -> tuple[int, str]:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found. Install ffmpeg or `pip install imageio-ffmpeg`.")
    cmd = [ffmpeg, "-y", "-hide_banner", *args]
    log.info(f"ffmpeg {' '.join(cmd)}")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        **subprocess_no_window_kwargs(),
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("ffmpeg timed out")
    text = out.decode("utf-8", errors="replace") if out else ""
    return proc.returncode or 0, text


async def concat_videos(inputs: list[str], output: str, re_encode: bool = True) -> bool:
    """Concat list of MP4 files into one output."""
    inputs = [str(Path(p)) for p in inputs if Path(p).exists()]
    if not inputs:
        return False
    if re_encode:
        # Use filter_complex concat for clean joins
        n = len(inputs)
        cmd: list[str] = []
        for p in inputs:
            cmd += ["-i", p]
        filter_parts = "".join(f"[{i}:v:0][{i}:a:0?]" for i in range(n))
        filter_complex = f"{filter_parts}concat=n={n}:v=1:a=1[outv][outa]"
        cmd += [
            "-filter_complex", filter_complex,
            "-map", "[outv]", "-map", "[outa]",
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "192k",
            output,
        ]
        code, log_out = await run_ffmpeg(cmd, timeout=900)
        return code == 0
    else:
        # Demuxer concat (fast, may stutter)
        listfile = Path(output).with_suffix(".concat.txt")
        listfile.write_text(
            "\n".join(f"file '{Path(p).as_posix()}'" for p in inputs),
            encoding="utf-8",
        )
        code, _ = await run_ffmpeg(
            ["-f", "concat", "-safe", "0", "-i", str(listfile), "-c", "copy", output],
        )
        try:
            listfile.unlink()
        except Exception:
            pass
        return code == 0


async def merge_audio(video: str, audio: str, output: str, replace: bool = True) -> bool:
    """Merge audio into video (replace=True replaces existing audio, otherwise mix)."""
    if replace:
        args = ["-i", video, "-i", audio,
                "-c:v", "copy",
                "-map", "0:v:0", "-map", "1:a:0",
                "-c:a", "aac", "-b:a", "192k",
                "-shortest", output]
    else:
        args = ["-i", video, "-i", audio,
                "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest[a]",
                "-map", "0:v:0", "-map", "[a]",
                "-c:v", "copy", "-c:a", "aac",
                output]
    code, _ = await run_ffmpeg(args)
    return code == 0


async def burn_subtitles(video: str, srt: str, output: str) -> bool:
    """Burn SRT subtitles into video."""
    srt_escaped = srt.replace("\\", "/").replace(":", r"\:")
    code, _ = await run_ffmpeg([
        "-i", video,
        "-vf", f"subtitles='{srt_escaped}'",
        "-c:a", "copy",
        output,
    ])
    return code == 0


async def extract_thumbnail(video: str, output: str, at: float = 0.5) -> bool:
    code, _ = await run_ffmpeg([
        "-ss", str(at), "-i", video,
        "-frames:v", "1", "-q:v", "2", output,
    ])
    return code == 0
