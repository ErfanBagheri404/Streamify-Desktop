# Lists Electron windows with handles, then captures the first one with
# PrintWindow. Used to verify the in-window overlay title bar.
param([int]$Height = 220, [string]$Out = "")
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PW2 {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1

if (-not $proc) {
  Write-Output "no electron window with a handle"
  Get-Process electron -ErrorAction SilentlyContinue | Select-Object Id, MainWindowTitle | Format-Table -AutoSize | Out-String | Write-Output
  exit 1
}

Write-Output ("title=[" + $proc.MainWindowTitle + "] pid=" + $proc.Id)

if (-not $Out) { $Out = "E:/Dev/Projects/Streamify-Desktop/.logs/overlay-" + (Get-Date -Format "HHmmss") + ".png" }
$h = $proc.MainWindowHandle
[void][PW2]::ShowWindow($h, 9)
Start-Sleep -Milliseconds 600
$r = New-Object PW2+RECT
[void][PW2]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $w, $Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [PW2]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("PrintWindow=" + $ok + " saved " + $Out + " " + $w + "x" + $Height)
