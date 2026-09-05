@echo off
chcp 65001 >nul 2>&1
title Live2D Agent v2
cd /d "%~dp0"
echo.
echo   ============================================
echo     Live2D Agent v2 - Bun + TypeScript
echo   ============================================
echo.

rem Set default port
if "%PORT%"=="" set "PORT=8310"

rem Override port via argument: start.bat 9000
if not "%~1"=="" set "PORT=%~1"

echo   Port: %PORT%
echo.

rem 1) Check for Bun
where bun >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   [1/2] Building client...
    bun run src/build.ts
    if %ERRORLEVEL% NEQ 0 (
        echo   [!] Build failed, using legacy static/js/app.js
    ) else (
        echo   [OK] Build to static/js/bundle.js
    )
    echo.
    echo   [2/2] Starting server on http://127.0.0.1:%PORT%
    echo         Press Ctrl+C to stop
    echo.
    rem UI: shell Tauri bila sudah dibangun, kalau tidak browser default.
    rem Shell menunggu server bind (maks 15 dtk) — aman dinyalakan sekarang.
    if exist "agent-shell\target\release\live2d-shell.exe" (
        start "" "%~dp0agent-shell\target\release\live2d-shell.exe" main "http://127.0.0.1:%PORT%/"
    ) else (
        echo   [i] Shell Tauri belum dibangun - buka di browser. Bangun dengan: bun run build:pet
        start "" "http://127.0.0.1:%PORT%"
    )
    bun run src/server/index.ts
    goto :end
)

rem 2) Bun not found
echo   [!] ERROR: Bun is not installed.
echo.
echo   Install Bun:
echo     powershell -c "irm bun.sh/install.ps1 | iex"
echo.
echo   Then restart this script.

:end
