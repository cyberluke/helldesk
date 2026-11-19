# CyberLuke Local HELLDESK - install persistent Windows scheduled service for the
# dashboard (:8790 local-live UI). Registers a user-level Scheduled Task that
# starts the dashboard at logon and keeps it running INDEPENDENTLY of any VS Code
# / Kilo window lifecycle and WITHOUT a console window (VBS -> hidden PS -> bun).
# Same durability contract as the control plane's install-daemon.ps1.
#
# Run: powershell -ExecutionPolicy Bypass -File scripts\install-dashboard-daemon.ps1
$ErrorActionPreference = "Stop"
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path   # local-live/scripts
$root    = Split-Path -Parent $here                          # local-live
$taskName = "CyberLukeLocalHelldeskDashboard"
$userName = $env:USERNAME
if (-not $userName) { $userName = (whoami) -replace '^\w+\\', '' }

$vbs = Join-Path $here "launch-dashboard-task.vbs"
$action = New-ScheduledTaskAction -Execute "$env:windir\System32\wscript.exe" -Argument "`"$vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "[install] Replaced existing task $taskName." -ForegroundColor Yellow
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "CyberLuke Local HELLDESK dashboard (local-live UI :8790) - persistent headless service" | Out-Null
Write-Host "[install] Registered headless scheduled service '$taskName' (logon start, auto-restart, zero-window)." -ForegroundColor Green

Start-ScheduledTask -TaskName $taskName
Write-Host "[install] Started '$taskName'."

Start-Sleep -Milliseconds 2500
try {
    $h = Invoke-WebRequest -Uri 'http://127.0.0.1:8790/helldesk/' -UseBasicParsing -TimeoutSec 6
    Write-Host "[install] Dashboard healthy: $($h.StatusCode)" -ForegroundColor Green
} catch {
    Write-Host "[install] Task started but /helldesk not yet ready: $($_.Exception.Message)" -ForegroundColor Yellow
}