#Requires -Version 7
<#
.SYNOPSIS
  Read-only HELLDESK health check: effective config, ports, orphaned sockets,
  token, daemon/console reachability, migrations and duplicate workspaces.

.DESCRIPTION
  Run this BEFORE restarting services or debugging "the console is down".
  It never mutates the database or the config. Exit code 1 means at least one
  FAIL; WARN lines are actionable but not fatal.

.EXAMPLE
  pwsh -NoProfile -File scripts/doctor.ps1
#>
[CmdletBinding()]
param(
  [switch]$Json
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repo 'services\helldesk\local\config.json'
$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

function Write-Status([string]$label, [string]$status, [string]$detail) {
  $color = switch ($status) {
    'PASS' { 'Green' }
    'WARN' { 'Yellow' }
    'FAIL' { 'Red' }
    default { 'Gray' }
  }
  Write-Host ("{0,-8} {1,-5} {2}" -f $label, $status, $detail) -ForegroundColor $color
}

$cfg = $null
if (Test-Path -LiteralPath $configPath) {
  try {
    $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    Write-Status 'CONFIG' 'PASS' $configPath
  } catch {
    Write-Status 'CONFIG' 'FAIL' "$configPath (invalid JSON: $($_.Exception.Message))"
    $failures.Add('config')
  }
} else {
  Write-Status 'CONFIG' 'FAIL' "$configPath (missing)"
  $failures.Add('config')
}

$port = 4790
$dataDir = Join-Path ($env:LOCALAPPDATA ?? "$env:USERPROFILE\AppData\Local") 'HELLDESK\LocalDepartment'
if ($cfg) {
  if ($cfg.daemon -and $cfg.daemon.port) { $port = [int]$cfg.daemon.port }
  if ($cfg.daemon -and $cfg.daemon.dataDir) { $dataDir = [string]$cfg.daemon.dataDir }
}
$dbPath = if ($cfg -and $cfg.daemon -and $cfg.daemon.dbPath) { [string]$cfg.daemon.dbPath } else { Join-Path $dataDir 'helldesk.db' }
Write-Status 'EFFECTIVE' 'INFO' "engine port=$port dataDir=$dataDir db=$dbPath"

# ── listeners + orphaned sockets ────────────────────────────────────────────
$ports = @($port, 8790) | Select-Object -Unique
foreach ($p in $ports) {
  $listeners = @()
  try {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction Stop)
  } catch {
    $listeners = @()
  }
  if ($listeners.Count -eq 0) {
    # Get-NetTCPConnection can be blind to a listener on some Windows setups;
    # netstat is the fallback authority.
    $netListen = @(netstat -ano | Select-String -Pattern "[:.]$p\s" | Select-String -Pattern 'LISTENING')
    if ($netListen.Count -gt 0) {
      Write-Status "PORT:$p" 'PASS' "LISTEN (netstat) $($netListen[0].ToString().Trim())"
    } else {
      # The HTTP probe below is the authority; a missing listener here can be a
      # transient cmdlet/visibility issue, so do not fail on it alone.
      Write-Status "PORT:$p" 'INFO' 'no listener visible (HTTP probe decides)'
    }
  } else {
    $owners = ($listeners | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique) -join ','
    Write-Status "PORT:$p" 'PASS' "LISTEN pid=$owners"
  }
}

# Orphaned TCP sockets: netstat can still attribute a local port to a dead PID,
# which keeps the port un-bindable until the half-open sockets clear.
try {
  $orphans = @()
  $netstat = netstat -ano | Select-String -Pattern ":$port\s" -ErrorAction SilentlyContinue
  foreach ($line in $netstat) {
    $text = ($line.ToString() -replace '\s+', ' ').Trim()
    $parts = $text.Split(' ')
    $pidValue = $parts[$parts.Length - 1]
    if ($pidValue -match '^\d+$') {
      $proc = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
      if (-not $proc -and $text -notmatch 'LISTENING') { $orphans += $pidValue }
    }
  }
  $orphans = $orphans | Sort-Object -Unique
  if ($orphans.Count -gt 0) {
    Write-Status 'SOCKET' 'WARN' "orphaned :$port socket(s) attributed to dead pid $($orphans -join ',') — restart the console or wait for TCP timeout"
    $warnings.Add('orphan-socket')
  } else {
    Write-Status 'SOCKET' 'PASS' "no orphaned :$port sockets"
  }
} catch {
  Write-Status 'SOCKET' 'WARN' "netstat check failed: $($_.Exception.Message)"
}

# ── token ───────────────────────────────────────────────────────────────────
$tokenFile = Join-Path $dataDir 'token'
$token = $null
if (Test-Path -LiteralPath $tokenFile) {
  $token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
  if ($token.Length -ge 16) {
    Write-Status 'TOKEN' 'PASS' "$tokenFile (present, redacted)"
  } else {
    Write-Status 'TOKEN' 'FAIL' "$tokenFile exists but is empty/short"
    $failures.Add('token')
  }
} else {
  Write-Status 'TOKEN' 'FAIL' "$tokenFile (missing; start the daemon once to create it)"
  $failures.Add('token')
}

# ── reachability ────────────────────────────────────────────────────────────
if ($token) {
  try {
    $headers = @{ Authorization = "Bearer $token" }
    $queue = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/queue" -Headers $headers -TimeoutSec 8
    $depth = if ($queue.queue -ne $null) { $queue.queue } else { '?' }
    Write-Status 'ENGINE' 'PASS' "http://127.0.0.1:$port/v1/queue (queue=$depth)"
  } catch {
    Write-Status 'ENGINE' 'FAIL' "http://127.0.0.1:$port/v1/queue — $($_.Exception.Message)"
    $failures.Add('engine')
  }
}
try {
  $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:8790/api/departments' -TimeoutSec 8 -UseBasicParsing
  Write-Status 'CONSOLE' 'PASS' "http://127.0.0.1:8790/api/departments (HTTP $($resp.StatusCode))"
} catch {
  Write-Status 'CONSOLE' 'WARN' "http://127.0.0.1:8790/api/departments — $($_.Exception.Message)"
  $warnings.Add('console')
}

# ── database ────────────────────────────────────────────────────────────────
$dbScript = Join-Path $repo 'services\helldesk\local\scripts\doctor-db.ts'
if (Test-Path -LiteralPath $dbScript) {
  $dbOutput = & bun run $dbScript 2>&1
  $dbExit = $LASTEXITCODE
  foreach ($line in $dbOutput) { Write-Host "         $line" }
  if ($dbExit -ne 0) {
    $failures.Add('db')
  }
} else {
  Write-Status 'DB' 'WARN' "$dbScript (missing)"
  $warnings.Add('db-script')
}

# ── Kilo CLI ────────────────────────────────────────────────────────────────
$kilo = Get-Command kilo -ErrorAction SilentlyContinue
if ($kilo) {
  Write-Status 'KILO' 'PASS' $kilo.Source
} else {
  Write-Status 'KILO' 'WARN' 'kilo not on PATH (engine resolves the installed extension at startup)'
  $warnings.Add('kilo')
}

if ($Json) {
  [pscustomobject]@{
    port = $port
    dataDir = $dataDir
    dbPath = $dbPath
    failures = $failures
    warnings = $warnings
  } | ConvertTo-Json -Depth 4
}

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host "DOCTOR FAIL ($($failures.Count) failure(s)): $($failures -join ', ')" -ForegroundColor Red
  exit 1
}
if ($warnings.Count -gt 0) {
  Write-Host "DOCTOR PASS with warnings: $($warnings -join ', ')" -ForegroundColor Yellow
  exit 0
}
Write-Host 'DOCTOR PASS' -ForegroundColor Green
exit 0
