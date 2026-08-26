@echo off
chcp 65001 >nul 2>&1
title 🎭 Live2D Agent — 神宫白子

cd /d "%~dp0"
echo.
echo   ╔═══════════════════════════════════════╗
echo   ║   🎭 Live2D Agent — 神宫白子          ║
echo   ║   Starting server...                  ║
echo   ╚═══════════════════════════════════════╝
echo.

:: Try Node.js first (best performance)
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   Using Node.js server
    node server.js
    goto :end
)

:: Fallback to Python 3
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   Using Python server
    python server.py
    goto :end
)

:: Fallback to py launcher
where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   Using Python (py launcher)
    py server.py
    goto :end
)

echo.
echo   ❌ Node.js atau Python tidak ditemukan!
echo   Install Node.js: https://nodejs.org
echo   Install Python:  https://python.org
echo.
pause
exit /b 1

:end
pause