$root = $PSScriptRoot
$dist = Join-Path $root 'dist\潜渊症Mod管理器'

# 重打包前保留运行时用户数据（手动译文 / 翻译缓存 / 版本基线），打包完成后还原
$userData = @('user_zh.json', 'translations.json', 'versions.json')
$keep = @{}
foreach ($f in $userData) {
    $p = Join-Path $dist $f
    if (Test-Path $p) { $keep[$f] = [System.IO.File]::ReadAllBytes($p) }
}

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist -Force | Out-Null

# Node 运行时：优先用项目目录里的 node.exe，其次用系统 PATH 里的 node
$nodeSrc = Join-Path $root 'node.exe'
if (!(Test-Path $nodeSrc)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeSrc = $cmd.Source }
}
if (!(Test-Path $nodeSrc)) {
    Write-Host 'node.exe not found: install Node.js, or put node.exe in this folder.'
    exit 1
}
Copy-Item $nodeSrc (Join-Path $dist 'node.exe') -Force

foreach ($f in @('server.js', 'ui.html', 'sort.js', 'zh.json', 'fetch_meta.js', 'app.png', 'app.ico', '潜渊症Mod管理器.vbs')) {
    $p = Join-Path $root $f
    if (Test-Path $p) { Copy-Item $p (Join-Path $dist $f) -Force }
}
# 还原用户数据（分享给别人前可自行删除这几个文件）
foreach ($f in $keep.Keys) {
    [System.IO.File]::WriteAllBytes((Join-Path $dist $f), $keep[$f])
}

function W($name, $text) {
    [System.IO.File]::WriteAllText((Join-Path $dist $name), $text, (New-Object System.Text.UTF8Encoding($false)))
}

$tLaunch = @'
@echo off
cd /d "%~dp0"
"%~dp0node.exe" "%~dp0server.js"
'@
W '启动.bat' $tLaunch

$tInstall = @'
$src = $PSScriptRoot
$dst = Join-Path $env:LOCALAPPDATA '潜渊症Mod管理器'
if (!(Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
Get-ChildItem $src | Copy-Item -Destination $dst -Recurse -Force
$ico = Join-Path $dst 'app.ico'
$ws = New-Object -ComObject WScript.Shell
foreach ($loc in @('Desktop', 'StartMenu')) {
    $dir = [Environment]::GetFolderPath($loc)
    if ($loc -eq 'StartMenu') { $dir = Join-Path $dir 'Programs' }
    $lnk = $ws.CreateShortcut((Join-Path $dir '潜渊症Mod管理器.lnk'))
    $lnk.TargetPath = (Join-Path $dst '潜渊症Mod管理器.vbs')
    $lnk.WorkingDirectory = $dst
    if (Test-Path $ico) { $lnk.IconLocation = $ico }
    $lnk.Description = '潜渊症 Mod 管理器'
    $lnk.Save()
}
Write-Host "已安装到 $dst"
Write-Host "桌面与开始菜单快捷方式已创建"
'@
W '安装.ps1' $tInstall

$tBat = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装.ps1"
pause
'@
W '安装.bat' $tBat

$tReadme = @'
潜渊症 Mod 管理器（绿色版）
================================

【怎么用】
双击「潜渊症Mod管理器.vbs」即可 —— 会弹出一个独立程序窗口
（无地址栏、无标签页，任务栏独立图标）。完全没有安装过程。
退出请点界面右上角的「退出」按钮，会连同后台服务一起干净关闭。

【想看日志 / 排查问题】
双击「启动.bat」：保留黑色命令行窗口，里面能看到路径探测结果。

【导出 / 导入 mod】
点「导出mod文件」：把当前已启用的 mod（含加载顺序）复制到本目录下的
exported_mods 文件夹，压缩后发给朋友即可；对方点「导入mod文件」选中
该文件夹，就会自动复制回他的创意工坊并按原顺序启用。

【换电脑能用吗】
能。会自动从 Steam 注册表 + Steam 库配置探测游戏与创意工坊目录，
并从系统 LOCALAPPDATA 推断已安装 mod 目录，无需改代码。

【万一没找到游戏（换盘 / 非标准位置）】
可用环境变量手动指定，例如新建 bat 内容如下：
  set BARO_GAME=D:\Steam\steamapps\common\Barotrauma
  set BARO_WORKSHOP=D:\Steam\steamapps\workshop\content\602960
  set BARO_INSTALLED=%LOCALAPPDATA%\Daedalic Entertainment GmbH\Barotrauma\WorkshopMods\Installed
  "%~dp0node.exe" "%~dp0server.js"

【固定到桌面 / 开始菜单（可选，仍不是安装）】
双击「安装.bat」：复制文件并创建快捷方式。不需要卸载，删掉文件夹即可。

【要求】
64 位 Windows；已安装并至少运行过一次 Steam 版《潜渊症》。
窗口显示依赖 Edge 或 Chrome（Windows 10/11 自带 Edge）。
'@
W '使用说明.txt' $tReadme

Get-ChildItem $dist | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } } | Format-Table -Auto | Out-String | Write-Host
$tot = (Get-ChildItem $dist -Recurse | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("打包完成 -> " + $dist)
Write-Host ("总体积: " + [math]::Round($tot, 1) + " MB")
