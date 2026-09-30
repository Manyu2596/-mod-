@echo off
setlocal
set NODE=D:\Node\node.exe
set SRV=D:\BarotraumaModSorter\server.js
set PORT=9191
set BARO_PORT=%PORT%
if exist "D:\BarotraumaModSorter\server.port" del /f "D:\BarotraumaModSorter\server.port" >nul 2>&1
"%NODE%" "%SRV%"
