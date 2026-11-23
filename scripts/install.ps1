#Requires -Version 7
<#
.SYNOPSIS
  HELLDESK — one-time user installer for Windows.

.DESCRIPTION
  Sets up the local HELLDESK product without Administrator rights:
    - verifies (or optionally installs) Bun
    - installs the control-plane, operator-console, and UI dependencies
    - creates config.json from the example when absent
    - builds the operator console
    - registers the two persistent user-level services
    - creates a Start Menu shortcut (optional Desktop shortcut)
    - verifies both HTTP surfaces

  Safe to re-run. It never overwrites config.json, never deletes data, and
  never needs Administrator.

.EXAMPLE
  .\scripts\install.ps1 -DryRun

.EXAMPLE
  .\scripts\install.ps1 -WithKiloPlugin -DesktopShortcut
#>
[CmdletBinding()]
param(
  [switch]$InstallBun,
  [switch]$WithKiloPlugin,
  [switch]$NoShortcut,
  [switch]$DesktopShortcut,
  [switch]$Force,
  [switch]$DryRun,
  # Accepted for the .cmd wrapper; the wrapper controls the final pause.
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

trap {
  Write-Host ''
  Write-Host ("Install failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host '  Nothing was deleted. Fix the issue and re-run the installer.' -ForegroundColor Gray
  exit 1
}

$repo       = Split-Path -Parent $PSScriptRoot
$localDir   = Join-Path $repo 'services\helldesk\local'
$liveDir    = Join-Path $repo 'services\helldesk\local-live'
$uiDir      = Join-Path $liveDir 'ui'
$configPath = Join-Path $localDir 'config.json'
$exampleCfg = Join-Path $localDir 'config.example.json'
$startCmd   = Join-Path $PSScriptRoot 'start.cmd'
$port       = 4790
$dataDir    = $null

function Write-Banner {
  Write-Host ''
  Write-Host '  HELLDESK — Installer' -ForegroundColor White
  Write-Host '  Local AI-first software engineering' -ForegroundColor DarkGray
  Write-Host ''
}
function Write-Step([int]$Number, [string]$Text) {
  Write-Host ''
  Write-Host ("[{0}] {1}" -f $Number, $Text) -ForegroundColor Cyan
}
function Write-Ok([string]$Text)   { Write-Host ("  OK   {0}" -f $Text) -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host ("  !    {0}" -f $Text) -ForegroundColor Yellow }
function Write-Bad([string]$Text)  { Write-Host ("  X    {0}" -f $Text) -ForegroundColor Red }

function Test-Cmd([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}
function Get-HellDeskDataDir {
  $base = $env:LOCALAPPDATA
  if (-not $base) { $base = Join-Path $env:USERPROFILE 'AppData\Local' }
  return (Join-Path $base 'HELLDESK\LocalDepartment')
}
function Invoke-Bun([string]$Dir, [string[]]$BunArgs) {
  Push-Location $Dir
  try {
    & bun @BunArgs
    if ($LASTEXITCODE -ne 0) {
      throw ("bun {0} failed in {1} (exit {2})" -f ($BunArgs -join ' '), $Dir, $LASTEXITCODE)
    }
  } finally {
    Pop-Location
  }
}
function Test-UiStale {
  $index = Join-Path $uiDir 'dist\index.html'
  if (-not (Test-Path $index)) { return $true }
  $built = (Get-Item $index).LastWriteTimeUtc
  # Scan the UI source + build config only; never walk node_modules or dist.
  $candidates = @(
    Get-ChildItem $uiDir -File -ErrorAction SilentlyContinue
    Get-ChildItem (Join-Path $uiDir 'src') -Recurse -File -ErrorAction SilentlyContinue
  ) |
    Where-Object { $_.Extension -in '.ts', '.tsx', '.css', '.html', '.json' } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  return [bool]($candidates -and $candidates.LastWriteTimeUtc -gt $built)
}
function Wait-Health([string]$Url, [int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    try {
      Invoke-RestMethod $Url -TimeoutSec 2 | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)
  return $false
}
function Invoke-ChildScript([string]$Path, [string[]]$ChildArgs = @()) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Missing script: $Path" }
  $global:LASTEXITCODE = 0
  & $Path @ChildArgs
  if ($LASTEXITCODE -ne 0) { throw ("{0} failed (exit {1})" -f $Path, $LASTEXITCODE) }
}
function New-Shortcut([string]$Path) {
  $folder = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $folder)) {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $startCmd
  $shortcut.WorkingDirectory = $repo
  $shortcut.Description = 'Start HELLDESK and open the Operator Console'
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
  $shortcut.WindowStyle = 1
  $shortcut.Save()
}

Write-Banner

# ── 1. Toolchain ─────────────────────────────────────────────────────────────
Write-Step 1 'Toolchain'
if (-not (Test-Cmd 'bun')) {
  if ($DryRun) {
    Write-Bad 'Bun is required but was not found (dry run: nothing installed).'
    Write-Host '  Install it with:' -ForegroundColor Gray
    Write-Host '    powershell -c "irm bun.sh/install.ps1 | iex"' -ForegroundColor White
    exit 1
  }
  if ($InstallBun) {
    Write-Warn 'Bun not found; installing a user-scoped Bun…'
    $tmp = Join-Path $env:TEMP 'bun-install.ps1'
    Invoke-RestMethod 'https://bun.sh/install.ps1' -OutFile $tmp
    & powershell -NoProfile -ExecutionPolicy Bypass -File $tmp
    if ($LASTEXITCODE -ne 0) { throw 'Bun installation failed.' }
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
  }
  if (-not (Test-Cmd 'bun')) {
    Write-Bad 'Bun is required.'
    Write-Host '  Install it with:' -ForegroundColor Gray
    Write-Host '    powershell -c "irm bun.sh/install.ps1 | iex"' -ForegroundColor White
    Write-Host '  Then re-run this installer, or pass -InstallBun.' -ForegroundColor Gray
    exit 1
  }
}

$bunVersion = (& bun --version).Trim()
Write-Ok "Bun $bunVersion"
if (Test-Cmd 'git') {
  Write-Ok ((& git --version).Trim())
} else {
  Write-Warn 'Git not found — git-based mission workspaces will be unavailable.'
}
if (Test-Cmd 'node') {
  Write-Ok ((& node --version).Trim())
} else {
  Write-Warn 'Node not found — not required for the HELLDESK runtime, but some tooling may want it.'
}

$dataDir = Get-HellDeskDataDir
if (Test-Path -LiteralPath $configPath) {
  try {
    $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($cfg.daemon -and $cfg.daemon.port) { $port = [int]$cfg.daemon.port }
    if ($cfg.daemon -and $cfg.daemon.dataDir) { $dataDir = [string]$cfg.daemon.dataDir }
    Write-Ok "Config $configPath (control plane :$port)"
  } catch {
    Write-Bad "Config exists but is not valid JSON: $configPath"
    Write-Host '  Fix it, or remove it to regenerate from config.example.json.' -ForegroundColor Gray
    exit 1
  }
} else {
  Write-Warn 'No config.json yet; it will be created from config.example.json.'
}

if ($DryRun) {
  Write-Step 2 'Dry run — planned actions'
  Write-Host '  • bun install in services\helldesk\local'
  Write-Host '  • bun install in services\helldesk\local-live'
  Write-Host '  • bun install in services\helldesk\local-live\ui'
  Write-Host '  • build the operator console (vite)'
  Write-Host '  • create config.json if absent'
  Write-Host '  • register/start the control plane and operator console services'
  if ($WithKiloPlugin) { Write-Host '  • install the Kilo plugin shim' }
  if (-not $NoShortcut) { Write-Host '  • create the HELLDESK Start Menu shortcut' }
  if ($DesktopShortcut) { Write-Host '  • create the HELLDESK Desktop shortcut' }
  Write-Host ''
  Write-Host '  No changes were made.' -ForegroundColor DarkGray
  exit 0
}

# ── 2. Dependencies ──────────────────────────────────────────────────────────
Write-Step 2 'Installing HELLDESK dependencies'
Invoke-Bun $localDir @('install')
Write-Ok 'control plane dependencies'
Invoke-Bun $liveDir @('install')
Write-Ok 'operator console dependencies'
Invoke-Bun $uiDir @('install')
Write-Ok 'UI dependencies'

# ── 3. Configuration ─────────────────────────────────────────────────────────
Write-Step 3 'Configuration'
if (-not (Test-Path -LiteralPath $configPath)) {
  Copy-Item -LiteralPath $exampleCfg -Destination $configPath
  Write-Warn "Created $configPath from the example. Review runner, model, and workspaces."
}
$cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($cfg.daemon -and $cfg.daemon.port) { $port = [int]$cfg.daemon.port }
if ($cfg.daemon -and $cfg.daemon.dataDir) { $dataDir = [string]$cfg.daemon.dataDir }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Write-Ok "Data directory $dataDir"

if ($cfg.policy -and $cfg.policy.runner -eq 'fake') {
  Write-Warn 'policy.runner is "fake" — set the real runner before production reviews.'
}
if ($cfg.policy -and $cfg.policy.kiloServerBin -and -not (Test-Path -LiteralPath $cfg.policy.kiloServerBin)) {
  Write-Warn "policy.kiloServerBin does not exist: $($cfg.policy.kiloServerBin)"
}
$placeholder = @($cfg.workspaces | Where-Object {
  $_.path -eq 'C:/path/to/your/repo' -or $_.path -eq 'C:\path\to\your\repo'
})
if ($placeholder.Count -gt 0) {
  Write-Warn 'config.json still contains the example workspace path. Add repositories in Task Studio or config.json.'
}

# ── 4. Operator console build ────────────────────────────────────────────────
Write-Step 4 'Building the operator console'
if ($Force -or (Test-UiStale)) {
  Invoke-Bun $uiDir @('run', 'build')
  Write-Ok 'UI build complete'
} else {
  Write-Ok 'UI build is current'
}

# ── 5. Persistent services ───────────────────────────────────────────────────
Write-Step 5 'Registering persistent services'
Invoke-ChildScript (Join-Path $localDir 'scripts\install-daemon.ps1')
Write-Ok 'Control plane service registered'
Invoke-ChildScript (Join-Path $liveDir 'scripts\install-dashboard-daemon.ps1')
Write-Ok 'Operator console service registered'

# ── 6. Integrations ──────────────────────────────────────────────────────────
Write-Step 6 'Integrations'
if ($WithKiloPlugin) {
  Invoke-ChildScript (Join-Path $localDir 'scripts\install-plugin.ps1')
  Write-Ok 'Kilo plugin shim installed'
} else {
  Write-Host '  Skipped the Kilo plugin (pass -WithKiloPlugin to install it).' -ForegroundColor DarkGray
}

# ── 7. Shortcuts ─────────────────────────────────────────────────────────────
Write-Step 7 'Shortcuts'
if (-not $NoShortcut) {
  $programs = [Environment]::GetFolderPath('Programs')
  if ($programs) {
    $lnk = Join-Path $programs 'HELLDESK.lnk'
    New-Shortcut $lnk
    Write-Ok "Start Menu: $lnk"
  } else {
    Write-Warn 'Could not resolve the Start Menu folder; skipped the shortcut.'
  }
}
if ($DesktopShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) {
    $lnk = Join-Path $desktop 'HELLDESK.lnk'
    New-Shortcut $lnk
    Write-Ok "Desktop: $lnk"
  } else {
    Write-Warn 'Could not resolve the Desktop folder; skipped the shortcut.'
  }
}

# ── 8. Verify ────────────────────────────────────────────────────────────────
Write-Step 8 'Verifying'
$cpOk = Wait-Health "http://127.0.0.1:$port/health" 30
$dashOk = Wait-Health 'http://127.0.0.1:8790/health' 30
if (-not $cpOk) {
  Write-Bad "Control plane is not healthy on 127.0.0.1:$port"
  Write-Host "  See $localDir\daemon.err.log" -ForegroundColor Gray
}
if (-not $dashOk) {
  Write-Bad 'Operator console is not healthy on 127.0.0.1:8790'
  Write-Host "  See $liveDir\dashboard.log.err" -ForegroundColor Gray
}
if (-not $cpOk -or -not $dashOk) { exit 1 }
Write-Ok 'Control plane healthy'
Write-Ok 'Operator console healthy'

Write-Host ''
Write-Host '  HELLDESK is installed.' -ForegroundColor Green
Write-Host ''
Write-Host '    Operator Console   http://127.0.0.1:8790/helldesk/'
Write-Host "    Control plane      http://127.0.0.1:$port/health"
Write-Host "    Data               $dataDir"
$startHint = $startCmd
if (-not $NoShortcut) { $startHint = "$startCmd  (or the HELLDESK Start Menu shortcut)" }
Write-Host "    Start              $startHint"
Write-Host "    Stop               $startCmd -Stop"
Write-Host ''
Write-Host '  Tip: open the console, choose or create a Department, then dispatch from Task Studio.' -ForegroundColor DarkGray
