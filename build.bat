@echo off
REM ============================================================
REM   RedOne Creative — Build EXE bằng PyInstaller (--onedir)
REM ============================================================
REM   Usage:
REM     1. Đảm bảo đã `pip install -r requirements.txt`
REM     2. Double-click hoặc chạy `build.bat`
REM     3. Output ở: dist\RedOne Creative\
REM     4. Zip toàn bộ folder → upload làm GitHub release asset
REM ============================================================

cd /d "%~dp0"

echo.
echo [1/3] Cài/upgrade PyInstaller...
python -m pip install --upgrade pyinstaller

echo.
echo [2/3] Dọn dẹp build cũ...
if exist build rmdir /s /q build
if exist "dist\RedOne Creative" rmdir /s /q "dist\RedOne Creative"

echo.
echo [3/4] Đóng gói EXE (mất 2-5 phút)...
pyinstaller RedOne.spec --noconfirm --clean

if errorlevel 1 (
    echo.
    echo === BUILD THẤT BẠI ===
    pause
    exit /b 1
)

echo.
echo [4/4] Bundle Chrome extension...
REM Copy extension folder into the EXE bundle so user gets ext alongside
REM the tool — no need to download separately. User loads via
REM chrome://extensions Load unpacked.
if exist "dist\RedOne Creative" (
    xcopy /E /I /Y extension "dist\RedOne Creative\extension" >nul
    echo Đã copy extension/ → dist\RedOne Creative\extension\
)

REM Also produce a standalone ext zip in case bạn muốn distribute riêng
REM (host trên GitHub Releases / Drive / Mega).
if exist "dist\RedOne-AuthHelper-v1.0.0.zip" del "dist\RedOne-AuthHelper-v1.0.0.zip"
powershell -NoProfile -Command "Compress-Archive -Path 'extension' -DestinationPath 'dist\RedOne-AuthHelper-v1.0.0.zip' -Force"
echo Đã tạo dist\RedOne-AuthHelper-v1.0.0.zip (standalone)

echo.
echo ============================================================
echo BUILD XONG!
echo Output: %CD%\dist\RedOne Creative\
echo Chạy thử: dist\RedOne Creative\RedOne Creative.exe
echo.
echo Để release lên GitHub:
echo   1. Zip toàn bộ folder dist\RedOne Creative\ (extension/ đã bundle bên trong)
echo   2. Đặt tên zip: RedOne-Creative-v1.1.0-win64.zip
echo   3. Tạo release tag v1.1.0, upload cả 2 file:
echo      - RedOne-Creative-v1.1.0-win64.zip (tool + ext)
echo      - RedOne-AuthHelper-v1.0.0.zip     (ext standalone, optional)
echo ============================================================
pause
