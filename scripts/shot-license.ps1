param([string]$Out = "E:/Dev/Projects/Streamify-Desktop/.logs/license.png")
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LP {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
}
"@
$script:top = [IntPtr]::Zero
$cb = [LP+EnumProc]{ param($h,$p)
  $sb = New-Object System.Text.StringBuilder 256
  [void][LP]::GetWindowText($h,$sb,256)
  if ($sb.ToString() -match "Streamify Desktop") { $script:top = $h }
  return $true
}
[void][LP]::EnumWindows($cb,[IntPtr]::Zero)
if ($script:top -eq [IntPtr]::Zero) { Write-Output "no window"; exit 1 }
$r = New-Object LP+RECT
[void][LP]::GetWindowRect($script:top, [ref]$r)
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][LP]::PrintWindow($script:top, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("saved " + $Out + " " + $w + "x" + $h)
