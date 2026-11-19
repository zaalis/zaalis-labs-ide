@echo off
setlocal
cd /d "%~dp0\.."
where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo ERROR: WSL with Node.js, Rust, dpkg-deb and a native build toolchain is required.
  exit /b 1
)
REM WSL starts in the working directory, so all Linux tools use the same checkout.
wsl.exe -- sh native/build_linux.sh
exit /b %errorlevel%
