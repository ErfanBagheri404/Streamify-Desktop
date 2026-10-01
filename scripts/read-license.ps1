$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class L {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
}
"@
$script:top = [IntPtr]::Zero
$cbT = [L+EnumProc]{ param($h,$p)
  $sb = New-Object System.Text.StringBuilder 256
  [void][L]::GetWindowText($h,$sb,256)
  if ($sb.ToString() -match "Streamify Desktop") { $script:top = $h }
  return $true
}
[void][L]::EnumWindows($cbT,[IntPtr]::Zero)
if ($script:top -eq [IntPtr]::Zero) { Write-Output "no window"; exit 1 }
$script:best = ""
$cbC = [L+EnumProc]{ param($h,$p)
  $sb = New-Object System.Text.StringBuilder 4096
  [void][L]::GetWindowText($h,$sb,4096)
  $t = $sb.ToString()
  if ($t.Length -gt $script:best.Length) { $script:best = $t }
  return $true
}
[void][L]::EnumChildWindows($script:top,$cbC,[IntPtr]::Zero)
$script:best.Substring(0, [Math]::Min(700, $script:best.Length))
