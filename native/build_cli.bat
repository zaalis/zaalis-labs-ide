@echo off
REM ============================================================
REM  Builds the native Rust CLI and stages the Rust daemon.
REM  Output: native\dist\zaalis-cli.exe
REM  The installer drops this as {app}\bin\zaalis.exe (on the PATH).
REM ============================================================
cd /d "%~dp0\.."

echo Building and staging the Rust CLI/core ...
call npm run build:cli
if errorlevel 1 goto :error

echo.
echo Done. Rust CLI staged at native\dist\zaalis-cli.exe
goto :eof

:error
echo.
echo Build failed.
exit /b 1
