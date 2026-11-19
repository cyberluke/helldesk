# Reusable: start ALL HELLDESK / NAI-Lattice runtimes that back the UI/UX.
# One command launches: NAI Inquisitor (:8787), local-live Town dashboards
# (:8790 / and /town), and the native local/ daemon (:4790).
# Each process logs to scripts\logs\<name>.log (created on demand).
#
# Usage:
#   powershell -File scripts\start-all.ps1            # start all three
#   powershell -File scripts\start-all.ps1 -Stop       # stop all started here
#   powershell -File scripts\start-all.ps1 -Service nai # start just the NAI host
#
# Runs on Windows (pwsh) with bun + cargo on PATH. Verified start commands
# come from each package's package.json / crate:
#   - local-live: `bun run src/entry.ts`  (port 8790, UI at / and /town)
#   - local/:     `bun run src/main.ts`    (port 4790, HTTP+WS API daemon)
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

function Start-One {
  param([string]$Name, [string]$Cmd, [string]$Work, [string]$TelLog)
  $log = Join-Path $logDir "$Name.log"
  $p = Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='nai-fabric-host.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.CommandLine -like "*$Cmd*" }
  if ($p) { Write-Output "$Name already running (pid $($p.ProcessId))." ; return }
  Write-Output "Starting $Name -> $Cmd  (workdir: $Work, log: $log)"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "powershell"   # spawn detached sub-shell
  $psi.Arguments = "-NoProfile -Command `"Set-Location '$Work'; $Cmd *>&1 | Tee-Object -FilePath '$log'`""
  $psi.WorkingDirectory = $Work
  $psi.UseShellExecute = $true           # detached, survives this script exit
  [System.Diagnostics.Process]::Start($psi) | Out-Null
}

function Stop-One {
  param([string]$Name, [string]$Cmd)
  Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='nai-fabric-host.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$Cmd*" } |
    ForEach-Object { Write-Output "Stopping $Name (pid $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Stop) {
  if ($Service -in @('all','nai'))       { Stop-One 'NAI host'   'nai-fabric-host' }
  if ($Service -in @('all','local-live')){ Stop-One 'local-live' 'src/entry.ts' }
  if ($Service -in @('all','local'))     { Stop-One 'local daemon' 'src/main.ts' }
  Write-Output "Done."
  exit 0
}

# NAI-Lattice host (port 8787) — cargo build then run.
if ($Service -in @('all','nai')) {
  if (-not (Test-Path (Join-Path $naiWork "Cargo.toml"))) {
    Write-Output "SKIP nai: NAI-Lattice not configured (set \$env:NAI_LATTICE_ROOT, or run HELLDESK standalone)."
  } else {
    Start-One 'nai-host' 'cargo run -p nai-fabric-host --bin nai-fabric-host' $naiWork
  }
}
# local-live (port 8790) Town dashboards.
if ($Service -in @('all','local-live')) {
  # Build the React HELLDESK UI (Option B) if it has changed / dist missing.
  $uiDir = Join-Path $liveDir "ui"
  if (Test-Path (Join-Path $uiDir "package.json")) {
    if (-not (Test-Path (Join-Path $uiDir "dist\index.html"))) {
      Write-Output "Building HELLDESK UI (first run)…"
      Push-Location $uiDir; bun run build; Pop-Location
    }
  }
  Start-One 'local-live' 'bun run src/entry.ts' $liveDir
}
# local/ native daemon (port 4790).
if ($Service -in @('all','local')) {
  Start-One 'local-daemon' 'bun run src/main.ts' $localDir
}

Write-Output "Started. UI surface map:"
if ($Service -in @('all','nai'))       { Write-Output "  NAI Inquisitor / Project Workspace -> http://127.0.0.1:8787/" }
if ($Service -in @('all','local-live')){ Write-Output "  Global shell                          -> http://127.0.0.1:8790/" }
if ($Service -in @('all','local-live')){ Write-Output "  Town dashboard                        -> http://127.0.0.1:8790/town" }
if ($Service -in @('all','local'))     { Write-Output "  local/ API daemon                     -> http://127.0.0.1:4790/" }
Write-Output "Logs: $logDir"