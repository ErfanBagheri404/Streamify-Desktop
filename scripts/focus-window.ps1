# Bring the Streamify window to the front. The app hides instead of quitting on
# close, so a minimized/background instance still owns its process but shows
# nothing until it is restored.
$target = Get-Process | Where-Object { $_.MainWindowTitle -eq 'Streamify Player' } | Select-Object -First 1
if (-not $target) { Write-Output 'no window'; exit 1 }

Add-Type -AssemblyName Microsoft.VisualBasic
$null = [Microsoft.VisualBasic.Interaction]::AppActivate($target.Id)
Start-Sleep -Milliseconds 400

# restore() clears minimize/maximize so AppActivate alone is enough when hidden
$null = $target.Refresh()
if ($target.MainWindowHandle -ne 0) {
  $sig = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
  Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
  $h = $target.MainWindowHandle
  [void][W]::ShowWindow($h, 9)   # SW_RESTORE
  [void][W]::SetForegroundWindow($h)
}
Write-Output "focused pid=$($target.Id)"