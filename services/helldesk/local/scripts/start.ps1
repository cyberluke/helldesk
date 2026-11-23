# HELLDESK Local — start (attach-or-launch persistent daemon)
# If a control plane is already listening on the configured port, this connects
# as a client (health check) and returns. Otherwise it starts the persistent
# daemon detached (independent of this console / any VS Code window), waits for
# a healthy /health, and returns its PID.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

$cfg = Join-Path $root "config.json"
if (-not (Test-Path $cfg)) {
    Copy-Item (Join-Path $root "config.example.json") $cfg
    Write-Host "[start] No config.json found; created from config.example.json. Edit policy.runner/reviewerModel before real reviews." -ForegroundColor Yellow
}
$port = (Get-Content $cfg | ConvertFrom-Json).daemon.port
$healthUrl = "http://127.0.0.1:$port/health"

# 1) Attach if already running.
try {
    $h = Invoke-RestMethod $healthUrl -TimeoutSec 3
    Write-Host "[start] Attached to existing daemon on 127.0.0.1:${port}: $($h | ConvertTo-Json -Compress)" -ForegroundColor Green
    exit 0
} catch {
    Write-Host "[start] No daemon on 127.0.0.1:$port yet; launching persistent daemon..." -ForegroundColor Cyan
}

# 2) Launch detached, headless (no console window ever). Prefer the scheduled
#    task if registered (idempotent, keeps it alive across reboots); the task
#    now launches through the zero-window VBS/Hidden wrapper. Fallback path uses
#    the same hidden launcher so manual starts are equally windowless.
$taskName = "HellDeskControlPlane"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName $taskName
} else {
    & (Join-Path $here "daemon-hidden.ps1") -Config $cfg | Out-Null
}

# 3) Wait for health (bounded, so we fail fast on real errors).
$deadline = (Get-Date).AddSeconds(15)
do {
    Start-Sleep -Milliseconds 300
    try {
        $h = Invoke-RestMethod $healthUrl -TimeoutSec 2
        Write-Host "[start] Daemon healthy: $($h | ConvertTo-Json -Compress)" -ForegroundColor Green
        exit 0
    } catch { }
} while ((Get-Date) -lt $deadline)
Write-Host "[start] Timed out waiting for the daemon to become healthy on 127.0.0.1:$port" -ForegroundColor Red
exit 1