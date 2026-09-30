@echo off
chcp 65001 >nul
title Fix Chrome Download Prompt
setlocal
set "PYEXE="

if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PYEXE=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not defined PYEXE if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PYEXE where python >nul 2>nul && set "PYEXE=python"

if not defined PYEXE (
  echo [ERROR] Python not found.
  echo Please run fix-chrome-download-prompt.py manually with any Python 3.
  echo.
  pause
  exit /b 1
)

"%PYEXE%" "%~dp0fix-chrome-download-prompt.py"
echo.
pause
