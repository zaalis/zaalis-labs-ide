@echo off
REM ============================================================
REM  Builds the Linux x64 Electron app, portable package and Debian installer.
REM  Outputs:
REM    native\installer\zaalis-linux-x64.tar.gz
REM    native\installer\zaalis-linux-x64.deb
REM ============================================================
setlocal
cd /d "%~dp0\.."

set "SERVERDIST=native\dist-linux-server"
set "DIST=native\dist-linux"
set "INSTALLER=native\installer"

if not exist "%SERVERDIST%" mkdir "%SERVERDIST%"
if not exist "%SERVERDIST%\bin" mkdir "%SERVERDIST%\bin"
if not exist "%INSTALLER%" mkdir "%INSTALLER%"

echo [1/9] Ensuring build tools are installed...
call npm install
if errorlevel 1 goto :failed

echo [1b/9] Checking source encoding...
call npm run check:mojibake
if errorlevel 1 goto :failed

echo [2/9] Preparing Electron icons...
powershell -NoProfile -ExecutionPolicy Bypass -File native\prepare_electron_icons.ps1
if errorlevel 1 goto :failed

echo [3/9] Packaging server -^> %SERVERDIST%\zaalis-server ...
call npx pkg . --no-bytecode --public --public-packages "*" --targets node22-linux-x64 --output "%SERVERDIST%\zaalis-server"
if errorlevel 1 goto :failed

where wsl >nul 2>nul
if errorlevel 1 goto :nowsl
for /f "delims=" %%I in ('wsl wslpath -a "%CD%"') do set "WSL_ROOT=%%I"

echo Building native local speech engine...
wsl -e sh "%WSL_ROOT%/native/build_whisper.sh"
if errorlevel 1 goto :failed

echo [4/9] Building Linux node-pty native runtime...
wsl -e sh "%WSL_ROOT%/native/build_linux_node_pty.sh" "%WSL_ROOT%"
if errorlevel 1 goto :failed

echo [4b/9] Staging connectors: WhatsApp bridge, GitHub client, cloudflared...
wsl -e sh "%WSL_ROOT%/native/stage_linux_connectors.sh" "%WSL_ROOT%" "%WSL_ROOT%/native/dist-linux-server"
if errorlevel 1 goto :failed

echo [5/9] Building the Rust core (zaalis-agentd, CLI, sandbox) in WSL...
wsl -e sh -lc "cd '%WSL_ROOT%' && cargo build --manifest-path rust/Cargo.toml --release -p zaalis-cli -p zaalis-agentd -p zaalis-sandbox-helper"
if errorlevel 1 goto :nocargo

echo [6/9] Staging the Rust binaries -^> %SERVERDIST% ...
wsl -e sh "%WSL_ROOT%/scripts/stage-rust-binaries.sh" "%WSL_ROOT%/native/dist-linux-server"
if errorlevel 1 goto :failed
REM Same terminal client as Windows (bin\zaalis.exe = packaged cli.js).
call npx pkg src/app/cli.js --no-bytecode --public --targets node22-linux-x64 --output "%SERVERDIST%\bin\zaalis"
if errorlevel 1 goto :failed

echo [7/9] Copying interface and metadata...
robocopy interface "%SERVERDIST%\interface" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 goto :failed
if exist image robocopy image "%SERVERDIST%\image" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 goto :failed
copy /Y package.json "%SERVERDIST%\package.json" >nul
copy /Y README_LINUX.md "%SERVERDIST%\README.txt" >nul

echo [8/9] Packaging Electron app -^> %DIST% ...
node native\package_electron.js linux x64 "%SERVERDIST%" "%DIST%"
REM A crashed node exits with a negative code, which "if errorlevel 1" misses.
if not "%errorlevel%"=="0" goto :failed

echo [9/9] Creating portable archive and Debian double-click installer...
tar -czf "%INSTALLER%\zaalis-linux-x64.tar.gz" -C "%DIST%" .
if errorlevel 1 goto :failed

wsl -e sh "%WSL_ROOT%/native/build_linux_deb.sh" "%WSL_ROOT%"
if errorlevel 1 goto :failed

echo.
echo Done. Linux packages:
echo   %INSTALLER%\zaalis-linux-x64.tar.gz
echo   %INSTALLER%\zaalis-linux-x64.deb
goto :eof

:nocargo
echo ERROR: the Rust core failed to build inside WSL.
echo Install the Rust toolchain there:  wsl -e sh -lc "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
echo zaalis-agentd is required: without it Chat, Agents and the CLI have no engine.
exit /b 1

:nowsl
echo ERROR: WSL with dpkg-deb and a Rust toolchain is required to build native\installer\zaalis-linux-x64.deb.
echo The portable archive was still created at %INSTALLER%\zaalis-linux-x64.tar.gz.
exit /b 1

:failed
echo BUILD FAILED.
exit /b 1
