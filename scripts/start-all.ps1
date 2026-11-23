# Reusable: start ALL HELLDESK / NAI-Lattice runtimes that back the UI/UX.
# One command launches: the optional NAI-Lattice fabric host (:8787), the
# HELLDESK Operator Console (local-live, :8790), and the native HELLDESK control
# plane (config.json daemon.port).
# Each process logs to scripts\logs\<name>.log (created on demand).
#
# Usage:
#   powershell -File scripts\start-all.ps1            # start all three
#   powershell -File scripts\start-all.ps1 -Stop       # stop all started here
#   powershell -File scripts\start-all.ps1 -Service nai # start just the NAI host
#
# Runs on Windows (pwsh) with bun + cargo on PATH. Verified start commands
# come from each package's package.json / crate:
#   - local-live: `bun run src/entry.ts`  (port 8790, UI at /helldesk)
#   - local/:     `bun run src/main.ts`    (config.json daemon.port, HTTP+WS API daemon)
#   - NAI host:   `cargo run -p nai-fabric-host --bin nai-fabric-host` (port 8787, Project Workspace UI)

param(
  [switch]$Stop,
  [string]$Service = "all"   # all | nai | local-live | local
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# NAI-Lattice (fabric host, port 8787) is a SEPARATE repo. Point this at a
# local checkout via $env:NAI_LATTICE_ROOT, or leave empty to run HELLDESK
# standalone (the local mission engine needs no fabric host).
$naiWork = $env:NAI_LATTICE_ROOT
$liveDir = Join-Path $root "services/helldesk\local-live"
$localDir = Join-Path $root "services/helldesk\local"
# The daemon port is config-driven (config.json daemon.port), never assumed.
$localPort = 4790
try {
  $localCfgPath = Join-Path $localDir "config.json"
  if (Test-Path $localCfgPath) {
    $localPort = [int](Get-Content $localCfgPath -Raw | ConvertFrom-Json).daemon.port
  }
} catch { }

function Start-One {
  param([string]$Name, [string]$Cmd, [string]$Work, [string]$Match = '')
  $log = Join-Path $logDir "$Name.log"
  # Match on a regex, not a raw substring (Windows paths use backslashes and the
  # same script can run from a temp test config). `gt-multi-*` are test daemons;
  # they must never mask the production daemon or be killed by this script.
  $pattern = if ($Match) { $Match } else { [regex]::Escape($Cmd) }
  $p = Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='nai-fabric-host.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.CommandLine -match $pattern -and $_.CommandLine -notmatch 'gt-multi-' }
  if ($p) { Write-Output "$Name already running (pid $($p.ProcessId))." ; return }
  Write-Output "Starting $Name -> $Cmd  (workdir: $Work, log: $log)"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "pwsh"   # spawn detached sub-shell
  $psi.Arguments = "-NoProfile -NonInteractive -Command `"Set-Location '$Work'; $Cmd *>&1 | Tee-Object -FilePath '$log'`""
  $psi.WorkingDirectory = $Work
  $psi.UseShellExecute = $true           # detached, survives this script exit
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden  # no console pop-ups
  [System.Diagnostics.Process]::Start($psi) | Out-Null
}

function Stop-One {
  param([string]$Name, [string]$Cmd, [string]$Match = '')
  $pattern = if ($Match) { $Match } else { [regex]::Escape($Cmd) }
  Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='nai-fabric-host.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $pattern -and $_.CommandLine -notmatch 'gt-multi-' } |
    ForEach-Object { Write-Output "Stopping $Name (pid $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Stop) {
  if ($Service -in @('all','nai'))       { Stop-One 'NAI host'   'nai-fabric-host' }
  if ($Service -in @('all','local-live')){ Stop-One 'local-live' 'src/entry.ts' 'src[\\/]+entry\.ts' }
  # Stop the daemon AND its workers (same main.ts script, no --daemon flag) for a
  # clean restart; test daemons with gt-multi configs are excluded.
  if ($Service -in @('all','local'))     { Stop-One 'local daemon' 'src/main.ts' 'src[\\/]+main\.ts' }
  Write-Output "Done."
  exit 0
}

# NAI-Lattice fabric host (port 8787) — optional, separate repo.
$naiStarted = $false
if ($Service -in @('all','nai')) {
  if (-not $naiWork) {
    Write-Output 'SKIP nai: NAI-Lattice not configured (set $env:NAI_LATTICE_ROOT, or run HELLDESK standalone).'
  } elseif (-not (Test-Path (Join-Path $naiWork "Cargo.toml"))) {
    Write-Output "SKIP nai: no Cargo.toml in $naiWork."
  } elseif (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Output "SKIP nai: cargo not found on PATH (HELLDESK still works standalone)."
  } else {
    Start-One 'nai-host' 'cargo run -p nai-fabric-host --bin nai-fabric-host' $naiWork 'nai-fabric-host'
    $naiStarted = $true
  }
}
# HELLDESK Operator Console (local-live, port 8790).
if ($Service -in @('all','local-live')) {
  # Build the React HELLDESK UI (Option B) if it has changed / dist missing.
  $uiDir = Join-Path $liveDir "ui"
  if (Test-Path (Join-Path $uiDir "package.json")) {
    if (-not (Test-Path (Join-Path $uiDir "dist\index.html"))) {
      Write-Output "Building HELLDESK UI (first run)…"
      Push-Location $uiDir; bun run build; Pop-Location
    }
  }
  Start-One 'local-live' 'bun run src/entry.ts' $liveDir 'src[\\/]+entry\.ts'
}
# local/ native daemon (config.json daemon.port). --daemon is REQUIRED: it sets
# HELLDESK_DETACHED_WORKERS=1, which routes reviews through independent worker
# processes; without it the local Kilo runner refuses to run in-process.
if ($Service -in @('all','local')) {
  Start-One 'local-daemon' 'bun run src/main.ts --daemon --config config.json' $localDir 'src[\\/]+main\.ts.*--daemon'
}

Write-Output "Started. UI surface map:"
if ($Service -in @('all','nai')) {
  if ($naiStarted) { Write-Output "  NAI-Lattice fabric host               -> http://127.0.0.1:8787/" }
  else { Write-Output "  NAI-Lattice fabric host               -> skipped (not configured)" }
}
if ($Service -in @('all','local-live')){ Write-Output "  Operator Console                      -> http://127.0.0.1:8790/helldesk/" }
if ($Service -in @('all','local'))     { Write-Output "  local/ API daemon                     -> http://127.0.0.1:$localPort/" }
Write-Output "Logs: $logDir"