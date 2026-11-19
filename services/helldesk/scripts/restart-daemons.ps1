# CyberLuke Local HELLDESK — FORCE-RESTART ALL DAEMONS (control plane + dashboard).
#
# Reusable operational block, invoked by the dashboard "Force-restart daemons"
# CTA (via entry.ts /api/system/restart) so the whole local HELLDESK surface can
# be bounced from the UI without a terminal.
#
# What it does:
#   1. Discovers the HELLDESK daemon processes we OWN — matched strictly by
#      command-line markers (repo-local repo paths + src/main.ts --daemon /
#      src/entry.ts / nai-fabric-host.exe). NEVER kills by bare "bun" name, and
#      never touches unrelated user processes.
#   2. Force-kills them (Stop-Process -Force).
#   3. Waits for their ports to be released.
#   4. Relaunches the control plane (src/main.ts --daemon, windowless via the
#      existing daemon-hidden.ps1 wrapper) and the dashboard (src/entry.ts),
#      both detached so they survive this script's exit and any driving UI.
#
# Safety:
#   - -WhatIf: print the KillSet (PID + command line) WITHOUT killing, so a human
#     or the agent can audit exactly what would be bounced.
#   - The script's own process and its parent PowerShell/bun are never in the set
#     (they don't match the HELLDESK markers), so relaunch is clean.
#   - We match the repo root to avoid nuking a DIFFERENT checkout/distribution.
#
# Run:
#   powershell -ExecutionPolicy Bypass -File scripts\restart-daemons.ps1
#   powershell ... -File scripts\restart-daemons.ps1 -WhatIf
param(
    [switch]$WhatIf
)
$ErrorActionPreference = "Continue"

function Get-RepoRoot {
    # scripts -> helldesk -> services -> repo root (has .git)
    $here = Split-Path -Parent $PSCommandPath
    $cand = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
    for ($i = 0; $i -lt 4; $i++) {
        if ($cand -and (Test-Path (Join-Path $cand ".git"))) { return $cand }
        $next = Split-Path -Parent $cand
        if (-not $next) { break }
        $cand = $next
    }
    return $null
}

function Wait-PortFree([int]$Port, [int]$Seconds = 20) {
    $d = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $d) {
        $hit = netstat -ano -ErrorAction SilentlyContinue | Select-String -Pattern ":$Port\s+.*LISTENING"
        if (-not $hit) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

$here = Split-Path -Parent $PSCommandPath                        # services/helldesk/scripts
$localRoot = Split-Path -Parent (Split-Path -Parent $here)       # services/helldesk/local   (control plane)
$liveRoot   = Join-Path $localRoot "local-live"                        # services/helldesk/local-live (dashboard)
$repoRoot   = Get-RepoRoot
$dataDir    = (Get-Content (Join-Path $localRoot "config.json") -ErrorAction SilentlyContinue | ConvertFrom-Json).daemon.dataDir
if (-not $dataDir) { $dataDir = Join-Path $env:LOCALAPPDATA "CyberLuke\LocalGasDepartment" }

Write-Host "[restart] repo root: $repoRoot"
Write-Host "[restart] data dir : $dataDir"

# ── 1) Discover our HELLDESK daemon processes by command-line markers ──────
# We check the command line for HELLDESK markers. The relative markers
# `src/main.ts --daemon`, `src/main.ts`, `src/entry.ts` and the `nai-fabric-host`
# binary are specific to this tool: only HELLDESK runs bun from this repo with
# those exact relative entry files, so an unrelated bun process on the machine is
# not a match. The wrapper PowerShells (which `Set-Location` into this repo and
# pipe to our logs) match via the repo path. We NEVER kill by bare "bun" name.
$markers = @(
    # control plane: `src/main.ts --daemon` and the manual `bun run src/main.ts`
    @{ Kind = "control-plane"; Pattern = "src[\\/]main\.ts" }
    # dashboard / department UI: `src/entry.ts`
    @{ Kind = "dashboard";     Pattern = "src[\\/]entry\.ts" }
    # NAI ExcellenceGovernor (external binary serving the HELLDESK workspace UI):
    @{ Kind = "excellenceGovernor";    Pattern = "nai-fabric-host\.exe" }
    # Launcher wrappers that Set-Location into the repo and pipe to HELLDESK logs:
    @{ Kind = "wrapper";       Pattern = "kilo-helldesk-local\\services\\helldesk" }
)

$killTargets = @()
$rootNorm = if ($repoRoot) { $repoRoot.Replace('\', '/').TrimEnd('/') } else { '' }
foreach ($m in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    $cl = $m.CommandLine
    if (-not $cl) { continue }
    $kind = $null
    foreach ($mk in $markers) {
        if ($cl -match $mk.Pattern) { $kind = $mk.Kind; break }
    }
    if (-not $kind) { continue }
    # Path-scope the device markers (control-plane/dashboard) to THIS repo so we
    # never force-kill an unrelated `bun run src/main.ts`/`src/entry.ts` on the
    # machine or in a different checkout. The wrapper/excellenceGovernor markers already
    # carry the repo path or a unique binary. (Fix: anchors to $repoRoot.)
    if (($kind -eq 'control-plane' -or $kind -eq 'dashboard') -and $rootNorm -ne '') {
        $clNorm = $cl.Replace('\', '/')
        if ($clNorm -notmatch [regex]::Escape($rootNorm)) { continue }
    }
    # Never add ourselves / the driving host: this script's process, or any shell
    # whose command line references this very script (a parent pwsh invoking us).
    if ($m.ProcessId -eq $PID) { continue }
    if ($cl -match 'restart-daemons\.ps1') { continue }
    $killTargets += [pscustomobject]@{ Pid = $m.ProcessId; Kind = $kind; Command = $cl }
}

Write-Host "[restart] found $($killTargets.Count) HELLDESK daemon process(es):"
$killTargets | ForEach-Object { Write-Host ("  [{0}] pid={1} :: {2}" -f $_.Kind, $_.Pid, $_.Command) }

if ($WhatIf) {
    Write-Host "[restart] -WhatIf: dry-run only. Would force-kill the above and relaunch control plane + dashboard."
    exit 0
}

# ── 2) Force-kill ───────────────────────────────────────────────────────────
foreach ($t in $killTargets) {
    try { Stop-Process -Id $t.Pid -Force -ErrorAction Stop; Write-Host "[restart] force-killed pid $($t.Pid) ($($t.Kind))" } catch { Write-Host "[restart] kill pid $($t.Pid): $($_.Exception.Message) (maybe already gone)" }
}

# ── 3) Wait for ports to be released ────────────────────────────────────────
$cpPort = (Get-Content (Join-Path $localRoot "config.json") -ErrorAction SilentlyContinue | ConvertFrom-Json).daemon.port
$livePort = try { [int][System.Environment]::GetEnvironmentVariable('HELLDESK_PORT') } catch { 0 }; if (-not $livePort -or $livePort -le 0) { $livePort = 8790 }

if ($cpPort) { if (Wait-PortFree $cpPort) { Write-Host "[restart] control-plane port $cpPort released" } else { Write-Host "[restart] WARN: port $cpPort still held; reclaim by OS shortly" } }
if (Wait-PortFree $livePort) { Write-Host "[restart] dashboard port $livePort released" } else { Write-Host "[restart] WARN: port $livePort still held" }

# ── 4) Relaunch detached ────────────────────────────────────────────────────
# Control plane: reuse the existing windowless daemon-hidden.ps1 wrapper.
Write-Host "[restart] relaunching control plane (src/main.ts --daemon)..."
try {
    & (Join-Path $localRoot "scripts\daemon-hidden.ps1") -Config (Join-Path $localRoot "config.json") | Out-Null
    Write-Host "[restart] control plane relaunch issued."
} catch {
    Write-Host "[restart] control plane relaunch failed: $($_.Exception.Message)"
}

# Dashboard: relaunch src/entry.ts detached (windowless), outliving this script.
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if ($bun) {
    Write-Host "[restart] relaunching dashboard (src/entry.ts)..."
    try {
        $psi = Start-Process -FilePath $bun `
            -ArgumentList @("run", (Join-Path $liveRoot "src\entry.ts")) `
            -WorkingDirectory $liveRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $liveRoot "dashboard.out.log") `
            -RedirectStandardError  (Join-Path $liveRoot "dashboard.err.log") `
            -PassThru
        Write-Host "[restart] dashboard relaunch issued (pid $($psi.Id))."
    } catch {
        Write-Host "[restart] dashboard relaunch failed: $($_.Exception.Message)"
    }
} else {
    Write-Host "[restart] WARN: bun not on PATH; dashboard not relaunched (start it manually: bun run src/entry.ts)."
}

Write-Host "[restart] done. Control plane + dashboard relaunch issued."
exit 0