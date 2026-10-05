@echo off
chcp 65001 >nul
title 潜渊症 Mod 排序助手
cd /d "%~dp0"

echo.
echo   正在扫描 Mod...
echo.

D:\Node\node.exe sort.js

echo.
echo   已生成 report.html，正在打开...
start "" "%~dp0report.html"

echo.
echo   按任意键退出...
pause >nul
