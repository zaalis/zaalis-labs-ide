@echo off
REM ============================================================
REM  Builds the Node server into a standalone .exe (no Node needed)
REM  Output: native\dist\zaalis-server.exe
REM ============================================================
cd /d "%~dp0\.."

echo [1/2] Checking the packager (@yao-pkg/pkg)...
if not exist node_modules\.bin\pkg.cmd (
    call npm ci
    if errorlevel 1 goto :error
)

echo [2/2] Packaging server.js -^> native\dist\zaalis-server.exe ...
call npm run build:server
if errorlevel 1 goto :error

echo.
echo Done. Server packaged at native\dist\zaalis-server.exe
goto :eof

:error
echo.
echo Build failed.
exit /b 1
