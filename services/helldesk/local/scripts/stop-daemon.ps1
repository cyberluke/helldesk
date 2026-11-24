# HELLDESK Local -- stop one control-plane instance (Unix-style: pidfile).
#
# Reads the exact owning daemon PID from <dataDir>/controlplane.pid and signals
# ONLY that process. Never scans process names or command lines across the
# system, never touches other Kilo/VS Code/etc. processes.
#
# Identity guard (PID-reuse safe): before signalling, the live command line must
# contain `main.ts` AND the exact config path this instance was started with. A
# PID that was recycled to an unrelated process is left alone and reported.
#
# Usage:
#   stop-daemon.ps1                          # default services/helldesk/local/config.json
#   stop-daemon.ps1 -Config <path>           # isolated instance (e.g. benchmark run)
#   stop-daemon.ps1 -Config <path> -Force    # escalate after graceful timeout, still identity-checked
param(
    [string]$Config,
    [switch]$Force,
    [switch]$DryRun
)
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
if (-not $Config) { $Config = Join-Path $root "config.json" }
if (-not (Test-Path -LiteralPath $Config)) {
    Write-Host "[stop] config not found: $Config" -ForegroundColor Red
    exit 2
}
$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$dataDir = $cfg.daemon.dataDir
$pidPath = Join-Path $dataDir "controlplane.pid"

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Host "[stop] no pidfile at $pidPath; nothing to stop." -ForegroundColor Yellow
    exit 0
}
$lines = Get-Content -LiteralPath $pidPath
$dpid = 0
[void][int]::TryParse(($lines | Select-Object -First 1), [ref]$dpid)
$recordedPort = if ($lines.Count -ge 2) { $lines[1] } else { $cfg.daemon.port }
$port = if ($recordedPort) { [int]$recordedPort } else { [int]$cfg.daemon.port }
Write-Host "[stop] instance config=$Config"
Write-Host "[stop] daemon pid=$dpid port=$port"

$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$dpid" -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "[stop] pid $dpid is not live; removing stale pidfile." -ForegroundColor Yellow
    if (-not $DryRun) { Remove-Item -Force -LiteralPath $pidPath -ErrorAction SilentlyContinue }
    exit 0
}

# Identity: the live process must be OUR daemon for THIS config.
$cmd = [string]$proc.CommandLine
$looksLikeDaemon = $cmd.ToLowerInvariant().Contains("main.ts")
$looksLikeConfig = $cmd.IndexOf($Config, [StringComparison]::OrdinalIgnoreCase) -ge 0
if (-not ($looksLikeDaemon -and $looksLikeConfig)) {
    Write-Host "[stop] REFUSING to signal pid ${dpid}: command line does not match this instance." -ForegroundColor Red
    Write-Host "       expected: main.ts + $Config"
    Write-Host "       actual:   $cmd"
    Write-Host "       (PID reuse or a foreign process; pidfile left in place.)"
    exit 3
}

if ($DryRun) {
    Write-Host "[stop] dry-run: would signal pid $dpid gracefully." -ForegroundColor Cyan
    exit 0
}

# Graceful terminate (SIGTERM-equivalent) so the daemon closes its own sockets/DB.
Stop-Process -Id $dpid -ErrorAction SilentlyContinue
Write-Host "[stop] signalled pid $dpid (graceful shutdown)." -ForegroundColor Cyan

$deadline = (Get-Date).AddSeconds(30)
$stillAlive = $false
while ((Get-Date) -lt $deadline) {
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$dpid" -ErrorAction SilentlyContinue
    if (-not $live) { $stillAlive = $false; break }
    Start-Sleep -Milliseconds 500
    $stillAlive = $true
}
if ($stillAlive -and $Force) {
    # Re-verify identity immediately before escalation; a recycled PID must never be hit.
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$dpid" -ErrorAction SilentlyContinue
    $cmd2 = if ($live) { [string]$live.CommandLine } else { "" }
    if ($live -and $cmd2.ToLowerInvariant().Contains("main.ts") -and $cmd2.IndexOf($Config, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Write-Host "[stop] graceful timeout; force-stopping verified pid $dpid." -ForegroundColor Yellow
        Stop-Process -Id $dpid -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "[stop] refusing force-stop: identity changed." -ForegroundColor Red
        exit 3
    }
}

# Wait for the recorded port to be released.
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    $bound = netstat -ano | Select-String -Pattern (":$port.*LISTENING") | Select-Object -First 1
    if (-not $bound) { break }
    Start-Sleep -Milliseconds 500
}
if (Get-CimInstance Win32_Process -Filter "ProcessId=$dpid" -ErrorAction SilentlyContinue) {
    Write-Host "[stop] pid $dpid is still alive; pidfile kept for a later retry." -ForegroundColor Yellow
    exit 1
}
Remove-Item -Force -LiteralPath $pidPath -ErrorAction SilentlyContinue
if (netstat -ano | Select-String -Pattern (":$port.*LISTENING") | Select-Object -First 1) {
    Write-Host "[stop] port $port still bound (orphaned socket). It will be reclaimed by the OS." -ForegroundColor Yellow
} else {
    Write-Host "[stop] port $port released; daemon stopped." -ForegroundColor Green
}
