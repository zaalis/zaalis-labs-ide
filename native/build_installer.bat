@echo off
REM ============================================================
REM  Builds the double-click installer -> native\installer\zaalis-setup.exe
REM  Requires Inno Setup 6 (winget install JRSoftware.InnoSetup).
REM  Run build_server.bat and build_shell.bat FIRST.
REM ============================================================
setlocal
cd /d "%~dp0"

set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" goto :noiscc

if not exist dist\zaalis.exe goto :nobuild
if not exist dist\zaalis-server.exe goto :nobuild
if not exist dist\zaalis-agentd.exe goto :norust
if not exist dist\zaalis-cli.exe goto :nocli
if not exist dist\whisper\whisper-cli.exe goto :nowhisper
if not exist dist\blender\mcp-1.0.3.zip goto :noblender
if not exist dist\vm\images\debian.qcow2 goto :novm

"%ISCC%" installer.iss
if errorlevel 1 goto :failed
echo.
echo Done. Installer -^> native\installer\zaalis-setup.exe
goto :eof

:noiscc
echo ERROR: Inno Setup not found. Install it with:  winget install JRSoftware.InnoSetup
exit /b 1
:noblender
echo ERROR: dist\blender\mcp-1.0.3.zip missing. Run build_shell.bat first.
exit /b 1
:novm
echo ERROR: VM pack missing. Run powershell -File ..\scripts\prepare-vm-assets.ps1 -Download
exit /b 1
:nowhisper
echo ERROR: dist\whisper\whisper-cli.exe missing. Run build_shell.bat first.
exit /b 1
:nocli
echo ERROR: Rust CLI dist\zaalis-cli.exe missing. Run build_cli.bat first.
exit /b 1
:norust
echo ERROR: dist\zaalis-agentd.exe missing. Run build_server.bat then build_cli.bat first.
exit /b 1
:nobuild
echo ERROR: dist\zaalis.exe or dist\zaalis-server.exe missing. Run build_server.bat then build_shell.bat first.
exit /b 1
:failed
echo BUILD FAILED.
exit /b 1
