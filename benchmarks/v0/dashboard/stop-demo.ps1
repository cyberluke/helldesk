# Stop the isolated demo dashboard started by start-demo.ps1.
param(
  [string]$PidFile = ""
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path

function Get-ListenerPid([int]$port) {
  $lines = netstat -ano | Select-String "127\.0\.0\.1:$port\s"
  foreach ($line in $lines) {
    $tokens = $line.Line -split '\s+'
    $ownerPid = 0
    if ([int]::TryParse($tokens[-1], [ref]$ownerPid) -and $ownerPid -gt 0) { return $ownerPid }
  }
  return 0
}
if (-not $PidFile) {
  $root = Join-Path $repo '.local\benchmark\v0\dashboard'
  $latest = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'pids.json') } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { throw "no demo run with pids.json found under $root" }
  $PidFile = Join-Path $latest.FullName 'pids.json'
}
if (-not (Test-Path $PidFile)) { throw "pid file not found: $PidFile" }
$pids = Get-Content $PidFile -Raw | ConvertFrom-Json
$ids = @($pids.daemonListenerPid, $pids.liveListenerPid, $pids.daemonPid, $pids.livePid) |
  Where-Object { $_ } | Select-Object -Unique
foreach ($id in $ids) {
  # Kill the actual listener and the bun wrapper tree.
  $null = & taskkill /PID $id /T /F 2>&1
  Write-Output "stopped process tree $id"
}
foreach ($port in @(4791, 8792)) {
  $listener = Get-ListenerPid $port
  if ($listener) {
    $null = & taskkill /PID $listener /T /F 2>&1
    Write-Output "stopped demo port $port pid $listener"
  }
}
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
