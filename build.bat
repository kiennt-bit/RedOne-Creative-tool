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
echo [3/3] Đóng gói (mất 2-5 phút)...
pyinstaller RedOne.spec --noconfirm --clean

if errorlevel 1 (
    echo.
    echo === BUILD THẤT BẠI ===
    pause
    exit /b 1
)

echo.
echo ============================================================
echo BUILD XONG!
echo Output: %CD%\dist\RedOne Creative\
echo Chạy thử: dist\RedOne Creative\RedOne Creative.exe
echo.
echo Để release lên GitHub:
echo   1. Zip toàn bộ folder dist\RedOne Creative\
echo   2. Đặt tên zip: RedOne-Creative-v1.0.1-win64.zip
echo   3. Tạo release tag v1.0.1 trên GitHub, upload zip làm asset
echo ============================================================
pause
