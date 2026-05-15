"""RedOne Creative — entry point for both dev (`python launch.py`) and the
PyInstaller-frozen EXE. Starts the FastAPI server then opens the browser.
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

# ── CRITICAL: must run BEFORE importing uvicorn/fastapi/backend ──────────
# When PyInstaller builds with --windowed (no console), sys.stdout and
# sys.stderr are None. Uvicorn's ColourizedFormatter calls
# `sys.stdout.isatty()` during init and crashes with:
#   AttributeError: 'NoneType' object has no attribute 'isatty'
#   ValueError: Unable to configure formatter 'default'
# Patch them to a tee that writes to a log file next to the EXE.
if sys.stdout is None or sys.stderr is None:
    try:
        if getattr(sys, "frozen", False):
            log_path = Path(sys.executable).parent / "console.log"
        else:
            log_path = Path("console.log")
        _log_fp = open(log_path, "a", encoding="utf-8", buffering=1)
    except Exception:
        _log_fp = open(os.devnull, "w", encoding="utf-8")

    class _StdStream:
        def __init__(self, fp):
            self._fp = fp
        def write(self, data):
            try:
                self._fp.write(data)
            except Exception:
                pass
            return len(data) if isinstance(data, str) else 0
        def flush(self):
            try: self._fp.flush()
            except Exception: pass
        def isatty(self):
            return False
        def fileno(self):
            raise OSError("no underlying fd")

    if sys.stdout is None:
        sys.stdout = _StdStream(_log_fp)
    if sys.stderr is None:
        sys.stderr = _StdStream(_log_fp)

import multiprocessing
import socket
import threading
import time
import webbrowser


def _is_port_open(host: str, port: int) -> bool:
    """Quick check whether something is listening on host:port."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.4)
    try:
        return s.connect_ex((host, port)) == 0
    finally:
        s.close()


def _open_browser_when_ready(host: str, port: int, timeout: float = 30.0):
    """Wait for the server to bind, then open the browser exactly once."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _is_port_open(host, port):
            try:
                webbrowser.open(f"http://{host}:{port}")
            except Exception:
                pass
            return
        time.sleep(0.25)


def main():
    # PyInstaller + multiprocessing must call freeze_support() first
    multiprocessing.freeze_support()

    # When frozen, MEIPASS holds the bundle dir; add to sys.path so
    # `backend.main` can be imported even though .pyc files live there.
    if getattr(sys, "frozen", False):
        bundle = Path(getattr(sys, "_MEIPASS", os.path.dirname(sys.executable)))
        if str(bundle) not in sys.path:
            sys.path.insert(0, str(bundle))

    # Launch browser in background while server boots
    from backend.config import SERVER_PORT
    host = "127.0.0.1"
    threading.Thread(
        target=_open_browser_when_ready,
        args=(host, SERVER_PORT),
        daemon=True,
    ).start()

    # Boot the FastAPI server (blocking)
    from backend.main import run
    run()


if __name__ == "__main__":
    main()
