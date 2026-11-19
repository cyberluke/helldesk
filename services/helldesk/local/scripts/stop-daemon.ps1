# CyberLuke Local HELLDESK -- stop the persistent daemon (Unix-style: pidfile).
# Reads the exact owning daemon PID from the control plane pidfile and signals
# ONLY that process (graceful). Never scans process names, never touches other
# Kilo/VS Code/etc. processes.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$config = Join-Path $root "config.json"
$dataDir = (Get-Content $config | ConvertFrom-Json).daemon.dataDir
$pidPath = Join-Path $dataDir "controlplane.pid"
$port = (Get-Content $config | ConvertFrom-Json).daemon.port

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Host "[stop] no pidfile found; nothing to stop." -ForegroundColor Yellow
    exit 0
}
$lines = Get-Content $pidPath
$dpid = [int]($lines[0])
$recordedPort = $lines[1]
Write-Host "[stop] daemon pid=$dpid"

$alive = $false
try { Get-Process -Id $dpid -ErrorAction Stop | Out-Null; $alive = $true } catch { $alive = $false }

if ($alive) {
    # Graceful terminate (SIGTERM-equivalent) so the daemon closes its own sockets/DB.
    Stop-Process -Id $dpid -ErrorAction SilentlyContinue
    Write-Host "[stop] signalled pid $dpid (graceful shutdown)." -ForegroundColor Cyan
} else {
    Write-Host "[stop] pid $dpid is not live; removing stale pidfile." -ForegroundColor Yellow
}

# Wait for the recorded port to be released (graceful shutdown closes sockets).
$waitPort = if ($recordedPort) { $recordedPort } else { $port }
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $bound = netstat -ano | Select-String -Pattern (":$waitPort.*LISTENING") | Select-Object -First 1
    if (-not $bound) { break }
    Start-Sleep -Milliseconds 500
}
Remove-Item -Force -LiteralPath $pidPath -ErrorAction SilentlyContinue
if (netstat -ano | Select-String -Pattern (":$waitPort.*LISTENING") | Select-Object -First 1) {
    Write-Host "[stop] port $waitPort still bound (orphaned socket). It will be reclaimed by the OS." -ForegroundColor Yellow
} else {
    Write-Host "[stop] port $waitPort released; daemon stopped." -ForegroundColor Green
}