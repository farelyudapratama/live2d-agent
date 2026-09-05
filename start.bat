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
if %ERRORLEVEL% NEQ 0 goto :nobun

echo   [1/2] Building client...
bun run src/build.ts
if %ERRORLEVEL% NEQ 0 (
    echo   [!] Build failed, using legacy static/js/app.js
) else (
    echo   [OK] Build to static/js/bundle.js
)
echo.

rem Server kembar: kalau port sudah dipakai (start.bat dobel / instance lama
rem masih hidup), jangan nyalakan server lagi — cukup buka jendelanya.
netstat -ano | findstr /c:"127.0.0.1:%PORT%" | findstr /c:"LISTENING" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   [i] Server sudah jalan di port %PORT% - membuka jendela saja.
    goto :open
)

echo   [2/2] Starting server on http://127.0.0.1:%PORT%
echo         Press Ctrl+C to stop
echo.
rem UI: shell Tauri bila sudah dibangun, kalau tidak browser default.
rem Shell menunggu server bind (maks 15 dtk) dan me-reload sendiri begitu
rem server naik — aman dinyalakan sebelum server siap.
if exist "agent-shell\target\release\live2d-shell.exe" (
    start "" "%~dp0agent-shell\target\release\live2d-shell.exe" main "http://127.0.0.1:%PORT%/"
) else (
    echo   [i] Shell Tauri belum dibangun - buka di browser. Bangun dengan: bun run build:pet
    start "" "http://127.0.0.1:%PORT%"
)
bun run src/server/index.ts
goto :end

:open
rem Server sudah jalan (jalur atas) — buka jendela tanpa menyalakan server.
if exist "agent-shell\target\release\live2d-shell.exe" (
    start "" "%~dp0agent-shell\target\release\live2d-shell.exe" main "http://127.0.0.1:%PORT%/"
) else (
    start "" "http://127.0.0.1:%PORT%"
)
goto :end

:nobun
echo   [!] ERROR: Bun is not installed.
echo.
echo   Install Bun:
echo     powershell -c "irm bun.sh/install.ps1 | iex"
echo.
echo   Then restart this script.

:end
