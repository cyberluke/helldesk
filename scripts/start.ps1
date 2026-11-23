#Requires -Version 7
<#
.SYNOPSIS
  Start, stop, or inspect the complete HELLDESK local stack.

.DESCRIPTION
  One user-facing command for the local product:
    - starts the native HELLDESK control plane
    - starts the local-live Operator Console (UI on http://127.0.0.1:8790/helldesk/)
    - optionally starts the NAI-Lattice fabric host when NAI_LATTICE_ROOT is set
    - waits for health and opens the Operator Console

  The persistent user-level services installed by scripts\install.ps1 are used
  when present; otherwise the documented hidden launchers are used. Every step
  is idempotent, so running this while HELLDESK is already up just attaches.

.EXAMPLE
  .\scripts\start.ps1

.EXAMPLE
  .\scripts\start.ps1 -Status

.EXAMPLE
  .\scripts\start.ps1 -Stop
#>
[CmdletBinding()]
param(
  [switch]$Status,
  [switch]$Stop,
  [switch]$NoBrowser,
  [switch]$NoNai,
  # Accepted for the .cmd wrapper; the wrapper controls the final pause.
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

trap {
  Write-Host ''
  Write-Host ("HELLDESK could not start: {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host '  Run with -Status to inspect the stack, or open the logs named above.' -ForegroundColor Gray
  exit 1
}

$repo       = Split-Path -Parent $PSScriptRoot
$localDir   = Join-Path $repo 'services\helldesk\local'
$liveDir    = Join-Path $repo 'services\helldesk\local-live'
$uiDir      = Join-Path $liveDir 'ui'
$configPath = Join-Path $localDir 'config.json'
$startCmd   = Join-Path $PSScriptRoot 'start.cmd'
$port       = 4790

# Scheduler IDs are implementation details. The product surface is HELLDESK;
# the control-plane task keeps its historical ID so existing installs keep
# working without a second daemon on the same port.
$controlTask   = 'HellDeskControlPlane'
$dashboardTask = 'HellDeskOperatorConsole'

function Write-Banner {
  Write-Host ''
  Write-Host '  HELLDESK' -ForegroundColor White
  Write-Host '  Local AI-first software engineering' -ForegroundColor DarkGray
  Write-Host ''
}
function Write-Ok([string]$Text)   { Write-Host ("  OK   {0}" -f $Text) -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host ("  !    {0}" -f $Text) -ForegroundColor Yellow }
function Write-Bad([string]$Text)  { Write-Host ("  X    {0}" -f $Text) -ForegroundColor Red }

function Get-Health([string]$Url) {
  try {
    return Invoke-RestMethod $Url -TimeoutSec 2
  } catch {
    return $null
  }
}
function Wait-Health([string]$Url, [string]$Label, [int]$Seconds = 30) {
  Write-Host ("  Waiting for {0} " -f $Label) -NoNewline
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (Get-Health $Url) {
      Write-Host ' ready' -ForegroundColor Green
      return $true
    }
    Write-Host '.' -NoNewline
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  Write-Host ' timeout' -ForegroundColor Red
  return $false
}
function Read-ControlPlaneConfig {
  if (-not (Test-Path -LiteralPath $configPath)) {
    Write-Bad 'HELLDESK is not installed yet.'
    Write-Host '  Run scripts\install.cmd first.' -ForegroundColor Gray
    exit 1
  }
  try {
    $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($cfg.daemon -and $cfg.daemon.port) { $script:port = [int]$cfg.daemon.port }
    return $cfg
  } catch {
    Write-Bad "Config is not valid JSON: $configPath"
    exit 1
  }
}
function Show-Status {
  $cp = Get-Health "http://127.0.0.1:$port/health"
  $dash = Get-Health 'http://127.0.0.1:8790/health'
  $nai = $null
  $naiConfigured = (-not $NoNai) -and [bool]$env:NAI_LATTICE_ROOT
  if ($naiConfigured) { $nai = Get-Health 'http://127.0.0.1:8787/health' }

  Write-Host ''
  Write-Host '  HELLDESK status' -ForegroundColor White
  if ($cp) { Write-Ok "Control plane    healthy on 127.0.0.1:$port" } else { Write-Bad "Control plane    down on 127.0.0.1:$port" }
  if ($dash) { Write-Ok 'Operator console healthy on 127.0.0.1:8790' } else { Write-Bad 'Operator console down on 127.0.0.1:8790' }
  if ($naiConfigured) {
    if ($nai) { Write-Ok 'NAI host         healthy on 127.0.0.1:8787' } else { Write-Warn 'NAI host         configured but down on 127.0.0.1:8787' }
  } else {
    Write-Host '  NAI host         not configured (standalone HELLDESK)' -ForegroundColor DarkGray
  }
  Write-Host ''
  Write-Host '  Operator Console  http://127.0.0.1:8790/helldesk/' -ForegroundColor Gray
  return [bool]($cp -and $dash)
}

function Stop-All {
  Write-Host '  Stopping HELLDESK…' -ForegroundColor Cyan
  Write-Warn 'Stopping the control plane interrupts any running mission.'

  $stopDaemon = Join-Path $localDir 'scripts\stop-daemon.ps1'
  if (Test-Path -LiteralPath $stopDaemon) {
    $global:LASTEXITCODE = 0
    & $stopDaemon
  } else {
    & (Join-Path $repo 'scripts\start-all.ps1') -Stop -Service local
  }

  $dashStopped = $false
  $pidFile = Join-Path $liveDir 'dashboard.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $dashPid = 0
    [void][int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$dashPid)
    if ($dashPid -gt 0) {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$dashPid" -ErrorAction SilentlyContinue
      if ($proc -and $proc.CommandLine -match 'entry\.ts') {
        Stop-Process -Id $dashPid -Force -ErrorAction SilentlyContinue
        Write-Ok "Operator console stopped (pid $dashPid)"
        $dashStopped = $true
      }
    }
  }
  if (-not $dashStopped) {
    & (Join-Path $repo 'scripts\start-all.ps1') -Stop -Service local-live
  }

  if ((-not $NoNai) -and $env:NAI_LATTICE_ROOT) {
    & (Join-Path $repo 'scripts\start-all.ps1') -Stop -Service nai
  }

  Start-Sleep -Milliseconds 800
  [void](Show-Status)
  Write-Host '  Logon services remain registered; they start again at the next sign-in.' -ForegroundColor DarkGray
}

function Start-All {
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Bad 'Bun is not on PATH.'
    Write-Host '  Run scripts\install.cmd first.' -ForegroundColor Gray
    exit 1
  }
  if (-not (Test-Path (Join-Path $localDir 'node_modules')) -or
      -not (Test-Path (Join-Path $liveDir 'node_modules')) -or
      -not (Test-Path (Join-Path $uiDir 'node_modules'))) {
    Write-Bad 'HELLDESK dependencies are missing.'
    Write-Host '  Run scripts\install.cmd first.' -ForegroundColor Gray
    exit 1
  }

  $uiIndex = Join-Path $uiDir 'dist\index.html'
  if (-not (Test-Path -LiteralPath $uiIndex)) {
    Write-Host '  Building the operator console…' -ForegroundColor Cyan
    Push-Location $uiDir
    try {
      & bun run build
      if ($LASTEXITCODE -ne 0) { throw 'UI build failed.' }
    } finally {
      Pop-Location
    }
  }

  if (Get-Health "http://127.0.0.1:$port/health") {
    Write-Ok "Control plane already healthy on 127.0.0.1:$port"
  } else {
    $task = Get-ScheduledTask -TaskName $controlTask -ErrorAction SilentlyContinue
    if ($task) {
      Write-Host '  Starting the control plane service…' -ForegroundColor Cyan
      try {
        Start-ScheduledTask -TaskName $controlTask -ErrorAction Stop
      } catch {
        & (Join-Path $localDir 'scripts\start.ps1')
      }
    } else {
      Write-Host '  Starting the control plane…' -ForegroundColor Cyan
      & (Join-Path $localDir 'scripts\start.ps1')
    }
  }

  if (Get-Health 'http://127.0.0.1:8790/health') {
    Write-Ok 'Operator console already healthy on 127.0.0.1:8790'
  } else {
    $task = Get-ScheduledTask -TaskName $dashboardTask -ErrorAction SilentlyContinue
    if ($task) {
      Write-Host '  Starting the operator console service…' -ForegroundColor Cyan
      try {
        Start-ScheduledTask -TaskName $dashboardTask -ErrorAction Stop
      } catch {
        & (Join-Path $liveDir 'scripts\launch-dashboard-hidden.ps1') -Root $liveDir
      }
    } else {
      Write-Host '  Starting the operator console…' -ForegroundColor Cyan
      & (Join-Path $liveDir 'scripts\launch-dashboard-hidden.ps1') -Root $liveDir
    }
  }

  if ($NoNai) {
    Write-Host '  NAI host skipped (-NoNai).' -ForegroundColor DarkGray
  } elseif (-not $env:NAI_LATTICE_ROOT) {
    Write-Host '  NAI host not configured (standalone HELLDESK).' -ForegroundColor DarkGray
  } elseif (-not (Test-Path (Join-Path $env:NAI_LATTICE_ROOT 'Cargo.toml'))) {
    Write-Warn "NAI_LATTICE_ROOT is set but has no Cargo.toml: $env:NAI_LATTICE_ROOT"
  } elseif (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Warn 'Cargo not found; NAI host not started (HELLDESK still works standalone).'
  } else {
    Write-Host '  Starting the NAI host…' -ForegroundColor Cyan
    & (Join-Path $repo 'scripts\start-all.ps1') -Service nai
  }

  $cpOk = Wait-Health "http://127.0.0.1:$port/health" 'control plane' 30
  $dashOk = Wait-Health 'http://127.0.0.1:8790/health' 'operator console' 30
  if (-not $cpOk) { throw "Control plane did not become healthy. See $localDir\daemon.err.log" }
  if (-not $dashOk) { throw "Operator console did not become healthy. See $liveDir\dashboard.log.err" }

  $url = 'http://127.0.0.1:8790/helldesk/'
  try {
    $deps = Invoke-RestMethod 'http://127.0.0.1:8790/api/departments' -TimeoutSec 3
    $hasDefault = @($deps.data | Where-Object { $_.id -eq 'default' }).Count -gt 0
    if ($hasDefault) { $url = 'http://127.0.0.1:8790/helldesk/#/helldesk/default/chat' }
  } catch { }

  if (-not $NoBrowser) {
    Write-Host '  Opening the Operator Console…' -ForegroundColor Cyan
    Start-Process $url
  }

  Write-Host ''
  Write-Host '  HELLDESK is running.' -ForegroundColor Green
  Write-Host ''
  Write-Host '    Operator Console   http://127.0.0.1:8790/helldesk/'
  Write-Host "    Control plane      http://127.0.0.1:$port/health"
  Write-Host "    Stop               $startCmd -Stop"
  Write-Host ''
}

Write-Banner

if ($Status -and $Stop) {
  Write-Bad 'Use either -Status or -Stop, not both.'
  exit 2
}

[void](Read-ControlPlaneConfig)

if ($Status) {
  if (Show-Status) { exit 0 } else { exit 1 }
}
if ($Stop) {
  Stop-All
  exit 0
}

Start-All
