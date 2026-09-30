@echo off
taskkill /FI "WINDOWTITLE eq BaroModSrv" /IM node.exe
if errorlevel 1 (
    echo 未找到运行中的管理器服务。
) else (
    echo 已停止管理器服务。
)
pause
