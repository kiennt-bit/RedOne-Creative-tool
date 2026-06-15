"""First-run setup wizard.

The bundled EXE doesn't ship every native dep we need at runtime (Python
3 + torch + LaMa model = ~3GB, too big to put inside the EXE). Instead,
on first launch of every version, this orchestrator detects what's
missing and runs an unattended install pipeline:

  1. MSVC Redistributable — DETECT ONLY. We surface a one-click install
     link to the user if missing. We don't auto-install it because the
     installer needs UAC + can flake under aggressive antivirus.
  2. Python 3.12 — auto-download from python.org and silent-install per
     user (no UAC needed). After install, the absolute path to the new
     python.exe is persisted so subsequent subprocess calls find it
     even before the parent's PATH refreshes.
  3. pip install opencv-python simple-lama-inpainting torch into the
     detected/installed Python. Auto-picks the CUDA wheel if nvidia-smi
     is present, else the CPU build.
  4. Stream-download big-lama.pt (~204MB) to torch's standard cache
     location so simple_lama_inpainting finds it on first use.

State lives in `data/setup-state.json`:
  {
    "completed_for_version": "1.0.6",
    "completed_at": "2026-05-22T11:23:45",
    "python_path": "C:/Users/.../Python312/python.exe",
    "steps": {"msvc": "ok", "python": "ok", "pip": "ok", "model": "ok"},
    "skipped": false
  }

If `completed_for_version` >= APP_VERSION on launch, the wizard is
skipped entirely. Bumping APP_VERSION re-triggers the wizard (only if
the new version actually needs more deps — the pipeline's detection
phase short-circuits when everything is already there).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable, Optional

import httpx

from ..config import APP_VERSION, DATA_DIR, IS_FROZEN
from .ffmpeg_utils import subprocess_no_window_kwargs

log = logging.getLogger("redone.setup_wizard")

# ── Constants ──────────────────────────────────────────────────────

PYTHON_VERSION = "3.12.7"
PYTHON_INSTALLER_URL = (
    f"https://www.python.org/ftp/python/{PYTHON_VERSION}/"
    f"python-{PYTHON_VERSION}-amd64.exe"
)
MSVC_REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
LAMA_MODEL_URL = (
    "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/"
    "v0.1.0/big-lama.pt"
)
TORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu121"

# Where the wizard saves its progress/result so re-launches resume cleanly.
SETUP_STATE_FILE = DATA_DIR / "setup-state.json"

# Single-flight: only one run_setup() can execute at a time
_SETUP_LOCK = asyncio.Lock()

# Module-scoped live state — frontend reads this via /api/system/setup-state
_SETUP_STATE: dict = {
    "stage": "idle",          # idle | running | done | error
    "current_step": None,      # msvc | python | pip | model
    "step_label": "",
    "percent": 0.0,            # overall 0-100 OR per-step depending on stage
    "log_tail": [],            # last N lines for the UI log panel
    "error": None,
    "python_path": None,
    "needs_msvc": False,
    "needs_python": False,
    "needs_pip": False,
    "needs_model": False,
    "msvc_install_url": MSVC_REDIST_URL,
}

ProgressCB = Callable[[dict], Awaitable[None]]


def get_setup_state() -> dict:
    return dict(_SETUP_STATE)


def _set_state(**kwargs) -> None:
    _SETUP_STATE.update(kwargs)


async def _emit(cb: Optional[ProgressCB]) -> None:
    if cb:
        try:
            await cb(get_setup_state())
        except Exception as e:
            log.warning(f"progress callback raised: {e}")


def _append_log(line: str, max_tail: int = 50) -> None:
    tail = _SETUP_STATE["log_tail"]
    tail.append(line)
    if len(tail) > max_tail:
        tail.pop(0)


# ── Persistence ────────────────────────────────────────────────────

def load_persisted_state() -> dict:
    if not SETUP_STATE_FILE.exists():
        return {}
    try:
        return json.loads(SETUP_STATE_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning(f"Could not read {SETUP_STATE_FILE}: {e}")
        return {}


def save_persisted_state(data: dict) -> None:
    SETUP_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETUP_STATE_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def get_persisted_python_path() -> Optional[str]:
    """Returns the absolute python.exe path saved after a successful setup,
    if it still exists on disk. Used by watermark_video.detect_python()
    to skip PATH searching after the wizard installed a fresh Python."""
    state = load_persisted_state()
    p = state.get("python_path")
    if p and Path(p).exists():
        return p
    return None


def is_setup_complete_for_current_version() -> bool:
    """True if the wizard has been run (or skipped) for the current
    APP_VERSION. Frontend skips showing the wizard when this is True."""
    state = load_persisted_state()
    completed = state.get("completed_for_version")
    return completed == APP_VERSION


# ── Detection helpers ──────────────────────────────────────────────

def _check_msvc_redist() -> bool:
    """Detect MSVC 2015-2022 x64 Redistributable via the registry.

    Microsoft sets `Installed = 1` under
    HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64
    once the redist is present. We accept ANY Installed=1 there because
    the version major (14) covers VS 2015 through current.
    """
    if sys.platform != "win32":
        return True   # not applicable elsewhere
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64",
        )
        try:
            v, _ = winreg.QueryValueEx(key, "Installed")
            return int(v) == 1
        finally:
            winreg.CloseKey(key)
    except FileNotFoundError:
        return False
    except Exception as e:
        log.warning(f"MSVC redist registry check failed: {e}")
        return False


def _is_microsoft_store_alias(python_path: str) -> bool:
    """Detect the Windows 10/11 App Execution Alias stub for Python.

    Windows ships `python.exe` and `python3.exe` shortcuts in
    %LOCALAPPDATA%\\Microsoft\\WindowsApps\\ that look like real Python
    but actually do nothing useful: running them with no args opens
    the Microsoft Store install page, and running with args prints
    "Python was not found; run without arguments to install from the
    Microsoft Store..." and exits 9009.

    The wizard was accepting this shim as a real Python, then pip
    install would explode. Detect by path — `WindowsApps` is the
    canonical alias directory.
    """
    if not python_path:
        return False
    return "WindowsApps" in python_path.replace("/", "\\")


def _verify_python(python_path: str) -> bool:
    """Run `python -c "import sys"` to confirm it's actually a working
    Python interpreter, not a Microsoft Store stub or broken install.

    Synchronous (uses subprocess directly) because we call this from
    _check_python() which is called outside an async context too.
    """
    import subprocess as _sp
    try:
        r = _sp.run(
            [python_path, "-c", "import sys; print(sys.version_info[:2])"],
            capture_output=True, timeout=8,
            **subprocess_no_window_kwargs(),
        )
        # Real Python prints `(3, 12)` on stdout. Stub prints store
        # error on stderr and exits 9009. Reject any non-zero exit.
        return r.returncode == 0 and b"(" in (r.stdout or b"")
    except Exception:
        return False


def _check_python() -> Optional[str]:
    """Find an external Python 3.x interpreter (skip the frozen EXE).

    Order: persisted path → PATH search (skipping Microsoft Store
    aliases + the frozen EXE itself) → common install dirs. The result
    is verified with `--version` so we never return a path that pip
    install would choke on.
    """
    persisted = get_persisted_python_path()
    if persisted and _verify_python(persisted):
        return persisted

    candidates: list[str] = []
    for name in ("python3", "python", "py"):
        p = shutil.which(name)
        if not p:
            continue
        # Skip the frozen EXE itself
        if IS_FROZEN and Path(p).resolve() == Path(sys.executable).resolve():
            continue
        # Skip Microsoft Store alias shims — they look real but only
        # run `pip install ...` to be redirected to the Store.
        if _is_microsoft_store_alias(p):
            log.debug(f"Skipping Microsoft Store alias: {p}")
            continue
        candidates.append(p)

    # Common install paths after PATH search
    if sys.platform == "win32":
        for c in [
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python",
            Path("C:/Program Files/Python312"),
            Path("C:/Program Files/Python313"),
            Path("C:/Program Files/Python311"),
        ]:
            if c.exists():
                for sub in c.rglob("python.exe"):
                    if not _is_microsoft_store_alias(str(sub)):
                        candidates.append(str(sub))

    # Verify each candidate actually works
    for c in candidates:
        if _verify_python(c):
            return c
    return None


async def _check_module(python: str, module: str) -> bool:
    proc = await asyncio.create_subprocess_exec(
        python, "-c", f"import {module}",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        **subprocess_no_window_kwargs(),
    )
    return (await proc.wait()) == 0


def _check_cuda_available() -> bool:
    """Return True if `nvidia-smi` runs successfully, i.e. user has an
    NVIDIA GPU + driver. We use this to pick CUDA torch wheels."""
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        return False
    try:
        import subprocess as _sp
        r = _sp.run(
            [nvidia_smi, "-L"],
            capture_output=True, timeout=5,
            **subprocess_no_window_kwargs(),
        )
        return r.returncode == 0 and b"GPU" in (r.stdout or b"")
    except Exception:
        return False


def _check_lama_model() -> bool:
    """Whether big-lama.pt is cached somewhere simple_lama can find it."""
    candidates = [
        Path.home() / ".cache" / "torch" / "hub" / "checkpoints" / "big-lama.pt",
        Path.home() / "AppData" / "Roaming" / "toolshelper" / "models"
            / "hub" / "checkpoints" / "big-lama.pt",
    ]
    return any(
        c.exists() and c.stat().st_size > 100 * 1024 * 1024
        for c in candidates
    )


async def compute_needs() -> dict:
    """Run all detection probes and return what the wizard needs to do.

    This is what /api/system/setup-status calls. Updates _SETUP_STATE so
    the UI also sees the booleans without a separate call.
    """
    has_msvc = _check_msvc_redist()
    py = _check_python()
    has_python = py is not None
    has_torch = await _check_module(py, "torch") if has_python else False
    has_simple_lama = await _check_module(py, "simple_lama_inpainting") if has_python else False
    has_cv2_ext = await _check_module(py, "cv2") if has_python else False
    # v1.1+ deps — added so the wizard auto-installs them on first run
    # for end users (instead of users hitting cryptic ImportError later).
    has_google_genai = await _check_module(py, "google.genai") if has_python else False
    has_onnxruntime = await _check_module(py, "onnxruntime") if has_python else False
    has_model = _check_lama_model()

    needs_pip = has_python and not (
        has_torch and has_simple_lama and has_cv2_ext
        and has_google_genai and has_onnxruntime
    )

    _set_state(
        needs_msvc=not has_msvc,
        needs_python=not has_python,
        needs_pip=needs_pip or not has_python,   # pip can't run without python
        needs_model=not has_model,
        python_path=py,
    )

    return {
        "has_msvc": has_msvc,
        "has_python": has_python,
        "python_path": py,
        "has_torch": has_torch,
        "has_simple_lama": has_simple_lama,
        "has_cv2_ext": has_cv2_ext,
        "has_google_genai": has_google_genai,
        "has_onnxruntime": has_onnxruntime,
        "has_model": has_model,
        "has_cuda": _check_cuda_available(),
        "completed_for_version": load_persisted_state().get("completed_for_version"),
        "app_version": APP_VERSION,
        "all_ready": (
            has_msvc and has_python and has_torch
            and has_simple_lama and has_cv2_ext
            and has_google_genai and has_onnxruntime
            and has_model
        ),
        "msvc_install_url": MSVC_REDIST_URL,
    }


# ── Download helper ────────────────────────────────────────────────

async def _download(url: str, dest: Path, on_progress: Optional[ProgressCB],
                    label_prefix: str = "Downloading") -> None:
    """Stream-download a file with progress updates routed through the
    setup wizard's _emit/_set_state hooks. Atomic-ish via .part rename."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    downloaded = 0
    async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
        async with client.stream("GET", url) as r:
            r.raise_for_status()
            total = int(r.headers.get("Content-Length") or 0)
            bytes_since = 0
            emit_every = 1 << 18  # 256KB
            with tmp.open("wb") as f:
                async for chunk in r.aiter_bytes(1 << 15):
                    if not chunk:
                        continue
                    f.write(chunk)
                    downloaded += len(chunk)
                    bytes_since += len(chunk)
                    if total > 0:
                        _set_state(percent=round(downloaded / total * 100, 1))
                        _set_state(step_label=(
                            f"{label_prefix}: "
                            f"{downloaded / 1e6:.1f} / {total / 1e6:.1f} MB"
                        ))
                    if bytes_since >= emit_every:
                        await _emit(on_progress)
                        bytes_since = 0
    if dest.exists():
        dest.unlink()
    tmp.rename(dest)


# ── Step implementations ───────────────────────────────────────────

async def _step_install_python(on_progress: Optional[ProgressCB]) -> str:
    """Download python-3.12.x-amd64.exe and run silent per-user install.
    Returns the absolute path to the new python.exe."""
    _set_state(current_step="python", step_label="Tải Python 3.12 installer…", percent=0)
    await _emit(on_progress)

    installer = DATA_DIR / "_python_installer.exe"
    await _download(PYTHON_INSTALLER_URL, installer, on_progress,
                    label_prefix="Tải Python")

    _set_state(step_label="Đang cài Python (không cần UAC, ~30s)…", percent=100)
    await _emit(on_progress)

    # /quiet PrependPath=1 Include_pip=1 InstallAllUsers=0
    # InstallAllUsers=0 → installs into %LOCALAPPDATA%\Programs\Python\Python312\
    # which doesn't need UAC. PrependPath=1 updates the user's PATH (we still
    # save the absolute python.exe path so subprocess can find it without
    # waiting for env refresh).
    proc = await asyncio.create_subprocess_exec(
        str(installer),
        "/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_pip=1",
        "Include_test=0", "Include_doc=0", "Include_tcltk=0",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        **subprocess_no_window_kwargs(),
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        # Installer exits with non-zero codes for many reasons (already
        # installed, user canceled UAC, etc.). Treat 0 and 1638 (already
        # installed) as success.
        if proc.returncode != 1638:
            tail = (out or b"").decode("utf-8", errors="replace")[-500:]
            raise RuntimeError(
                f"Python installer exited {proc.returncode}. "
                f"Output tail: {tail}"
            )

    # Find the new python.exe — installer puts it under LOCALAPPDATA
    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python" / "Python312" / "python.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python" / "Python312-32" / "python.exe",
    ]
    for c in candidates:
        if c.exists():
            log.info(f"Python installed at: {c}")
            try:
                installer.unlink()   # tidy up the installer file
            except Exception:
                pass
            return str(c)

    raise RuntimeError(
        "Python installer ran but the new python.exe wasn't found. "
        "Tải thủ công từ python.org và cài lại."
    )


_PIP_PROGRESS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)\s*MB")


async def _step_pip_install(python: str, with_cuda: bool,
                            on_progress: Optional[ProgressCB]) -> None:
    """pip install the runtime deps. Picks the CUDA torch wheel when
    `with_cuda=True`, else the default (CPU) build."""
    _set_state(current_step="pip", step_label="Đang cài pip packages…", percent=0)
    await _emit(on_progress)

    # Lightweight deps — small + fast, install together first so user sees
    # immediate progress before the big torch download.
    #
    # google-genai (v1.1+): Vertex AI commercial mode SDK. Required when
    #   user picks Auth mode = "Vertex AI Commercial" in Settings.
    # onnxruntime (v1.1+): rembg ML backend. Without it, the "Tách Nền"
    #   page crashes with SystemExit: 1 at import time.
    light_packages = [
        "opencv-python",
        "simple-lama-inpainting",
        "google-genai",
        "onnxruntime",
    ]
    args = [python, "-m", "pip", "install", "--upgrade", *light_packages]

    # CUDA torch: separate install with --index-url to grab the cu121 wheel
    if with_cuda:
        # Phase A: install non-torch packages (fast, ~50MB total)
        await _run_pip(args, on_progress, "Cài opencv + lama + genai + onnx…")
        # Phase B: torch with CUDA (slow, ~2GB)
        torch_args = [
            python, "-m", "pip", "install", "--upgrade",
            "--index-url", TORCH_CUDA_INDEX, "torch",
        ]
        await _run_pip(torch_args, on_progress, "Cài torch (CUDA, ~2GB)…")
    else:
        args.append("torch")
        await _run_pip(args, on_progress, "Cài torch + deps (CPU, ~700MB)…")


async def _run_pip(args: list[str], on_progress: Optional[ProgressCB],
                   label: str) -> None:
    _set_state(step_label=label)
    await _emit(on_progress)
    log.info(f"spawn: {' '.join(args)}")
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        **subprocess_no_window_kwargs(),
    )
    assert proc.stdout
    current_pct = 0.0
    while True:
        raw = await proc.stdout.readline()
        if not raw:
            break
        line = raw.decode("utf-8", errors="replace").rstrip()
        _append_log(line)
        m = _PIP_PROGRESS_RE.search(line)
        if m:
            cur, tot = float(m.group(1)), float(m.group(2))
            if tot > 0:
                current_pct = min(99.0, cur / tot * 100)
        if "Successfully installed" in line:
            current_pct = 100.0
        _set_state(percent=round(current_pct, 1), step_label=line[:140])
        await _emit(on_progress)

    rc = await proc.wait()
    if rc != 0:
        tail = "\n".join(_SETUP_STATE["log_tail"][-12:])
        raise RuntimeError(f"pip install exited {rc}. Log tail:\n{tail}")


async def _step_download_model(on_progress: Optional[ProgressCB]) -> None:
    target = Path.home() / ".cache" / "torch" / "hub" / "checkpoints" / "big-lama.pt"
    if target.exists() and target.stat().st_size > 100 * 1024 * 1024:
        log.info(f"big-lama.pt already at {target}, skip download")
        return
    _set_state(current_step="model", step_label="Đang tải big-lama.pt…", percent=0)
    await _emit(on_progress)
    await _download(LAMA_MODEL_URL, target, on_progress, label_prefix="Tải model")


# ── Orchestrator ───────────────────────────────────────────────────

async def run_setup(on_progress: Optional[ProgressCB] = None) -> bool:
    """Run the full pipeline. Holds _SETUP_LOCK so only one runs at a time.
    Returns True on success. Persists state to setup-state.json on success
    so re-launches skip the wizard."""
    if _SETUP_LOCK.locked():
        raise RuntimeError("Setup đang chạy rồi — đợi xong rồi thử lại.")

    async with _SETUP_LOCK:
        try:
            _set_state(
                stage="running", error=None, log_tail=[],
                step_label="Bắt đầu kiểm tra dependencies…", percent=0,
            )
            await _emit(on_progress)

            # Re-detect right at the start (don't trust cached needs_ flags)
            needs = await compute_needs()

            # Step 1: MSVC — detect only. If missing, surface the link
            # but don't block the rest of the pipeline. User can install
            # it after the wizard finishes if a feature breaks.
            _set_state(current_step="msvc")
            if not needs["has_msvc"]:
                _append_log("⚠ MSVC Redistributable chưa cài — một số native DLL "
                            "có thể fail. Tải tại: " + MSVC_REDIST_URL)
                await _emit(on_progress)

            # Step 2: Python — install if absent
            python_path = needs["python_path"]
            if not python_path:
                python_path = await _step_install_python(on_progress)
                _set_state(python_path=python_path)
                await _emit(on_progress)

            # Step 3: pip — install missing packages
            need_pip = not (needs["has_torch"] and needs["has_simple_lama"]
                            and needs["has_cv2_ext"])
            if need_pip:
                await _step_pip_install(python_path, needs["has_cuda"], on_progress)

            # Step 4: Model — download if absent
            if not needs["has_model"]:
                await _step_download_model(on_progress)

            # Persist success marker → next launch skips wizard
            save_persisted_state({
                "completed_for_version": APP_VERSION,
                "completed_at": datetime.now().isoformat(timespec="seconds"),
                "python_path": python_path,
                "steps": {
                    "msvc": "ok" if needs["has_msvc"] else "skipped",
                    "python": "ok",
                    "pip": "ok",
                    "model": "ok",
                },
                "skipped": False,
            })

            # Invalidate the lama_status cache so the watermark page sees
            # the new deps immediately on next visit.
            try:
                from .watermark_video import invalidate_status_cache
                invalidate_status_cache()
            except Exception:
                pass

            _set_state(
                stage="done", current_step=None,
                step_label="Hoàn tất! Tool sẵn sàng.", percent=100, error=None,
            )
            await _emit(on_progress)
            return True

        except Exception as e:
            log.exception("Setup pipeline crashed")
            _set_state(stage="error", error=str(e),
                       step_label=f"Lỗi: {e}")
            await _emit(on_progress)
            raise
