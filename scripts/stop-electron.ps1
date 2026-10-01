param()
# Stops every electron process. The Next child keeps app/.next/standalone
# locked, which makes `next build` fail with EBUSY.
Add-Type -AssemblyName System.Windows.Forms
$procs = Get-Process electron -ErrorAction SilentlyContinue
if ($procs) {
  $procs | Stop-Process -Force
  Start-Sleep -Seconds 2
  Write-Output ("stopped " + $procs.Count + " electron process(es)")
} else {
  Write-Output "no electron processes"
}