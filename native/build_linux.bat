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

echo [1/7] Ensuring build tools are installed...
call npm install
if errorlevel 1 goto :failed

echo [1b/7] Checking source encoding...
call npm run check:mojibake
if errorlevel 1 goto :failed

echo [2/7] Preparing Electron icons...
powershell -NoProfile -ExecutionPolicy Bypass -File native\prepare_electron_icons.ps1
if errorlevel 1 goto :failed

echo [3/7] Packaging server -^> %SERVERDIST%\zaalis-server ...
call npx pkg . --no-bytecode --public --public-packages "*" --targets node22-linux-x64 --output "%SERVERDIST%\zaalis-server"
if errorlevel 1 goto :failed

echo [4/7] Packaging CLI -^> %SERVERDIST%\bin\zaalis ...
call npx pkg cli.js --no-bytecode --public --public-packages "*" --targets node22-linux-x64 --output "%SERVERDIST%\bin\zaalis"
if errorlevel 1 goto :failed

echo [5/7] Copying interface and metadata...
robocopy interface "%SERVERDIST%\interface" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 goto :failed
if exist image robocopy image "%SERVERDIST%\image" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 goto :failed
copy /Y package.json "%SERVERDIST%\package.json" >nul
copy /Y README_LINUX.md "%SERVERDIST%\README.txt" >nul

echo [6/7] Packaging Electron app -^> %DIST% ...
node native\package_electron.js linux x64 "%SERVERDIST%" "%DIST%"
if errorlevel 1 goto :failed

echo [7/7] Creating portable archive and Debian double-click installer...
tar -czf "%INSTALLER%\zaalis-linux-x64.tar.gz" -C "%DIST%" .
if errorlevel 1 goto :failed

where wsl >nul 2>nul
if errorlevel 1 goto :nowsl
for /f "delims=" %%I in ('wsl wslpath -a "%CD%"') do set "WSL_ROOT=%%I"
wsl -e sh "%WSL_ROOT%/native/build_linux_deb.sh" "%WSL_ROOT%"
if errorlevel 1 goto :failed

echo.
echo Done. Linux packages:
echo   %INSTALLER%\zaalis-linux-x64.tar.gz
echo   %INSTALLER%\zaalis-linux-x64.deb
goto :eof

:nowsl
echo ERROR: WSL with dpkg-deb is required to build native\installer\zaalis-linux-x64.deb.
echo The portable archive was still created at %INSTALLER%\zaalis-linux-x64.tar.gz.
exit /b 1

:failed
echo BUILD FAILED.
exit /b 1
