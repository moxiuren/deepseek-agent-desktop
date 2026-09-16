@echo off
chcp 65001 >nul
title DeepSeek Agent One-Click Installer
echo ============================================================
echo   DeepSeek Agent - One-Click Installer
echo   No admin needed. It will fetch the latest installer
echo   and set everything up automatically.
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/moxiuren/deepseek-agent-desktop/main/windows/installer/install.ps1 | iex"
echo.
echo [DONE] Installation finished (see messages above for details).
echo You may close this window. Press any key to exit...
pause >nul
