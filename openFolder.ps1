# 打开文件夹并把窗口强制切到前台（供管理器调用）
param([string]$folder, [switch]$Minimize, [string]$Select)

if (-not $folder) { exit 1 }
if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }

$leaf = Split-Path $folder -Leaf
$shell = New-Object -ComObject Shell.Application

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
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
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
}
"@

# 只最小化「别的」窗口（通常是全屏游戏），不要把管理器自己收起来
function Minimize-Others {
    $keep = @('潜渊症', 'Mod 管理', 'Mod')
    $cb = [ActivateWin+EnumWindowsProc]{
        param([IntPtr]$h, [IntPtr]$l)
        if ([ActivateWin]::IsWindowVisible($h)) {
            $sb = New-Object System.Text.StringBuilder 256
            [void][ActivateWin]::GetWindowText($h, $sb, 256)
            $t = $sb.ToString()
            if ($t) {
                $mine = $false
                foreach ($k in $keep) { if ($t -like ('*' + $k + '*')) { $mine = $true; break } }
                if (-not $mine) { [void][ActivateWin]::ShowWindow($h, 6) }   # SW_MINIMIZE
            }
        }
        return $true
    }
    [void][ActivateWin]::EnumWindows($cb, [IntPtr]::Zero)
}

function ActivateWindow([IntPtr]$hwnd) {
    $TOPMOST = [IntPtr](-1)
    $NOTOPMOST = [IntPtr](-2)
    $SWP = 0x0001 -bor 0x0002 -bor 0x0040

    [void][ActivateWin]::ShowWindow($hwnd, 9)
    [void][ActivateWin]::SetWindowPos($hwnd, $TOPMOST, 0, 0, 0, 0, $SWP)

    $fg = [ActivateWin]::GetForegroundWindow()
    $curThread = [ActivateWin]::GetCurrentThreadId()
    $fgThread = [ActivateWin]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    if ($fgThread -ne $curThread) { [void][ActivateWin]::AttachThreadInput($curThread, $fgThread, $true) }
    [void][ActivateWin]::BringWindowToTop($hwnd)
    [void][ActivateWin]::SetActiveWindow($hwnd)
    $ok = [ActivateWin]::SetForegroundWindow($hwnd)
    if ($fgThread -ne $curThread) { [void][ActivateWin]::AttachThreadInput($curThread, $fgThread, $false) }

    Start-Sleep -Milliseconds 400
    [void][ActivateWin]::SetWindowPos($hwnd, $NOTOPMOST, 0, 0, 0, 0, $SWP)
    [void][ActivateWin]::SetForegroundWindow($hwnd)
    return $ok
}

# 全屏游戏会锁住前台，任何程序都抢不过它；此时先把别的窗口收起来，再打开文件夹
if ($Minimize) { Minimize-Others; Start-Sleep -Milliseconds 400 }
$shell.Open($folder)

# 只想选中某个文件（比如刚导出的 zip）：打开所在文件夹并选中它
if ($Select) {
    if (-not (Test-Path $Select)) { $Select = $null }
    else {
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"' + $Select + '"')
        Start-Sleep -Milliseconds 600
    }
}
if ($Select) { exit 0 }

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
