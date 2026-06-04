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

"%ISCC%" installer.iss
if errorlevel 1 goto :failed
echo.
echo Done. Installer -^> native\installer\zaalis-setup.exe
goto :eof

:noiscc
echo ERROR: Inno Setup not found. Install it with:  winget install JRSoftware.InnoSetup
exit /b 1
:nobuild
echo ERROR: dist\zaalis.exe or dist\zaalis-server.exe missing. Run build_server.bat then build_shell.bat first.
exit /b 1
:failed
echo BUILD FAILED.
exit /b 1
