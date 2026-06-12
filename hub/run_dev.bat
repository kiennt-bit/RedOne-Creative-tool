@echo off
REM ── RedOne Hub — local dev launcher (Windows) ──
REM Creates a venv, installs deps, runs the API with auto-reload on :8800.
REM Reads config from .env (copy .env.example -> .env first).
cd /d %~dp0

if not exist .venv (
    echo [hub] Creating venv...
    python -m venv .venv
)

echo [hub] Installing deps...
.venv\Scripts\python.exe -m pip install --upgrade pip >nul
.venv\Scripts\python.exe -m pip install -r requirements.txt

echo [hub] Starting RedOne Hub on http://127.0.0.1:8800 ...
REM Run uvicorn via the venv's OWN python so the --reload worker also uses it
REM (a bare `uvicorn` may resolve to system Python which can't see venv deps).
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8800
