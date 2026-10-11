@echo off
setlocal
node ..\..\bin\moke-ext.js build
if errorlevel 1 exit /b 1
echo Build complete. Sign and package with:
echo node ..\..\bin\moke-ext.js sign --key C:\keys\publisher.pem --key-id your-key-id
echo node ..\..\bin\moke-ext.js package
