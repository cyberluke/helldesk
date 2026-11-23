# HELLDESK Local — install persistent Windows daemon (proper back-end).
# Registers a user-level Windows Scheduled Task that starts the control plane
# at logon and keeps it running INDEPENDENTLY of any VS Code window lifecycle
# and WITHOUT ever allocating a console window. The task launches the daemon
# through a zero-window VBS -> hidden PowerShell chain, so on no desktop does a
# cmd/console window appear. All output is redirected to daemon.log.
#
# This runs in the user's interactive session (so it can reach the user-scoped
# Kilo gateway/config and CLI) but is completely headless: SW_HIDE window
# style 0 throughout the launch chain, nothing flashes at logon or on restart.
#
# Run: powershell -ExecutionPolicy Bypass -File scripts\install-daemon.ps1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

$taskName = "HellDeskControlPlane"
$cfg = Join-Path $root "config.json"
if (-not (Test-Path $cfg)) {
    Copy-Item (Join-Path $root "config.example.json") $cfg
    Write-Host "[install] No config.json found; created from config.example.json." -ForegroundColor Yellow
}

# Resolve the current user (env may be empty in non-interactive contexts like CI).
$userName = $env:USERNAME
if (-not $userName) { $userName = (whoami) -replace '^\w+\\', '' }

# Zero-window launch chain: wscript -> daemon-hidden.ps1 (SW_HIDE) -> bun (hidden).
# Task Scheduler only ever briefly starts wscript.exe, which never shows a window.
$vbs = Join-Path $here "launch-daemon-task.vbs"
$action = New-ScheduledTaskAction -Execute "$env:windir\System32\wscript.exe" -Argument "`"$vbs`" `"$cfg`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited

# Schedule (idempotent: upsert).
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "[install] Replaced existing task $taskName." -ForegroundColor Yellow
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "HELLDESK Local persistent control plane (headless service, no console window)" | Out-Null
Write-Host "[install] Registered headless scheduled service '$taskName' (logon start, auto-restart, zero-window)." -ForegroundColor Green

# Start it now so the daemon is available immediately.
Start-ScheduledTask -TaskName $taskName
Write-Host "[install] Started '$taskName'."

# Wait a moment and probe /health.
Start-Sleep -Milliseconds 1500
$port = (Get-Content $cfg | ConvertFrom-Json).daemon.port
try {
    $h = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 5
    Write-Host "[install] Daemon healthy: $($h | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Host "[install] Task started but /health not yet ready: $($_.Exception.Message)" -ForegroundColor Yellow
}