# Lists electron/Streamify processes with pid, name and start time.
Add-Type -AssemblyName System.Windows.Forms
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -match 'electron|Streamify' } |
  Select-Object Id, ProcessName, StartTime, MainWindowTitle |
  Format-Table -AutoSize | Out-String -Width 160 | Write-Output
