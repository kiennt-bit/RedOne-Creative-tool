@echo off
REM ─── RedOne GenFill — Start Standalone Server ───
REM Runs the GenFill server independently of RedOne Creative Tool.
REM The Chrome extension "RedOne Auth Helper" must be installed and active.

title RedOne GenFill Server

echo.
echo ╔══════════════════════════════════════════╗
echo ║   RedOne GenFill — Standalone Server     ║
echo ╚══════════════════════════════════════════╝
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.10+
    echo         https://www.python.org/downloads/
    pause
    exit /b 1
)

REM Check required packages
echo Checking dependencies...
python -c "import fastapi, uvicorn, httpx" >nul 2>&1
if errorlevel 1 (
    echo Installing required packages...
    pip install fastapi uvicorn httpx pillow
)

REM Start server
echo.
echo Starting GenFill server on port 8001...
echo (Press Ctrl+C to stop)
echo.

cd /d "%~dp0server"
if exist "venv\Scripts\python.exe" (
    venv\Scripts\python.exe ps_genfill_server.py --port 8001
) else (
    python ps_genfill_server.py --port 8001
)

pause
