param([int]$Height = 140, [string]$Out = "")
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PW {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
if (-not $Out) { $Out = "E:/Dev/Projects/Streamify-Desktop/.logs/app-pw-" + (Get-Date -Format "HHmmss") + ".png" }
$p = Get-Process | Where-Object { $_.MainWindowTitle -eq "Streamify Player" } | Select-Object -First 1
if (-not $p) { Write-Output "app window not found"; exit 1 }
$h = $p.MainWindowHandle
# PrintWindow renders the window into our own DC, so no focus or z-order
# fight with whatever is in front of it (PW_RENDERFULLCONTENT = 2).
[void][PW]::ShowWindow($h, 9)
Start-Sleep -Milliseconds 500
$r = New-Object PW+RECT
[void][PW]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $w, $Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [PW]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("PrintWindow=" + $ok + " saved " + $Out + " " + $w + "x" + $Height)
