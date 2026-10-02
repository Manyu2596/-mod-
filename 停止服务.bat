@echo off
setlocal
chcp 65001 >nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'server\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('已停止 pid ' + $_.ProcessId) }"
if exist "D:\BarotraumaModSorter\server.port" del /f "D:\BarotraumaModSorter\server.port" >nul 2>&1
echo 已尝试停止管理器服务。
pause
