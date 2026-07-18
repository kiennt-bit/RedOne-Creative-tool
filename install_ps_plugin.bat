@echo off
REM ─── RedOne GenFill — Photoshop Plugin Installer ───
REM Run this as Administrator to install the CEP extension.

echo.
echo ╔══════════════════════════════════════════╗
echo ║   RedOne GenFill — PS Plugin Installer   ║
echo ╚══════════════════════════════════════════╝
echo.

REM ── Step 1: Enable PlayerDebugMode for unsigned extensions ──
echo [1/3] Enabling PlayerDebugMode (registry)...
for /L %%v in (7,1,14) do (
    reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)
echo      Done: PlayerDebugMode = 1 for CSXS.7 through CSXS.14

REM ── Step 2: Copy plugin files to CEP extensions folder ──
set PLUGIN_SRC=%~dp0photoshop-plugin
set PLUGIN_DST=C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\com.redone.genfill

echo.
echo [2/3] Installing extension files...
echo      Source: %PLUGIN_SRC%
echo      Target: %PLUGIN_DST%

if not exist "%PLUGIN_SRC%\index.html" (
    echo.
    echo [ERROR] Khong tim thay folder "photoshop-plugin" canh file install nay.
    echo         Dam bao file install nam cung thu muc voi folder "photoshop-plugin".
    pause
    exit /b 1
)

REM Remove old symlink or folder if exists
if exist "%PLUGIN_DST%" (
    echo      Removing old installation...
    rmdir /S /Q "%PLUGIN_DST%" 2>nul
)

REM Copy all files (no symlink dependency)
xcopy "%PLUGIN_SRC%\*" "%PLUGIN_DST%\" /E /I /Y /Q
if errorlevel 1 (
    echo.
    echo [ERROR] Copy failed. Make sure you are running this as Administrator.
    pause
    exit /b 1
)

echo      Done: Files copied successfully.

REM ── Step 3: Done ──
echo.
echo [3/3] Installation complete!
echo.
echo ─────────────────────────────────────────────
echo Next steps:
echo   1. Restart Photoshop
echo   2. Window → Extensions → RedOne GenFill
echo   3. Load the Chrome Extension ("extension" folder) in Developer Mode
echo   4. Keep a Chrome tab open at labs.google/fx/tools/flow
echo ─────────────────────────────────────────────
echo.
pause
