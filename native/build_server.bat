@echo off
REM ============================================================
REM  Builds the Node server into a standalone .exe (no Node needed)
REM  Output: native\dist\zaalis-server.exe
REM ============================================================
cd /d "%~dp0\.."

echo [1/2] Installing the packager (@yao-pkg/pkg)...
call npm install --save-dev @yao-pkg/pkg
if errorlevel 1 goto :error

echo [2/2] Packaging server.js -^> native\dist\zaalis-server.exe ...
call npx pkg . --targets node22-win-x64 --output native\dist\zaalis-server.exe
if errorlevel 1 goto :error

echo.
echo Done. Server packaged at native\dist\zaalis-server.exe
goto :eof

:error
echo.
echo Build failed.
exit /b 1
