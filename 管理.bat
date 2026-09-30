@echo off
chcp 65001 >nul
title 潜渊症 Mod 管理
cd /d "%~dp0"

echo.
echo   正在启动 Mod 管理服务...
echo   启动后浏览器打开控制台里显示的地址
echo   关闭此窗口即停止服务
echo.

D:\Node\node.exe server.js

echo.
echo   服务已退出。
pause
