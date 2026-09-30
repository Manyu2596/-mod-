# Generate custom app icon: Barotrauma icon + gear badge at bottom-right
Add-Type -AssemblyName System.Drawing

$exe = 'D:\Steam\steamapps\common\Barotrauma\Barotrauma.exe'
$root = 'D:\BarotraumaModSorter'
$pngOut = Join-Path $root 'app.png'
$icoOut = Join-Path $root 'app.ico'

# 1) Load game icon, prefer high resolution via Win32 PrivateExtractIcons
$srcIcon = $null
try {
    Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class IconExtract {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern int PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] phicon, IntPtr[] piconid, int nIcons, int flags);
    public static Icon Get(string file, int size) {
        IntPtr[] ph = new IntPtr[1];
        IntPtr[] pid = new IntPtr[1];
        int n = PrivateExtractIcons(file, 0, size, size, ph, pid, 1, 0);
        if (n > 0 && ph[0] != IntPtr.Zero) {
            Icon ic = Icon.FromHandle(ph[0]);
            return (Icon)ic.Clone();
        }
        return null;
    }
}
'@ -ReferencedAssemblies System.Drawing

    foreach ($s in @(256, 128, 64, 48)) {
        $ic = [IconExtract]::Get($exe, $s)
        if ($null -ne $ic -and $ic.Width -ge $s) {
            $srcIcon = $ic
            Write-Host ("Win32 extracted: " + $ic.Width + "x" + $ic.Height)
            break
        }
    }
} catch {
    Write-Host ("Win32 extraction unavailable: " + $_.Exception.Message)
}

if (-not $srcIcon) {
    foreach ($s in @(256, 128, 64, 48, 32)) {
        try { $srcIcon = New-Object System.Drawing.Icon($exe, $s, $s); break } catch { $srcIcon = $null }
    }
    if (-not $srcIcon) { $srcIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe) }
}
Write-Host ("source icon size: " + $srcIcon.Width + "x" + $srcIcon.Height)

$bmp = New-Object System.Drawing.Bitmap(256, 256)
$g0 = [System.Drawing.Graphics]::FromImage($bmp)
$g0.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g0.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g0.DrawImage($srcIcon.ToBitmap(), 0, 0, 256, 256)
$g0.Dispose()

# 2) Draw a gear (cog) badge at bottom-right
function Draw-Gear($g, $cx, $cy, $r) {
    $dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 28, 40))
    $body = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 125, 211, 252))

    foreach ($pass in @('out', 'in')) {
        if ($pass -eq 'out') { $brush = $dark; $k = 1.16 } else { $brush = $body; $k = 1.0 }
        $rr = $r * $k
        for ($i = 0; $i -lt 8; $i++) {
            $st = $g.Save()
            $g.TranslateTransform($cx, $cy)
            $g.RotateTransform((360.0 / 8.0) * $i)
            $w = $rr * 0.34
            $h = $rr * 0.44
            $g.FillRectangle($brush, -$w / 2, -$rr - $h * 0.55, $w, $h)
            $g.Restore($st)
        }
        $g.FillEllipse($brush, $cx - $rr * 0.90, $cy - $rr * 0.90, $rr * 1.80, $rr * 1.80)
    }

    # punch transparent center hole
    $prev = $g.CompositingMode
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $clear = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    $g.FillEllipse($clear, $cx - $r * 0.40, $cy - $r * 0.40, $r * 0.80, $r * 0.80)
    $g.CompositingMode = $prev
}

$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
Draw-Gear $g 190 190 46
$g.Dispose()

$bmp.Save($pngOut, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host ("saved png: " + $pngOut)

# 3) Build a multi-size .ico (PNG-compressed entries for modern Windows)
$sizes = @(16, 32, 48, 64, 128, 256)
$entries = New-Object System.Collections.ArrayList
foreach ($s in $sizes) {
    $sb = New-Object System.Drawing.Bitmap($s, $s)
    $sg = [System.Drawing.Graphics]::FromImage($sb)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $sg.DrawImage($bmp, 0, 0, $s, $s)
    $sg.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $sb.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [void]$entries.Add(@($s, $ms.ToArray()))
    $sb.Dispose()
    $ms.Dispose()
}

$fs = [System.IO.File]::Open($icoOut, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $s = $e[0]
    $data = $e[1]
    $dim = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length)
    $bw.Write([uint32]$offset)
    $offset += $data.Length
}
foreach ($e in $entries) { $bw.Write($e[1]) }
$bw.Close()
$fs.Close()
Write-Host ("saved ico: " + $icoOut)
Write-Host ("ico size: " + [math]::Round((Get-Item $icoOut).Length / 1KB, 1) + " KB")
