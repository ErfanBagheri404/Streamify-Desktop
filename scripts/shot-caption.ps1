param([int]$TargetPid = 0, [int]$Width = 360, [int]$Height = 44, [string]$Out = "")
# Captures the caption-button strip from the real screen. PrintWindow cannot see
# DWM-drawn caption glyphs, and SetForegroundWindow is refused by the foreground
# lock, so the window is raised with a temporary HWND_TOPMOST and dropped straight
# back to HWND_NOTOPMOST — no other window's state is touched.
#
# The window is found by pid, not by title: Get-Process MainWindowHandle
# returned a different 1900x1080 window with the same title.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class CAP {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumProc(IntPtr h, IntPtr lParam);
  public struct RECT { public int Left, Top, Right, Bottom; }

  // Largest visible window of the target pid — the player, not a tooltip.
  public static IntPtr Biggest(uint target) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
[void][CAP]::SetProcessDPIAware()

if (-not $TargetPid) { Write-Output "pass -TargetPid (the electron main pid)"; exit 1 }
$h = [CAP]::Biggest([uint32]$TargetPid)
if ($h -eq [IntPtr]::Zero) { Write-Output ("no visible window for pid " + $TargetPid); exit 1 }

$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$FLAGS = 0x0002 -bor 0x0001 -bor 0x0010   # NOMOVE | NOSIZE | NOACTIVATE

[void][CAP]::ShowWindow($h, 9)
[void][CAP]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $FLAGS)
Start-Sleep -Milliseconds 900

$r = New-Object CAP+RECT
[void][CAP]::GetWindowRect($h, [ref]$r)
# GetWindowRect is in physical pixels while the window is DPI-scaled, so the
# reported size can exceed the real client size. Grab the whole window and crop
# the caption strip from the bitmap instead of trusting the rect.
$winW = $r.Right - $r.Left
$winH = $r.Bottom - $r.Top
$grabW = [Math]::Min($winW, 1920)
$grabH = [Math]::Min($winH, 200)
if (-not $Out) { $Out = "E:/Dev/Projects/Streamify-Desktop/.logs/caption-" + (Get-Date -Format "HHmmss") + ".png" }

$full = New-Object System.Drawing.Bitmap $grabW, $grabH
$gf = [System.Drawing.Graphics]::FromImage($full)
$gf.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $grabW, $grabH))
$gf.Dispose()

# Caption strip: top $Height px, rightmost $Width px of the window.
$cropX = [Math]::Max(0, $grabW - $Width)
$cropW = [Math]::Min($Width, $grabW)
$bmp = $full.Clone((New-Object System.Drawing.Rectangle $cropX, 0, $cropW, $Height), $full.PixelFormat)
$full.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

[void][CAP]::SetWindowPos($h, $HWND_NOTOPMOST, 0, 0, 0, 0, $FLAGS)
Write-Output ("saved " + $Out + " handle=" + $h + " window=" + $r.Left + "," + $r.Top + " " + ($r.Right - $r.Left) + "x" + ($r.Bottom - $r.Top) + " region=" + $x + "," + $r.Top)
