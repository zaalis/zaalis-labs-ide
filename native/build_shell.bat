@echo off
REM ============================================================
REM  Compiles the C++ WebView2 shell -> native\dist\zaalis.exe
REM  Requires Visual Studio with the C++ workload (MSVC).
REM ============================================================
setlocal
cd /d "%~dp0"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto :novs

set "VSPATH="
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH goto :novs
echo Visual Studio: %VSPATH%

set "VCVARS=%VSPATH%\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" goto :nocpp
call "%VCVARS%" >nul

if not exist dist mkdir dist

echo Compiling icon resource ...
rc /nologo /fo dist\app.res app.rc
if errorlevel 1 goto :failed

echo Compiling main.cpp ...
cl /nologo /std:c++17 /utf-8 /EHsc /O2 /DUNICODE /D_UNICODE main.cpp browser\BrowserHost.cpp /I "packages\webview2\build\native\include" /Fe:dist\zaalis.exe /Fo:dist\ /link /SUBSYSTEM:WINDOWS dist\app.res "packages\webview2\build\native\x64\WebView2LoaderStatic.lib" ws2_32.lib ole32.lib oleaut32.lib version.lib advapi32.lib shell32.lib shlwapi.lib user32.lib gdi32.lib dwmapi.lib windowsapp.lib comctl32.lib crypt32.lib windowscodecs.lib bcrypt.lib uuid.lib /MANIFEST:EMBED
if errorlevel 1 goto :failed

echo Compiling pickfolder.cpp ...
cl /nologo /std:c++17 /EHsc /O2 /DUNICODE /D_UNICODE pickfolder.cpp /Fe:dist\pickfolder.exe /Fo:dist\pf.obj /link /SUBSYSTEM:CONSOLE ole32.lib shell32.lib uuid.lib user32.lib
if errorlevel 1 goto :failed

REM --- Copy the interface/ folder (including subfolders) next to the exe ---
if exist dist\interface rmdir /S /Q dist\interface
if not exist dist\interface mkdir dist\interface
xcopy "..\interface\*" "dist\interface\" /E /Y /I /Q >nul
del /Q dist\*.obj >nul 2>&1
del /Q dist\index.html dist\script.js dist\styles.css >nul 2>&1

REM --- Copy cloudflared (phone remote-control tunnel) next to the exe ---
if exist cloudflared.exe copy /Y cloudflared.exe dist\cloudflared.exe >nul

REM --- Copy whisper.cpp (local dictation engine) next to the exe ---
if exist dist\whisper rmdir /S /Q dist\whisper
xcopy "whisper\*" "dist\whisper\" /E /Y /I /Q >nul
if errorlevel 1 goto :failed

echo.
echo Done. The ready-to-run app is in native\dist\
echo   ( zaalis.exe + zaalis-server.exe + pickfolder.exe + cloudflared.exe + interface\ + whisper\ )
goto :eof

:novs
echo ERROR: Visual Studio not found.
exit /b 1
:nocpp
echo ERROR: C++ workload (vcvars64.bat) not found.
exit /b 1
:failed
echo.
echo BUILD FAILED.
exit /b 1
