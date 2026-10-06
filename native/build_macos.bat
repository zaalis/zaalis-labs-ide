@echo off
REM ============================================================
REM  Builds macOS x64 and arm64 Electron apps plus a double-click installer.
REM  Outputs:
REM    native\installer\zaalis-macos-x64.tar.gz
REM    native\installer\zaalis-macos-arm64.tar.gz
REM    native\installer\zaalis-macos-universal-installer.tar.gz
REM ============================================================
setlocal
cd /d "%~dp0\.."

set "INSTALLER=native\installer"
if not exist "%INSTALLER%" mkdir "%INSTALLER%"

echo [1/10] Ensuring build tools are installed...
call npm install
if errorlevel 1 goto :failed

echo Checking source encoding...
call npm run check:mojibake
if errorlevel 1 goto :failed

echo [2/10] Preparing Electron icons...
powershell -NoProfile -ExecutionPolicy Bypass -File native\prepare_electron_icons.ps1
if errorlevel 1 goto :failed
node native\make_icns.js
if errorlevel 1 goto :failed

where wsl >nul 2>nul
if errorlevel 1 goto :nowsl
for /f "delims=" %%I in ('wsl wslpath -a "%CD%"') do set "WSL_ROOT=%%I"

set "SERVERDIST=native\dist-macos-x64-server"
set "DIST=native\dist-macos-x64"
if not exist "%SERVERDIST%" mkdir "%SERVERDIST%"
if not exist "%SERVERDIST%\bin" mkdir "%SERVERDIST%\bin"

echo [3/10] Packaging macOS x64 server...
call npx pkg . --no-bytecode --public --public-packages "*" --targets node22-macos-x64 --output "%SERVERDIST%\zaalis-server"
if errorlevel 1 goto :failed

echo [4/10] Packaging macOS x64 CLI...
call npx pkg cli.js --no-bytecode --public --public-packages "*" --targets node22-macos-x64 --output "%SERVERDIST%\bin\zaalis"
if errorlevel 1 goto :failed

echo [5/10] Copying macOS x64 assets...
robocopy interface "%SERVERDIST%\interface" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 goto :failed
if exist image robocopy image "%SERVERDIST%\image" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 goto :failed
copy /Y package.json "%SERVERDIST%\package.json" >nul
copy /Y README_MACOS.md "%SERVERDIST%\README.txt" >nul

echo [6/10] Packaging macOS x64 Electron app...
node native\download_electron_macos.js x64 native\.electron-cache\electron-darwin-x64.zip
if errorlevel 1 goto :failed
wsl -e sh "%WSL_ROOT%/native/package_macos_electron.sh" "%WSL_ROOT%" x64 "%WSL_ROOT%/native/dist-macos-x64-server" "%WSL_ROOT%/native/.electron-cache/electron-darwin-x64.zip" "%WSL_ROOT%/native/dist-macos-x64"
if errorlevel 1 goto :failed
wsl -e tar -czf "%WSL_ROOT%/native/installer/zaalis-macos-x64.tar.gz" -C "%WSL_ROOT%/native/dist-macos-x64" .
if errorlevel 1 goto :failed

set "SERVERDIST=native\dist-macos-arm64-server"
set "DIST=native\dist-macos-arm64"
if not exist "%SERVERDIST%" mkdir "%SERVERDIST%"
if not exist "%SERVERDIST%\bin" mkdir "%SERVERDIST%\bin"

echo [7/10] Packaging macOS arm64 server...
call npx pkg . --no-bytecode --public --public-packages "*" --targets node22-macos-arm64 --output "%SERVERDIST%\zaalis-server"
if errorlevel 1 goto :failed

echo [8/10] Packaging macOS arm64 CLI...
call npx pkg cli.js --no-bytecode --public --public-packages "*" --targets node22-macos-arm64 --output "%SERVERDIST%\bin\zaalis"
if errorlevel 1 goto :failed

echo [9/10] Copying macOS arm64 assets...
robocopy interface "%SERVERDIST%\interface" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 goto :failed
if exist image robocopy image "%SERVERDIST%\image" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 goto :failed
copy /Y package.json "%SERVERDIST%\package.json" >nul
copy /Y README_MACOS.md "%SERVERDIST%\README.txt" >nul

echo [10/10] Packaging macOS arm64 Electron app and creating installer...
node native\download_electron_macos.js arm64 native\.electron-cache\electron-darwin-arm64.zip
if errorlevel 1 goto :failed
wsl -e sh "%WSL_ROOT%/native/package_macos_electron.sh" "%WSL_ROOT%" arm64 "%WSL_ROOT%/native/dist-macos-arm64-server" "%WSL_ROOT%/native/.electron-cache/electron-darwin-arm64.zip" "%WSL_ROOT%/native/dist-macos-arm64"
if errorlevel 1 goto :failed
wsl -e tar -czf "%WSL_ROOT%/native/installer/zaalis-macos-arm64.tar.gz" -C "%WSL_ROOT%/native/dist-macos-arm64" .
if errorlevel 1 goto :failed

echo Creating macOS double-click installer...
wsl -e sh "%WSL_ROOT%/native/build_macos_installer.sh" "%WSL_ROOT%"
if errorlevel 1 goto :failed

echo.
echo Done. macOS packages:
echo   %INSTALLER%\zaalis-macos-x64.tar.gz
echo   %INSTALLER%\zaalis-macos-arm64.tar.gz
echo   %INSTALLER%\zaalis-macos-universal-installer.tar.gz
goto :eof

:nowsl
echo ERROR: WSL is required to create the macOS installer archive with executable permissions.
exit /b 1

:failed
echo BUILD FAILED.
exit /b 1
