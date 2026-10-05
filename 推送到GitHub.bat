@echo off
chcp 65001 >nul
cd /d "%~dp0github_upload"

echo.
echo === Push to GitHub ===
echo Repo : https://github.com/Manyu2596/-mod-.git
echo.
echo Username: Manyu2596
echo Password: paste your Personal Access Token (NOT your account password)
echo          (create at GitHub - Settings - Developer settings - Personal access tokens)
echo.

"D:\Git\cmd\git.exe" push -u origin main

echo.
echo === Done (see message above) ===
pause
