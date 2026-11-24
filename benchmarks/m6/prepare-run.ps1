<#
.SYNOPSIS
  Prepare one isolated M6 live-run workspace + engine config.

.DESCRIPTION
  A live M6 run must never touch production (:4790/:8790) or a previous run's
  evidence. This script materializes a fresh copy of the seeded visual fixture,
  links the fixture's installed dependencies (junction), commits the broken
  baseline, and writes the isolated engine config.

  The workspace is the ONLY writable tree a mutation agent may see. The config
  points the control plane at a per-run dataDir outside the workspace.

.PARAMETER RunId
  Directory name under .local/benchmark (e.g. m6b).

.PARAMETER Port
  Control-plane port for this run (default 4791).

.EXAMPLE
  pwsh -File benchmarks/m6/prepare-run.ps1 -RunId m6b -Port 4791
#>
param(
  [Parameter(Mandatory = $true)][string]$RunId,
  [int]$Port = 4791
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fixture = Join-Path $repo 'benchmarks\v0\visual-fixture'
$root = Join-Path $repo ".local\benchmark\$RunId"
$workspace = Join-Path $root 'live-workspace'
$dataDir = Join-Path $root 'live-data'

# CROSS-INSTANCE ISOLATION (M6 run A root cause): a workspace may be writable by
# exactly ONE HELLDESK control plane. Run A was silently mutated by a production
# mission that had the same path registered, which invalidated its certification.
# Refuse to prepare a new benchmark run while any known instance still has a
# non-terminal benchmark mission.
$knownDbs = @()
$prodDb = Join-Path $env:LOCALAPPDATA 'HELLDESK\LocalDepartment\helldesk.db'
if (Test-Path -LiteralPath $prodDb) { $knownDbs += $prodDb }
$sqlite = Get-Command sqlite3.exe -ErrorAction SilentlyContinue
if ($sqlite) {
  foreach ($db in $knownDbs) {
    try {
      $busy = & $sqlite.Source $db "select m.mission_id || ' ' || m.state || ' ' || w.path from autonomy_missions m join workspaces w on w.workspace_id=m.workspace_id where m.state not in ('VERIFIED_10_10','CANCELLED','BLOCKED_EXTERNAL') and w.path like '%benchmark%';" 2>$null
    } catch { $busy = $null }
    if ($busy) {
      throw "Another HELLDESK instance is still running a benchmark mission: $busy — cancel it before starting a new isolated run."
    }
  }
}

if (Test-Path -LiteralPath $workspace) {
  throw "Refusing to overwrite an existing run workspace: $workspace"
}
if (-not (Test-Path -LiteralPath (Join-Path $fixture 'package.json'))) {
  throw "Fixture not found: $fixture"
}

New-Item -ItemType Directory -Path $root -Force | Out-Null
New-Item -ItemType Directory -Path $workspace -Force | Out-Null

# Copy the fixture without dependencies / build output / git metadata.
$exclude = @('node_modules', 'dist', '.git', 'test-results', '.vite')
Get-ChildItem -LiteralPath $fixture -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $workspace -Recurse -Force
}

# Junction the fixture's installed dependencies: identical lockfile, no 100 MB copy.
$fixtureModules = Join-Path $fixture 'node_modules'
if (Test-Path -LiteralPath $fixtureModules) {
  & cmd /c mklink /J "`"$workspace\node_modules`"" "`"$fixtureModules`"" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "mklink /J failed with exit $LASTEXITCODE" }
} else {
  throw "Fixture dependencies missing (run bun install in $fixture): $fixtureModules"
}

# Broken baseline: one commit, clean tree, no untracked files.
& git init -q $workspace
if ($LASTEXITCODE -ne 0) { throw "git init failed" }
& git -C $workspace config user.email 'helldesk@localhost'
& git -C $workspace config user.name 'HELLDESK'
& git -C $workspace add -A
& git -C $workspace commit -qm 'Initialize workspace (seeded pricing-card defect)'
if ($LASTEXITCODE -ne 0) { throw "baseline commit failed" }
$head = (& git -C $workspace rev-parse HEAD).Trim()

# The screenshot the mission objective refers to (same fixture as run A).
$shotSrc = Join-Path $repo '.local\benchmark\m6\broken-pricing-card.png'
$shot = Join-Path $root 'broken-pricing-card.png'
if (Test-Path -LiteralPath $shotSrc) { Copy-Item -LiteralPath $shotSrc -Destination $shot -Force }

# Isolated control-plane config (no production paths, autonomy enabled for this run).
$config = [ordered]@{
  version = 1
  daemon = [ordered]@{
    bind = '127.0.0.1'; port = $Port; dataDir = $dataDir
    debounceMs = 4000; production = $true; detachedWorkers = $true
    maxConcurrentJobs = 1; maxReviewersPerJob = 2; maxAttempts = 3
    leaseSeconds = 30; requestTimeoutMs = 120000
    retryBaseMs = 2000; retryMaxMs = 60000
    breakerThreshold = 3; breakerCooldownMs = 30000
    maxSnapshotBytes = 67108864; retentionDays = 30
  }
  policy = [ordered]@{
    runner = 'kilo'; productionCancelFake = $true; sizingTimeoutMs = 20000
    pricing = [ordered]@{ default = [ordered]@{ inputPer1M = 0; outputPer1M = 0 } }
    kiloServerBin = 'C:\Users\lukes.COREI9\.vscode-insiders\extensions\kilocode.kilo-code-7.8.32-win32-x64\bin\kilo.exe'
    strictCoverage = $true
  }
  autonomy = [ordered]@{
    enabled = $true; mutationRunner = 'kilo'
    kiloBin = 'C:\Users\lukes.COREI9\.vscode-insiders\extensions\kilocode.kilo-code-7.8.32-win32-x64\bin\kilo.exe'
    providerID = 'cyberluke'; modelID = 'deepseek-ai--deepseek-v41-flash-1017'
    baseURL = ''; apiKey = ''
    taskGates = @('spec_parity', 'no_scope_loss', 'functional_correctness', 'regression_safety', 'delivery_documentation')
  }
  context = [ordered]@{ tier = 'auto'; charsPerToken = 4; promptUtilization = 0.9 }
  workspaces = @()
}
$configPath = Join-Path $root 'live.config.json'
$config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM

# Copy the mission request with this run's workspace id + screenshot path.
$missionSrc = Join-Path $PSScriptRoot 'mission.json'
$mission = Get-Content -LiteralPath $missionSrc -Raw | ConvertFrom-Json
$mission.workspaceId = "ws_$RunId"
$mission.objective = $mission.objective.Replace('.local/benchmark/m6/broken-pricing-card.png', ".local/benchmark/$RunId/broken-pricing-card.png")
$missionPath = Join-Path $root 'mission.request.json'
$mission | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $missionPath -Encoding utf8NoBOM

[ordered]@{
  runId = $RunId
  workspace = $workspace
  workspaceId = "ws_$RunId"
  dataDir = $dataDir
  config = $configPath
  mission = $missionPath
  screenshot = $shot
  head = $head
} | ConvertTo-Json
