@echo off
REM ── RedOne Hub — local dev launcher (Windows) ──
REM Creates a venv, installs deps, runs the API with auto-reload on :8800.
REM Reads config from .env (copy .env.example -> .env first).
cd /d %~dp0

if not exist .venv (
    echo [hub] Creating venv...
    python -m venv .venv
)
call .venv\Scripts\activate.bat

echo [hub] Installing deps...
python -m pip install --upgrade pip >nul
pip install -r requirements.txt

echo [hub] Starting RedOne Hub on http://127.0.0.1:8800 ...
uvicorn app.main:app --reload --port 8800
