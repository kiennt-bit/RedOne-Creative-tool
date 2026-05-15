"""RedOne Creative — entry point for both dev (`python launch.py`) and the
PyInstaller-frozen EXE. Starts the FastAPI server then opens the browser.
"""
from __future__ import annotations
import multiprocessing
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path


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
