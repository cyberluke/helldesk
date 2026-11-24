# Start an isolated HELLDESK demo dashboard backed by a completed M3 proof DB.
# Production config/data are untouched. The dashboard runs on :8792 and reads
# the benchmark control plane on :4791 via HELLDESK_CONTROL_CONFIG.
param(
  [string]$ProofDb = ""
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$bun = (Get-Command bun -ErrorAction Stop).Source

function Get-ListenerPid([int]$port) {
  # Bun can leave the server socket in LISTENING, ESTABLISHED or FIN_WAIT during
  # a stale restart; any row whose LOCAL address is the demo port identifies the
  # owner PID.
  $lines = netstat -ano | Select-String "127\.0\.0\.1:$port\s"
  foreach ($line in $lines) {
    $tokens = $line.Line -split '\s+'
    $ownerPid = 0
    if ([int]::TryParse($tokens[-1], [ref]$ownerPid) -and $ownerPid -gt 0) { return $ownerPid }
  }
  return 0
}

# Demo ports are ours alone; production :4790/:8790 are never touched. A stale
# local-live/daemon listener from an earlier demo must not satisfy the health
# check or keep serving an old proof DB.
foreach ($port in @(4791, 8792)) {
  $listener = Get-ListenerPid $port
  if ($listener) {
    $null = & taskkill /PID $listener /T /F 2>&1
    Write-Output "preflight stopped demo port $port pid $listener"
  }
}
Start-Sleep -Milliseconds 500

$prepareArgs = @('run', (Join-Path $repo 'benchmarks\v0\dashboard\prepare-demo.ts'))
if ($ProofDb) { $prepareArgs += @('--proof-db', $ProofDb) }
$prepared = & $bun @prepareArgs
if ($LASTEXITCODE -ne 0) { throw "prepare-demo failed" }
$prepared | ForEach-Object { Write-Output $_ }
$config = ($prepared | Where-Object { $_ -like 'CONFIG=*' } | Select-Object -First 1) -replace '^CONFIG=', ''
$demoRoot = ($prepared | Where-Object { $_ -like 'DEMO_ROOT=*' } | Select-Object -First 1) -replace '^DEMO_ROOT=', ''
$dashboardUrl = ($prepared | Where-Object { $_ -like 'DASHBOARD_URL=*' } | Select-Object -First 1) -replace '^DASHBOARD_URL=', ''
if (-not $config -or -not $demoRoot) { throw "prepare-demo did not report CONFIG/DEMO_ROOT" }

$daemon = Start-Process -FilePath $bun -ArgumentList @('run', 'src/main.ts', '--config', $config) `
  -WorkingDirectory (Join-Path $repo 'services\helldesk\local') -PassThru -WindowStyle Hidden

$env:HELLDESK_CONTROL_CONFIG = $config
$env:HELLDESK_PORT = '8792'
$env:HELLDESK_DATA_ROOT = (Join-Path $demoRoot 'local-live')
$live = Start-Process -FilePath $bun -ArgumentList @('run', 'src/entry.ts') `
  -WorkingDirectory (Join-Path $repo 'services\helldesk\local-live') -PassThru -WindowStyle Hidden

$pidPath = Join-Path $demoRoot 'pids.json'
@{ daemonPid = $daemon.Id; livePid = $live.Id; dashboardUrl = $dashboardUrl; config = $config } |
  ConvertTo-Json | Set-Content -Path $pidPath -Encoding utf8
$daemonListener = Get-ListenerPid 4791
$liveListener = Get-ListenerPid 8792
@{ daemonPid = $daemon.Id; livePid = $live.Id; daemonListenerPid = $daemonListener; liveListenerPid = $liveListener; dashboardUrl = $dashboardUrl; config = $config } |
  ConvertTo-Json | Set-Content -Path $pidPath -Encoding utf8

function Wait-Health([string]$url, [int]$seconds = 60) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$daemonOk = Wait-Health 'http://127.0.0.1:4791/health'
$liveOk = Wait-Health 'http://127.0.0.1:8792/health'
if (-not $daemonOk -or -not $liveOk) {
  Write-Output "HEALTH daemon=$daemonOk live=$liveOk"
  Write-Output "PIDS daemon=$($daemon.Id) live=$($live.Id)"
  throw "demo dashboard did not become healthy; see $pidPath"
}

Write-Output "DEMO_READY daemon=$($daemon.Id) live=$($live.Id) daemonListener=$daemonListener liveListener=$liveListener"
Write-Output "DASHBOARD_URL=$dashboardUrl"
Write-Output "PIDS=$pidPath"
