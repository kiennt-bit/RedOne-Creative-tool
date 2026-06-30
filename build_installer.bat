@echo off
REM ============================================================
REM   RedOne Creative — Build bo cai dat (Inno Setup)
REM ------------------------------------------------------------
REM   Prereq:
REM     1) Inno Setup 6 da cai:  winget install -e --id JRSoftware.InnoSetup
REM     2) Da build app:         build.bat  (-> dist\RedOne Creative\)
REM   Output: dist\RedOne-Creative-Setup-v1.5.0.exe
REM ============================================================
cd /d "%~dp0"

set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
    echo.
    echo [installer] Khong tim thay Inno Setup 6 ^(ISCC.exe^).
    echo            Cai bang:  winget install -e --id JRSoftware.InnoSetup
    echo            Hoac tai:  https://jrsoftware.org/isdl.php
    echo.
    pause
    exit /b 1
)

if not exist "dist\RedOne Creative\RedOne Creative.exe" (
    echo.
    echo [installer] Chua thay dist\RedOne Creative\. Chay build.bat truoc da.
    echo.
    pause
    exit /b 1
)

echo [installer] Dang compile installer\RedOne.iss ...
"%ISCC%" "installer\RedOne.iss"
if errorlevel 1 (
    echo.
    echo === BUILD INSTALLER THAT BAI ===
    pause
    exit /b 1
)

echo.
echo ============================================================
echo XONG! Bo cai: %CD%\dist\RedOne-Creative-Setup-v1.5.0.exe
echo   - Member chay file nay (Yes o UAC) -^> cai app + extension.
echo   - Sau cai: dong/mo lai Chrome de extension tu ve.
echo ============================================================
pause
