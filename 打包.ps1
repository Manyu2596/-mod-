$root = $PSScriptRoot
$dist = Join-Path $root 'dist\潜渊症Mod管理器'

# ---------- 0. 先确认 node.exe 在哪儿 ----------
# 必须「先找到再删 dist」：以前是先把 dist 删了才找 node.exe，找不到就 exit 1，
# 结果 dist 已经空了、后面的数据还原也不会执行 → 用户数据全丢（存档备份/回滚历史/方案存档）
$nodeSrc = Join-Path $root 'node.exe'
if (!(Test-Path $nodeSrc) -and $env:BARO_NODE) { $nodeSrc = $env:BARO_NODE }
if (!(Test-Path $nodeSrc)) { $nodeSrc = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (!(Test-Path $nodeSrc)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeSrc = $cmd.Source }
}
if (!(Test-Path $nodeSrc)) {
    Write-Host 'node.exe not found: install Node.js, or put node.exe in this folder.'
    Write-Host '（或者先设置环境变量 BARO_NODE 指向 node.exe，例：$env:BARO_NODE="D:\Node\node.exe"）'
    Write-Host 'dist 未做任何改动，你的数据都在。'
    exit 1
}

# ---------- 1. 备份用户数据（数据在软件目录里，重建 dist 会连它一起删，必须先备份） ----------
# 存档备份 / mod 方案存档 / 配置回滚历史 / 译文 / 版本基线 都存在 <软件目录>\数据
# （server.js 的 DATA_DIR）。所以这里整份备份，重建完再原样放回去 —— 升级不会丢数据。
$keepRoot = Join-Path $env:TEMP 'BaroDistDataBackup'
if (Test-Path $keepRoot) { Remove-Item $keepRoot -Recurse -Force }
New-Item -ItemType Directory -Path $keepRoot -Force | Out-Null

$dataDir = Join-Path $dist '数据'
if (Test-Path $dataDir) {
    Copy-Item $dataDir (Join-Path $keepRoot '数据') -Recurse -Force
    Write-Host "backup: 数据"
}
# 老版本把数据直接摊在程序目录根上，也一并兜底备份
$userData = @('user_zh.json', 'translations.json', 'versions.json', 'share.json', 'modsize.json')
$keep = @{}
foreach ($f in $userData) {
    $p = Join-Path $dist $f
    if (Test-Path $p) { $keep[$f] = [System.IO.File]::ReadAllBytes($p) }
}
$userDirs = @('presets', 'savebackups', 'confighistory', 'exported_mods', '导出的mod')
foreach ($d in $userDirs) {
    $p = Join-Path $dist $d
    if (Test-Path $p) { Copy-Item $p (Join-Path $keepRoot $d) -Recurse -Force; Write-Host ("backup dir: " + $d) }
}

# ---------- 2. 停服务、重建 dist ----------
# 先停掉正在跑的实例，否则 node.exe 被占用删不掉
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + (Join-Path $dist 'server.js') + '*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist -Force | Out-Null

Copy-Item $nodeSrc (Join-Path $dist 'node.exe') -Force

foreach ($f in @('server.js', 'ui.html', 'sort.js', 'zh.json', 'fetch_meta.js', 'app.png', 'app.ico', 'openFolder.ps1', '潜渊症Mod管理器.vbs')) {
    $p = Join-Path $root $f
    if (Test-Path $p) { Copy-Item $p (Join-Path $dist $f) -Force }
}
# ---------- 3. 把用户数据放回去 ----------
$backData = Join-Path $keepRoot '数据'
if (Test-Path $backData) {
    Copy-Item $backData (Join-Path $dist '数据') -Recurse -Force
    Write-Host "restored: 数据"
}
foreach ($f in $keep.Keys) {
    [System.IO.File]::WriteAllBytes((Join-Path $dist $f), $keep[$f])
}
foreach ($d in $userDirs) {
    $p = Join-Path $keepRoot $d
    if (Test-Path $p) { Copy-Item $p (Join-Path $dist $d) -Recurse -Force; Write-Host ("restored dir: " + $d) }
}
Write-Host "user data restored from $keepRoot"

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
导出的文件夹里还有 subscribe.html，朋友双击就能逐个在 Steam 里订阅，
不用拷大文件。

【mod 方案存档（一个存档一套 mod）】
点工具栏「mod方案存档」：
  1) 填个名字（如 单人战役）→ 点「保存当前启用」
  2) 换一批 mod → 再存一个（如 联机车队）
  3) 以后点对应方案右边的「应用」，整份启用列表瞬间切回并写入游戏
方案存在本目录的 presets 文件夹里，可以自己备份。

【一键打开文件夹】
点「打开文件夹」直接弹出导出目录（不用先去配置路径）。

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
