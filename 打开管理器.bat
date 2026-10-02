@echo off
setlocal
cd /d "%~dp0"
set "SRV=%~dp0server.js"
set "PORTFILE=%~dp0server.port"
set "BARO_PORT=9191"

REM use bundled node.exe first, otherwise node from PATH
set "NODE="
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"
if not defined NODE (
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
)
if not defined NODE (
echo Node.js not found. Put node.exe here, or install Node.js first.
pause
exit /b 1
)

REM reuse the running instance when the port is already alive
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -Uri ""http://127.0.0.1:%BARO_PORT%/api/data"" -UseBasicParsing -TimeoutSec 2;if($r.StatusCode -eq 200){try{Start-Process ""http://127.0.0.1:%BARO_PORT%/""}catch{};exit 1}}catch{}"
if errorlevel 1 goto :eof

REM no instance running: clean leftovers, then start fresh
powershell -NoProfile -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match ""server\.js"" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
if exist "%PORTFILE%" del /f "%PORTFILE%" >nul 2>&1

%NODE% %SRV%