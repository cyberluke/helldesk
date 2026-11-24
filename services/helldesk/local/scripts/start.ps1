# HELLDESK Local — start (attach-or-launch one control-plane instance)
#
# If a control plane is already listening on the configured port, this attaches
# as a client (health check) and returns. Otherwise it starts the persistent
# daemon detached (independent of this console / any VS Code window), waits for
# a healthy /health, and returns.
#
# Instance-aware: -Config selects the config (default services/helldesk/local/config.json).
# The logon scheduled task is used ONLY for the default production config; an
# isolated config is launched through daemon-hidden.ps1 -Config, which writes a
# pidfile inside that config's dataDir (stop-daemon.ps1 -Config stops exactly it).
#
# Usage:
#   start.ps1
#   start.ps1 -Config <path>
param(
    [string]$Config
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

$defaultCfg = Join-Path $root "config.json"
if (-not $Config) { $Config = $defaultCfg }
if (-not (Test-Path -LiteralPath $Config)) {
    if ($Config -eq $defaultCfg) {
        Copy-Item (Join-Path $root "config.example.json") $Config
        Write-Host "[start] No config.json found; created from config.example.json. Edit policy.runner/reviewerModel before real reviews." -ForegroundColor Yellow
    } else {
        Write-Error "[start] config not found: $Config"
        exit 2
    }
}
$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$port = $cfg.daemon.port
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
#    task for the production config (idempotent, survives reboots); an isolated
#    config always uses the hidden launcher with that exact config.
$taskName = "HellDeskControlPlane"
$isDefault = ($Config -eq $defaultCfg)
if ($isDefault -and (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    Start-ScheduledTask -TaskName $taskName
} else {
    & (Join-Path $here "daemon-hidden.ps1") -Config $Config | Out-Null
}

# 3) Wait for health (bounded, so we fail fast on real errors).
$deadline = (Get-Date).AddSeconds(20)
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
