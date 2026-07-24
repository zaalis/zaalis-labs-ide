@echo off
REM ============================================================
REM  Builds the zaalis CLI into a standalone .exe (no Node needed)
REM  Output: native\dist\zaalis-cli.exe
REM  The installer drops this as {app}\bin\zaalis.exe (on the PATH).
REM ============================================================
cd /d "%~dp0\.."

echo [1/2] Ensuring the packager (@yao-pkg/pkg) is installed...
call npm install --save-dev @yao-pkg/pkg
if errorlevel 1 goto :error

echo [2/2] Packaging cli.js -^> native\dist\zaalis-cli.exe ...
call npm run build:cli
if errorlevel 1 goto :error

echo.
echo Done. CLI packaged at native\dist\zaalis-cli.exe
goto :eof

:error
echo.
echo Build failed.
exit /b 1
