# 打开文件夹并把窗口强制切到前台（供管理器调用）
param([string]$folder, [switch]$Minimize)

if (-not $folder) { exit 1 }
if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }

$leaf = Split-Path $folder -Leaf
$shell = New-Object -ComObject Shell.Application

# 全屏游戏/独占画面会锁住前台，任何程序都抢不过它；此时先把所有窗口最小化，再打开
if ($Minimize) { $shell.MinimizeAll(); Start-Sleep -Milliseconds 400 }
$shell.Open($folder)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ActivateWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
}
"@

function ActivateWindow([IntPtr]$hwnd) {
    $TOPMOST = [IntPtr](-1)
    $NOTOPMOST = [IntPtr](-2)
    $SWP = 0x0001 -bor 0x0002 -bor 0x0040   # NOSIZE | NOMOVE | SHOWWINDOW

    [void][ActivateWin]::ShowWindow($hwnd, 9)
    [void][ActivateWin]::SetWindowPos($hwnd, $TOPMOST, 0, 0, 0, 0, $SWP)   # 临时置顶，压过正在覆盖屏幕的游戏画面

    $fg = [ActivateWin]::GetForegroundWindow()
    $curThread = [ActivateWin]::GetCurrentThreadId()
    $fgThread = [ActivateWin]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    if ($fgThread -ne $curThread) { [void][ActivateWin]::AttachThreadInput($curThread, $fgThread, $true) }
    [void][ActivateWin]::BringWindowToTop($hwnd)
    [void][ActivateWin]::SetActiveWindow($hwnd)
    $ok = [ActivateWin]::SetForegroundWindow($hwnd)
    if ($fgThread -ne $curThread) { [void][ActivateWin]::AttachThreadInput($curThread, $fgThread, $false) }

    Start-Sleep -Milliseconds 400
    [void][ActivateWin]::SetWindowPos($hwnd, $NOTOPMOST, 0, 0, 0, 0, $SWP)  # 取消置顶，恢复正常层级
    [void][ActivateWin]::SetForegroundWindow($hwnd)
    return $ok
}

$needle = $folder.ToLower()
$target = $null
for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 200
    foreach ($w in $shell.Windows()) {
        try {
            $u = $w.LocationURL
            if (-not $u) { continue }
            $p = [Uri]::UnescapeDataString(([Uri]$u).AbsolutePath).TrimEnd('/').ToLower()
            if ($p -and $needle.StartsWith($p)) { $target = $w; break }
        } catch { }
    }
    if ($target) { break }
}

if ($target) {
    [void](ActivateWindow ([IntPtr]$target.HWND))
    Start-Sleep -Milliseconds 300
    [void](ActivateWindow ([IntPtr]$target.HWND))
} else {
    $ws = New-Object -ComObject WScript.Shell
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 200
        if ($ws.AppActivate($leaf)) { break }
    }
}
