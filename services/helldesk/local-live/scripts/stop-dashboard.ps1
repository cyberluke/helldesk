# HELLDESK Local — stop one local-live dashboard instance (Unix-style: pidfile).
#
# Reads the exact PID written by launch-dashboard-hidden.ps1 and signals ONLY
# that process. Never scans process names, never touches other Kilo/VS Code/etc.
# processes. A PID-reuse guard requires the live command line to still contain
# `entry.ts`.
#
# Usage:
#   stop-dashboard.ps1                          # default <local-live>/dashboard.pid
#   stop-dashboard.ps1 -PidFile <path>          # isolated run pidfile
#   stop-dashboard.ps1 -PidFile <path> -Force   # escalate after graceful timeout
param(
    [string]$PidFile,
    [switch]$Force,
    [switch]$DryRun
)
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
if (-not $PidFile) { $PidFile = Join-Path $root "dashboard.pid" }

if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Host "[dashboard-stop] no pidfile at $PidFile; nothing to stop." -ForegroundColor Yellow
    exit 0
}
$dpid = 0
[void][int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$dpid)
$metaPath = "$PidFile.meta.json"
$meta = $null
if (Test-Path -LiteralPath $metaPath) {
    try { $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json } catch { $meta = $null }
}
$port = if ($meta -and $meta.port) { [int]$meta.port } else { 8790 }
Write-Host "[dashboard-stop] pid=$dpid port=$port pidfile=$PidFile"

$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$dpid" -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "[dashboard-stop] pid $dpid is not live; removing stale pidfile." -ForegroundColor Yellow
    if (-not $DryRun) {
        Remove-Item -Force -LiteralPath $PidFile -ErrorAction SilentlyContinue
        Remove-Item -Force -LiteralPath $metaPath -ErrorAction SilentlyContinue
    }
    exit 0
}

$cmd = [string]$proc.CommandLine
if (-not $cmd.ToLowerInvariant().Contains("entry.ts")) {
    Write-Host "[dashboard-stop] REFUSING to signal pid ${dpid}: command line is not the dashboard." -ForegroundColor Red
    Write-Host "       actual: $cmd"
    Write-Host "       (PID reuse or a foreign process; pidfile left in place.)"
    exit 3
}

if ($DryRun) {
    Write-Host "[dashboard-stop] dry-run: would signal pid $dpid gracefully." -ForegroundColor Cyan
    exit 0
}

Stop-Process -Id $dpid -ErrorAction SilentlyContinue
Write-Host "[dashboard-stop] signalled pid $dpid (graceful shutdown)." -ForegroundColor Cyan

$deadline = (Get-Date).AddSeconds(20)
$stillAlive = $false
while ((Get-Date) -lt $deadline) {
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$dpid" -ErrorAction SilentlyContinue
    if (-not $live) { $stillAlive = $false; break }
    Start-Sleep -Milliseconds 400
    $stillAlive = $true
}
if ($stillAlive -and $Force) {
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$dpid" -ErrorAction SilentlyContinue
    $cmd2 = if ($live) { [string]$live.CommandLine } else { "" }
    if ($live -and $cmd2.ToLowerInvariant().Contains("entry.ts")) {
        Write-Host "[dashboard-stop] graceful timeout; force-stopping verified pid $dpid." -ForegroundColor Yellow
        Stop-Process -Id $dpid -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "[dashboard-stop] refusing force-stop: identity changed." -ForegroundColor Red
        exit 3
    }
}

# Wait for the recorded port to be released.
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
    $bound = netstat -ano | Select-String -Pattern (":$port.*LISTENING") | Select-Object -First 1
    if (-not $bound) { break }
    Start-Sleep -Milliseconds 400
}
if (Get-CimInstance Win32_Process -Filter "ProcessId=$dpid" -ErrorAction SilentlyContinue) {
    Write-Host "[dashboard-stop] pid $dpid is still alive; pidfile kept for a later retry." -ForegroundColor Yellow
    exit 1
}
Remove-Item -Force -LiteralPath $PidFile -ErrorAction SilentlyContinue
Remove-Item -Force -LiteralPath $metaPath -ErrorAction SilentlyContinue
Write-Host "[dashboard-stop] stopped pid $dpid." -ForegroundColor Green
