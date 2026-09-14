@echo off
rem ============================================================
rem  ZhouJian launcher
rem  Keep this file PURE ASCII and CRLF.
rem  cmd.exe decodes .bat with the console codepage, so any
rem  non-ASCII byte can split a line into a bogus command.
rem ============================================================
setlocal
cd /d "%~dp0"

rem Use %CD% (no trailing backslash) to avoid the "dir\" quote-eating bug
set "APPDIR=%CD%"
set "EXE=%APPDIR%\node_modules\electron\dist\electron.exe"

rem Some shells preset these; they force Electron into plain Node mode
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="

if exist "%EXE%" goto launch

echo.
echo  [ZhouJian] Electron runtime not found.
echo.
echo    missing : %EXE%
echo.
where npm >nul 2>nul
if errorlevel 1 goto nonpm

echo  Installing dependencies (one time, needs network)...
echo.
call npm install
if not exist "%EXE%" goto stillmissing
goto launch

:nonpm
echo  npm was not found on PATH.
echo  Install Node.js first, then run this file again:
echo      https://nodejs.org/
echo.
pause
exit /b 1

:stillmissing
echo.
echo  Electron is still missing. Run this manually in the project folder:
echo      npm install
echo.
echo  If the download fails, use a mirror first:
echo      set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo      npm install
echo.
pause
exit /b 1

:launch
start "" "%EXE%" "%APPDIR%"
exit /b 0
