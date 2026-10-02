@echo off
chcp 65001 >nul
title 潜渊症 Mod 管理
cd /d "%~dp0"

REM 统一走「打开管理器.bat」，保证只有一个服务实例（避免多端口 / 翻译“看起来丢失”）
call "打开管理器.bat"
echo.
echo   服务已退出。
pause >nul
