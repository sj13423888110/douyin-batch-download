@echo off
chcp 65001 >nul
title Emergency Fix - Chrome Download Flood
setlocal
set "PYEXE="

if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PYEXE=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not defined PYEXE if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PYEXE where python >nul 2>nul && set "PYEXE=python"

if not defined PYEXE goto :nopython

echo ==============================================================
echo   EMERGENCY FIX - Chrome download flood cleanup
echo ==============================================================
echo.
echo   This script will, in order:
echo     1. FORCE-KILL every chrome.exe process
echo        (unsaved content in open tabs will be lost)
echo     2. Turn OFF "Ask where to save each file before downloading"
echo     3. Clear unfinished download records (finished history kept)
echo     4. Move Downloads\*.tmp leftovers to the Recycle Bin
echo.
echo   A Preferences backup is created before any change.
echo.
set /p GO="Type y and press Enter to continue: "
if /i "%GO%"=="y" goto :run
echo.
echo Cancelled. Nothing was changed.
echo.
pause
exit /b 0

:nopython
echo [ERROR] Python not found. Run emergency-fix.py manually.
echo.
pause
exit /b 1

:run
echo.
"%PYEXE%" "%~dp0emergency-fix.py"
echo.
pause
exit /b 0
