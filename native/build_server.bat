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
call npm run build:server
if errorlevel 1 goto :error

REM node-pty is a native addon: pkg cannot load it from its virtual snapshot.
REM Keep its Windows binary alongside zaalis-server.exe for the integrated terminal.
if exist native\dist\node_modules rmdir /S /Q native\dist\node_modules
if exist native\dist\node_modules goto :copyerror
mkdir native\dist\node_modules
robocopy "node_modules\node-pty" "native\dist\node_modules\node-pty" /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS >nul
set "COPY_RC=%ERRORLEVEL%"
if %COPY_RC% GEQ 8 goto :copyerror

REM A corrupt JavaScript file in node-pty looks like "Invalid or unexpected
REM token" only when the user opens the terminal. Check a representative file
REM now so the installer can never be published with that silent corruption.
fc /B "node_modules\node-pty\lib\shared\conout.js" "native\dist\node_modules\node-pty\lib\shared\conout.js" >nul
if errorlevel 1 goto :copyerror

echo.
echo Done. Server packaged at native\dist\zaalis-server.exe
goto :eof

:error
echo.
echo Build failed.
exit /b 1

:copyerror
echo.
echo Build failed: node-pty could not be copied and verified.
exit /b 1
