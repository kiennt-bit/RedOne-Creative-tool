"""Topaz Video AI Proteus (Enhance MQ) standalone service for RedOne Creative Tool.

Directly drives the bundled Topaz FFmpeg engine with the Proteus v4 AI model (prob-4)
without requiring Topaz Video AI to be installed on user machines.

Supports hardware acceleration across:
  - NVIDIA RTX / GTX (TensorRT & NVENC)
  - AMD Radeon (DirectML & AMF/MediaFoundation)
  - Intel Arc / Iris Xe (OpenVINO & QSV/MediaFoundation)
  - CPU Fallback (OpenVINO / MediaFoundation)
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
from pathlib import Path
from typing import Callable, Optional

from ..config import EXT_DIR, OUTPUT_DIR, USER_DATA_ROOT
from .ffmpeg_utils import subprocess_no_window_kwargs

log = logging.getLogger("redone.topaz_upscaler")

ProgressCb = Callable[[float, str, str], None]

# Global map to track active Topaz FFmpeg subprocesses for clean cancellation
_active_topaz_procs: dict[str, asyncio.subprocess.Process] = {}


def find_topaz_engine_dir() -> Path | None:
    """Locate the standalone Topaz engine directory."""
    exe_dir = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path.cwd()
    candidates = [
        EXT_DIR / "tvai-engine",
        USER_DATA_ROOT / "addons" / "tvai-engine",
        exe_dir / "addons" / "tvai-engine",
        Path.cwd() / "addons" / "tvai-engine",
        # Fallback to local Topaz installation if installed on the machine
        Path(r"C:\Program Files\Topaz Labs LLC\Topaz Video AI"),
        Path(r"D:\Program Files\Topaz Labs LLC\Topaz Video AI"),
        Path(r"C:\Program Files (x86)\Topaz Labs LLC\Topaz Video AI"),
    ]
    for c in candidates:
        if (c / "ffmpeg.exe").exists() and (c / "videoai.dll").exists():
            return c
    return None


def find_topaz_models_dir() -> Path | None:
    """Locate the Topaz models directory containing prob-4.json."""
    engine_dir = find_topaz_engine_dir()
    if engine_dir:
        addon_models = engine_dir / "models"
        if (addon_models / "prob-4.json").exists():
            return addon_models

    # Fallback to ProgramData if present on dev machine
    progdata_models = Path(r"C:\ProgramData\Topaz Labs LLC\Topaz Video AI\models")
    if (progdata_models / "prob-4.json").exists():
        return progdata_models

    return None


def is_topaz_available() -> bool:
    """Check if the standalone Topaz engine and Proteus model are ready."""
    return find_topaz_engine_dir() is not None and find_topaz_models_dir() is not None


def cancel_topaz_process(task_id: str) -> bool:
    """Terminate an active Topaz FFmpeg process by task ID."""
    proc = _active_topaz_procs.get(task_id)
    if proc and proc.returncode is None:
        try:
            proc.kill()
            log.info("Killed active Topaz FFmpeg process for task %s", task_id)
            return True
        except Exception as e:
            log.warning("Error killing Topaz FFmpeg process: %s", e)
    return False


async def _probe_available_encoder(ffmpeg_exe: Path, env: dict[str, str]) -> str:
    """Detect the best supported hardware encoder on the current machine."""
    # Priority: h264_nvenc (NVIDIA) > h264_mf (Windows MediaFoundation, works universally)
    try:
        proc = await asyncio.create_subprocess_exec(
            str(ffmpeg_exe), "-encoders",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
            **subprocess_no_window_kwargs(),
        )
        stdout, _ = await proc.communicate()
        text = stdout.decode("utf-8", errors="ignore")

        # Check if NVIDIA NVENC is available and working
        if "h264_nvenc" in text:
            # Quick test to confirm NVENC driver initialization succeeds
            test_proc = await asyncio.create_subprocess_exec(
                str(ffmpeg_exe), "-y",
                "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.1",
                "-c:v", "h264_nvenc",
                "-f", "null", "-",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
                **subprocess_no_window_kwargs(),
            )
            code = await test_proc.wait()
            if code == 0:
                log.info("Selected encoder: h264_nvenc (NVIDIA GPU)")
                return "h264_nvenc"
    except Exception as e:
        log.warning("Encoder probing encountered error: %s", e)

    # Universal fallback for all Windows PCs (Intel, AMD, NVIDIA, or CPU)
    log.info("Selected encoder: h264_mf (Windows Media Foundation)")
    return "h264_mf"


async def upscale_with_proteus(
    input_path: str,
    output_path: Optional[str] = None,
    resolution: str = "FHD",
    scale: int = 2,
    denoise: float = -1,
    task_id: Optional[str] = None,
    progress: Optional[ProgressCb] = None,
) -> str:
    """Upscale video using Topaz Proteus v4 (Enhance MQ) standalone engine.

    Uses Topaz Video AI official defaults:
      - Parameters: Auto (estimate=8 with prap-3 estimation model)
      - Recover detail: 20% (blend=0.2 prevents AI ringing & noise specks)
      - Reduce noise & compression: mapped from user denoise slider
      - Exact standard dimensions: 4K (3840x2160), 2K (2560x1440), FHD (1920x1080)
      - Lanczos resampler filter

    Args:
        input_path: Path to source video.
        output_path: Target video file path (auto-generated if None).
        resolution: Output resolution identifier ("FHD", "2K", "4K").
        scale: Integer upscale factor fallback.
        denoise: Denoise strength 0~1 (-1 = model auto default).
        task_id: Identifier for cancellation tracking.
        progress: Progress callback (percent, stage, message).

    Returns:
        Path to the upscaled video.
    """
    engine_dir = find_topaz_engine_dir()
    if not engine_dir:
        raise FileNotFoundError(
            "Chưa tìm thấy bộ nhân Topaz Engine trong addons/tvai-engine. "
            "Cách xử lý: Copy thư mục 'addons/tvai-engine' vào cạnh file RedOne Creative.exe "
            "hoặc chuyển sang chọn mô hình 'realesr-general-x4v3' trong ô chọn mô hình AI."
        )

    models_dir = find_topaz_models_dir()
    if not models_dir:
        raise FileNotFoundError(
            "Chưa tìm thấy file cấu hình model Proteus (prob-4.json) trong thư mục models."
        )

    ffmpeg_exe = engine_dir / "ffmpeg.exe"
    if not ffmpeg_exe.exists():
        raise FileNotFoundError(f"Không tìm thấy file thực thi ffmpeg tại {ffmpeg_exe}")

    in_p = Path(input_path).resolve()
    if not in_p.exists():
        raise FileNotFoundError(f"Video nguồn không tồn tại: {input_path}")

    # Set up TVAI environment variables
    env = os.environ.copy()
    env["TVAI_MODEL_DATA_DIR"] = str(models_dir)
    env["TVAI_MODEL_DIR"] = str(models_dir)
    # Ensure engine directory DLLs take precedence
    existing_path = env.get("PATH", "")
    env["PATH"] = f"{engine_dir};{existing_path}"

    _emit = progress or (lambda *_: None)

    # 1. Probe video info for dimensions & frame count
    from .upscaler import get_video_info
    info = await get_video_info(str(in_p))
    total_frames = info.get("nb_frames", 0)
    duration = info.get("duration", 0.0)
    fps = info.get("fps", 25.0)
    in_w = int(info.get("width") or 1280)
    in_h = int(info.get("height") or 720)
    aspect = in_w / max(1, in_h)

    # Calculate exact target dimensions maintaining source aspect ratio
    # Avoids arbitrary 4x multiplication that causes 5K blowout from 720p
    if resolution == "4K":
        if in_w >= in_h:
            target_w = 3840
            target_h = int(round(3840 / aspect))
        else:
            target_h = 3840
            target_w = int(round(3840 * aspect))
        target_bitrate = "35M"
    elif resolution == "2K":
        if in_w >= in_h:
            target_w = 2560
            target_h = int(round(2560 / aspect))
        else:
            target_h = 2560
            target_w = int(round(2560 * aspect))
        target_bitrate = "22M"
    else:  # "FHD"
        if in_w >= in_h:
            target_w = 1920
            target_h = int(round(1920 / aspect))
        else:
            target_h = 1920
            target_w = int(round(1920 * aspect))
        target_bitrate = "14M"

    # Enforce even dimensions required by h264/yuv420p
    target_w = target_w + (target_w % 2)
    target_h = target_h + (target_h % 2)

    if output_path is None:
        out_dir = OUTPUT_DIR / "video" / "upscaled"
        out_dir.mkdir(parents=True, exist_ok=True)
        stem = in_p.stem
        output_path = str(out_dir / f"{stem}_Proteus_{resolution}{in_p.suffix}")

    _emit(1.0, "starting", f"Khởi tạo Topaz Proteus ({in_w}x{in_h} → {target_w}x{target_h} {resolution})...")

    # 2. Select best hardware encoder
    encoder = await _probe_available_encoder(ffmpeg_exe, env)

    # 3. Map denoise setting to Proteus parameters
    # Topaz Video AI official defaults:
    #   - Parameters: Auto (estimate=8 with prap-3)
    #   - Recover detail: 20 (blend=0.2)
    #   - Add noise: 0
    #   - Focus fix: Off
    # If user adjusts denoise slider (0.0 ~ 1.0):
    #   denoise <= 0: noise=0, compression=0 (pure auto)
    #   denoise > 0: adds calibrated noise & compression offset
    if denoise is not None and denoise >= 0:
        noise_param = round(min(1.0, max(0.0, denoise * 0.5)), 2)
        comp_param = round(min(1.0, max(0.0, denoise * 0.3)), 2)
    else:
        noise_param = 0.0
        comp_param = 0.0

    # 4. Build FFmpeg filter expression matching Topaz Video AI GUI
    filter_expr = (
        f"tvai_up=model=prob-4:scale=0:w={target_w}:h={target_h}:"
        f"preblur=0:noise={noise_param}:details=0:halo=0:blur=0:compression={comp_param}:"
        f"estimate=8:blend=0.2:device=0:vram=1:instances=1:download=1,"
        f"scale=w={target_w}:h={target_h}:flags=lanczos:threads=0"
    )

    cmd = [
        str(ffmpeg_exe),
        "-y",
        "-hide_banner",
        "-i", str(in_p),
        "-vf", filter_expr,
        "-c:v", encoder,
        "-pix_fmt", "yuv420p",
        "-b:v", target_bitrate,
        "-c:a", "copy",
        str(output_path),
    ]

    log.info("Starting Topaz Proteus upscale (%dx%d -> %s): %s", in_w, in_h, resolution, " ".join(cmd))
    _emit(3.0, "upscaling", f"Đang nạp mô hình AI Proteus Auto ({target_w}x{target_h})...")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        **subprocess_no_window_kwargs(),
    )

    if task_id:
        _active_topaz_procs[task_id] = proc

    # Regex patterns for parsing ffmpeg progress
    re_frame = re.compile(r"frame=\s*(\d+)")
    re_fps = re.compile(r"fps=\s*([\d.]+)")
    re_speed = re.compile(r"speed=\s*([\d.]+)x")

    buffer = b""
    try:
        while True:
            chunk = await proc.stderr.read(256)
            if not chunk:
                break
            buffer += chunk

            # Process completed progress segments (FFmpeg outputs \r or \n)
            while b"\r" in buffer or b"\n" in buffer:
                line_bytes, _, remaining = buffer.partition(b"\r")
                if not _ and b"\n" in buffer:
                    line_bytes, _, remaining = buffer.partition(b"\n")
                buffer = remaining

                line = line_bytes.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue

                frame_m = re_frame.search(line)
                if frame_m:
                    current_frame = int(frame_m.group(1))
                    fps_val = re_fps.search(line)
                    speed_val = re_speed.search(line)

                    fps_str = fps_val.group(1) if fps_val else "--"
                    speed_str = speed_val.group(1) if speed_val else "--"

                    if total_frames > 0:
                        pct = min(99.0, (current_frame / total_frames) * 100.0)
                        msg = (
                            f"Đang upscale Proteus: Frame {current_frame}/{total_frames} "
                            f"({pct:.1f}%) • {fps_str} fps (Tốc độ {speed_str}x)"
                        )
                    else:
                        pct = 50.0
                        msg = f"Đang upscale Proteus: Frame {current_frame} • {fps_str} fps"

                    _emit(pct, "upscaling", msg)

        return_code = await proc.wait()
        if return_code != 0:
            raise RuntimeError(f"Topaz FFmpeg lỗi (Mã thoát: {return_code})")

        _emit(100.0, "completed", "Hoàn tất nâng cấp video bằng Topaz Proteus!")
        return str(output_path)

    finally:
        if task_id:
            _active_topaz_procs.pop(task_id, None)
