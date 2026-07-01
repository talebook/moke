@echo off
echo ============================================
echo   reading-stats extension builder
echo ============================================
echo.

:: 1. Build Rust backend
echo [1/4] Building backend...
cd /d "%~dp0backend"
cargo build --release
if errorlevel 1 (
    echo Build failed!
    pause
    exit /b 1
)
cd /d "%~dp0"
echo.

:: 2. Prepare dist directory
echo [2/4] Preparing dist...
if exist dist rmdir /s /q dist
mkdir dist
mkdir dist\ui

copy manifest.json dist\ >nul
echo    copied: manifest.json

copy "backend\target\release\server.exe" dist\server.exe >nul
echo    copied: server.exe

xcopy /q ui dist\ui\ >nul
echo    copied: ui\index.html
echo.

:: 3. Build NSIS installer
echo [3/4] Building installer...
where makensis >nul 2>&1
if errorlevel 1 (
    echo WARNING: makensis not found in PATH. Install NSIS first.
    echo Download: https://nsis.sourceforge.io/Download
    echo.
    echo dist\ is ready. You can manually compile installer.nsi later.
    pause
    exit /b 0
)

makensis installer.nsi
if errorlevel 1 (
    echo NSIS build failed!
    pause
    exit /b 1
)
echo.

:: 4. Done
echo [4/4] Done!
echo.
dir reading-stats-setup.exe 2>nul
echo.
echo Run reading-stats-setup.exe to install.
echo Installs to: %%APPDATA%%\com.moke.client\extensions\reading-stats\
pause
