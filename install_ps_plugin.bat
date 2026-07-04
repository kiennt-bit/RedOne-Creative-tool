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

REM ── Step 2: Create symbolic link ──
set PLUGIN_SRC=%~dp0photoshop-plugin
set PLUGIN_DST=C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\com.redone.genfill

echo.
echo [2/3] Creating extension symlink...
echo      Source: %PLUGIN_SRC%
echo      Target: %PLUGIN_DST%

if exist "%PLUGIN_DST%" (
    echo      Link already exists, removing old one...
    rmdir "%PLUGIN_DST%" 2>nul
    del "%PLUGIN_DST%" 2>nul
)

mklink /D "%PLUGIN_DST%" "%PLUGIN_SRC%"
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to create symlink. Make sure:
    echo   1. You are running this as Administrator
    echo   2. The target directory doesn't already exist
    echo.
    echo Trying copy fallback...
    xcopy "%PLUGIN_SRC%\*" "%PLUGIN_DST%\" /E /I /Y /Q
    if errorlevel 1 (
        echo [ERROR] Copy also failed. Please run as Administrator.
        pause
        exit /b 1
    )
)

REM ── Step 3: Done ──
echo.
echo [3/3] Installation complete!
echo.
echo ─────────────────────────────────────────────
echo Next steps:
echo   1. Restart Photoshop
echo   2. Window → Extensions → RedOne GenFill
echo   3. Make sure RedOne Creative Tool is running
echo ─────────────────────────────────────────────
echo.
pause
