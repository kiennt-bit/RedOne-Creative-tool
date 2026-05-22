"""LaMa AI upgrade installer.

The bundled EXE ships only OpenCV (the lightweight inpainting backend) to
keep the download size reasonable. When the user wants LaMa-quality
results — better blending on complex scenes — they trigger this installer
from the UI's "Nâng cấp lên LaMa AI" wizard.

Pipeline:
  1. Detect external Python (must already be installed; we don't try to
     auto-install Python because of UAC / antivirus friction).
  2. `pip install opencv-python simple-lama-inpainting torch` into THAT
     Python. Large download (~600MB-1.5GB depending on torch variant).
  3. Stream-download `big-lama.pt` (~204MB) to the standard cache location
     so the next subprocess call picks it up automatically.

Single-flight lock prevents two concurrent installs from racing on the
same pip cache. State snapshot is exposed so the UI can reattach to an
in-progress install after a page reload.
"""
from __future__ import annotations

import asyncio
import logging
import re
import sys
from pathlib import Path
from typing import Awaitable, Callable, Optional

import httpx

from ..config import DATA_DIR

log = logging.getLogger("navtools.lama_installer")

LAMA_MODEL_URL = (
    "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/"
    "v0.1.0/big-lama.pt"
)

# Single-flight lock — only one installer runs at a time across all clients
_INSTALL_LOCK = asyncio.Lock()
_INSTALL_STATE: dict = {
    "stage": "idle",        # idle | detecting | installing_pip | downloading_model | done | error
    "label": "",
    "percent": 0.0,
    "pip_log_tail": [],     # last N lines of pip output for the log panel
    "error": None,
    "python": None,
    "model_path": None,
}

ProgressCB = Callable[[dict], Awaitable[None]]


def get_install_state() -> dict:
    return dict(_INSTALL_STATE)


def _reset_state():
    _INSTALL_STATE.update({
        "stage": "idle", "label": "", "percent": 0.0,
        "pip_log_tail": [], "error": None,
        "python": None, "model_path": None,
    })


async def _emit(cb: Optional[ProgressCB]) -> None:
    if cb:
        try:
            await cb(get_install_state())
        except Exception as e:
            log.warning(f"progress callback raised: {e}")


def _resolve_model_target() -> Path:
    """Where to put big-lama.pt so `simple_lama_inpainting` finds it.

    The library checks `TORCH_HOME/hub/checkpoints/big-lama.pt`. By default
    TORCH_HOME = ~/.cache/torch on macOS/Linux, or %USERPROFILE%\\.cache\\torch
    on Windows. We respect TORCH_HOME if the user set it (Electron tool's
    convention), otherwise use the default.
    """
    import os
    torch_home = os.environ.get("TORCH_HOME", "")
    if torch_home:
        return Path(torch_home) / "hub" / "checkpoints" / "big-lama.pt"
    return Path.home() / ".cache" / "torch" / "hub" / "checkpoints" / "big-lama.pt"


def _pip_progress_pct(line: str) -> Optional[float]:
    """Very rough progress parse from pip's stdout.

    pip prints lines like:
      Downloading torch-2.1.0-cp311-cp311-win_amd64.whl (147.9 MB)
      |████████████████████████████████| 147.9/147.9 MB 5.2 MB/s

    The progress bar moves a lot but isn't easy to parse reliably across
    pip versions. We just look for the "X.X/Y.Y MB" tail to compute a
    rough percent for the current wheel. Returns None when not parseable
    so the UI can leave the bar in indeterminate mode.
    """
    m = re.search(r"(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)\s*MB", line)
    if m:
        cur = float(m.group(1))
        total = float(m.group(2))
        if total > 0:
            return min(99.0, cur / total * 100)
    return None


async def install_lama(on_progress: Optional[ProgressCB] = None) -> bool:
    """End-to-end installer. Holds _INSTALL_LOCK so only one runs at a time.

    Raises RuntimeError on failure. Updates _INSTALL_STATE throughout —
    callers can poll it or subscribe via WS for live progress.
    """
    if _INSTALL_LOCK.locked():
        raise RuntimeError("LaMa install đang chạy rồi — đợi xong rồi thử lại.")

    async with _INSTALL_LOCK:
        try:
            _reset_state()

            # ── 1. Detect Python ──
            from .watermark_video import detect_python
            _INSTALL_STATE["stage"] = "detecting"
            _INSTALL_STATE["label"] = "Tìm Python 3 trên máy…"
            await _emit(on_progress)

            python = detect_python()
            if not python:
                raise RuntimeError(
                    "Không tìm thấy Python 3 trên máy. Cài Python từ "
                    "https://python.org/downloads/ (tick \"Add Python to PATH\") "
                    "rồi thử lại."
                )
            _INSTALL_STATE["python"] = python
            log.info(f"Using Python: {python}")

            # ── 2. pip install torch + simple-lama-inpainting + opencv ──
            # We also install opencv-python into THIS Python because LaMa
            # subprocess runs lama_inpaint.py which `import cv2` for mask
            # pre-processing. The bundled cv2 in our EXE is only accessible
            # from in-process calls.
            _INSTALL_STATE["stage"] = "installing_pip"
            _INSTALL_STATE["label"] = "Đang pip install torch + simple-lama-inpainting (~700MB)…"
            _INSTALL_STATE["percent"] = 0
            await _emit(on_progress)

            args = [
                python, "-m", "pip", "install", "--upgrade",
                "opencv-python", "simple-lama-inpainting", "torch",
            ]
            log.info(f"spawn: {' '.join(args)}")
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            assert proc.stdout

            current_pct = 0.0
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip()
                # Keep last 20 lines for the UI log panel
                tail = _INSTALL_STATE["pip_log_tail"]
                tail.append(line)
                if len(tail) > 20:
                    tail.pop(0)
                # Heuristic progress: when pip prints "Successfully installed"
                # we know we're at the end. Mid-install we estimate from
                # per-wheel progress bars.
                p = _pip_progress_pct(line)
                if p is not None:
                    current_pct = p
                if "Successfully installed" in line:
                    current_pct = 100.0
                _INSTALL_STATE["percent"] = round(current_pct, 1)
                _INSTALL_STATE["label"] = line[:140]
                await _emit(on_progress)

            rc = await proc.wait()
            if rc != 0:
                # Pip's last few lines usually have the error reason
                tail = "\n".join(_INSTALL_STATE["pip_log_tail"][-10:])
                raise RuntimeError(
                    f"pip install thất bại (exit {rc}). Log cuối:\n{tail}"
                )

            # ── 3. Download big-lama.pt to torch cache ──
            target = _resolve_model_target()
            if target.exists() and target.stat().st_size > 100 * 1024 * 1024:
                # Already there — skip download
                log.info(f"big-lama.pt already at {target}, skipping download")
                _INSTALL_STATE["model_path"] = str(target)
            else:
                _INSTALL_STATE["stage"] = "downloading_model"
                _INSTALL_STATE["label"] = "Đang tải big-lama.pt (~204MB)…"
                _INSTALL_STATE["percent"] = 0
                await _emit(on_progress)

                target.parent.mkdir(parents=True, exist_ok=True)
                tmp = target.with_suffix(target.suffix + ".part")
                downloaded = 0
                async with httpx.AsyncClient(
                    timeout=None, follow_redirects=True,
                ) as client:
                    async with client.stream("GET", LAMA_MODEL_URL) as r:
                        r.raise_for_status()
                        total = int(r.headers.get("Content-Length") or 0)
                        emit_every = 1 << 18   # 256KB
                        bytes_since = 0
                        with tmp.open("wb") as f:
                            async for chunk in r.aiter_bytes(1 << 15):
                                if not chunk:
                                    continue
                                f.write(chunk)
                                downloaded += len(chunk)
                                bytes_since += len(chunk)
                                if total > 0:
                                    _INSTALL_STATE["percent"] = round(
                                        downloaded / total * 100, 1,
                                    )
                                _INSTALL_STATE["label"] = (
                                    f"Tải model: {downloaded / 1e6:.1f}"
                                    f" / {total / 1e6:.1f} MB"
                                )
                                if bytes_since >= emit_every:
                                    await _emit(on_progress)
                                    bytes_since = 0
                # Rename atomic-ish — keeps partial files from looking valid
                if target.exists():
                    target.unlink()
                tmp.rename(target)
                _INSTALL_STATE["model_path"] = str(target)
                log.info(f"Downloaded {target} ({downloaded} bytes)")

            # ── 4. Done ──
            _INSTALL_STATE["stage"] = "done"
            _INSTALL_STATE["label"] = "LaMa AI đã sẵn sàng! Restart tool để dùng."
            _INSTALL_STATE["percent"] = 100
            await _emit(on_progress)
            return True

        except Exception as e:
            log.exception("LaMa install failed")
            _INSTALL_STATE["stage"] = "error"
            _INSTALL_STATE["label"] = f"Lỗi: {e}"
            _INSTALL_STATE["error"] = str(e)
            await _emit(on_progress)
            raise
