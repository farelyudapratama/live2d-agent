@echo off
chcp 65001 >nul 2>&1
title Live2D Agent v2
cd /d "%~dp0"
echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║  Live2D Agent v2  — Bun + TypeScript        ║
echo   ╚══════════════════════════════════════════════╝
echo.

:: 1) Bun (primary)
where bun >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   [1/3] Building client (Bun)...
    bun run src/build.ts
    if %ERRORLEVEL% NEQ 0 (
        echo   [!] Build gagal — lanjut pakai static/js/app.js legacy.
    ) else (
        echo   [OK] Build -> static/js/bundle.js
    )
    echo   [2/3] Starting Bun server (http://127.0.0.1:8310)...
    echo   Tekan Ctrl+C untuk stop. Buka browser manual ke URL di atas jika tidak auto-open.
    bun run src/server/index.ts
    goto :end
)

:: 2) Node fallback (v1 server.js ada di ../live2d-agent)
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   [!] Bun tidak ketemu, fallback ke Node (live2d-agent/server.js)...
    if exist "..\live2d-agent\server.js" (
        node "..\live2d-agent\server.js"
        goto :end
    )
)

:: 3) Python fallback
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   Fallback Python...
    python "..\live2d-agent\server.py"
    goto :end
)
where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    py "..\live2d-agent\server.py"
    goto :end
)

echo   [!] Bun / Node / Python tidak ditemukan.
echo   Install Bun: powershell -c "irm bun.sh/install.ps1 | iex"
echo   atau Node: https://nodejs.org
pause
exit /b 1

:end
pause
