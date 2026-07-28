@echo off
REM ============================================================
REM   RedOne Creative — Build EXE bằng PyInstaller (--onedir)
REM ============================================================
REM   Usage:
REM     1. Đảm bảo đã `pip install -r requirements.txt`
REM     2. Double-click hoặc chạy `build.bat`
REM     3. Output ở: dist\RedOne Creative\
REM     4. File zip release ĐÃ được tạo sẵn (data đã sạch) ở dist\ —
REM        chỉ việc upload lên GitHub release.
REM ============================================================

cd /d "%~dp0"

echo.
echo [1/5] Cài/upgrade PyInstaller...
python -m pip install --upgrade pyinstaller

echo.
echo [2/5] Dọn dẹp build cũ...
if exist build rmdir /s /q build
if exist "dist\RedOne Creative" rmdir /s /q "dist\RedOne Creative"

echo.
echo [3/5] Đóng gói EXE (mất 2-5 phút)...
pyinstaller RedOne.spec --noconfirm --clean

if errorlevel 1 (
    echo.
    echo === BUILD THẤT BẠI ===
    pause
    exit /b 1
)

echo.
echo [4/5] Bundle Chrome extension...
REM Copy extension folder into the EXE bundle so user gets ext alongside
REM the tool — bản portable (zip) Load-unpacked từ folder này.
if exist "dist\RedOne Creative" (
    xcopy /E /I /Y extension "dist\RedOne Creative\extension" >nul
    echo   Da copy extension/ -^> dist\RedOne Creative\extension\
)

echo.
echo [5/5] Xoa SACH data ca nhan cua DEV roi dong zip release...
REM ═══════════════════════════════════════════════════════════════
REM QUAN TRONG (chong ro ri tai khoan): data/ nam CANH exe. Neu dev
REM tung chay app tu dist, data/ chua auth_session.json + navtools.db
REM mang account dev -> user cai ve TU dang nhap bang account dev.
REM   - Xoa NGUYEN thu muc data/ + outputs/ (KHONG xoa theo ten -> se
REM     sot navtools.db-wal/-shm, file session moi...).
REM   - Tao zip NGAY sau khi xoa: sau nay co chay thu tu dist (tao lai
REM     data/) cung KHONG lot vao zip da dong.
REM ═══════════════════════════════════════════════════════════════
if exist "dist\RedOne Creative\data" rmdir /S /Q "dist\RedOne Creative\data"
if exist "dist\RedOne Creative\outputs" rmdir /S /Q "dist\RedOne Creative\outputs"

REM Lay version tu backend\config.py (dong: APP_VERSION = "x.y.z").
set "APPVER=unknown"
for /f tokens^=2^ delims^=^" %%v in ('findstr /b /c:"APP_VERSION" "backend\config.py"') do set "APPVER=%%v"

set "RELZIP=dist\RedOne-Creative-v%APPVER%-win64.zip"
if exist "%RELZIP%" del /F /Q "%RELZIP%"
echo   Tao %RELZIP% ...
powershell -NoProfile -Command "Compress-Archive -Path 'dist\RedOne Creative\*' -DestinationPath '%RELZIP%' -Force"
if errorlevel 1 (
    echo   === TAO ZIP THAT BAI ===
    pause
    exit /b 1
)

REM Ext standalone zip (optional — neu muon distribute rieng).
if exist "dist\RedOne-AuthHelper.zip" del /F /Q "dist\RedOne-AuthHelper.zip"
powershell -NoProfile -Command "Compress-Archive -Path 'extension' -DestinationPath 'dist\RedOne-AuthHelper.zip' -Force"

echo.
echo ============================================================
echo BUILD XONG!
echo Release zip (data da sach): %CD%\%RELZIP%
echo   -^> Upload file nay len GitHub release tag v%APPVER%.
echo.
echo Gio chay thu thoai mai (KHONG anh huong zip da dong):
echo   dist\RedOne Creative\RedOne Creative.exe
echo ============================================================
pause
