<#
.SYNOPSIS
  End-to-end smoke test for the HELLDESK mission pipeline.

.DESCRIPTION
  Creates a disposable git workspace, registers it with the local daemon
  (:4790), files a small concrete mission, and waits for the independent
  reviewer + evidence gates to reach VERIFIED_10_10.

  Exit codes: 0 = VERIFIED_10_10, 1 = blocked/timeout, 2 = precondition failure.

.PARAMETER BaseUrl
  Local daemon base URL (default: http://127.0.0.1:<config.json daemon.port>).

.PARAMETER TokenPath
  Daemon bearer token file (default %LOCALAPPDATA%\HELLDESK\LocalDepartment\token).

.PARAMETER WorkspaceDir
  Scratch workspace (default <repo>\.local\smoke\<timestamp>, gitignored).

.PARAMETER TimeoutSeconds
  Overall wait bound (default 900).

.EXAMPLE
  pwsh -NoProfile -File scripts/mission-smoke.ps1

.EXAMPLE
  pwsh -NoProfile -File scripts/mission-smoke.ps1 -TimeoutSeconds 1200
#>
param(
  [string]$BaseUrl = '',
  [string]$TokenPath = (Join-Path $env:LOCALAPPDATA 'HELLDESK\LocalDepartment\token'),
  [string]$WorkspaceDir = '',
  [int]$TimeoutSeconds = 900,
  [string]$Objective = '',
  [switch]$CleanupWorkspace
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $BaseUrl) {
  # The daemon port is config-driven; do not assume 4790 after a port recovery.
  $port = 4790
  $cfgPath = Join-Path $root 'services\helldesk\local\config.json'
  if (Test-Path $cfgPath) {
    try { $port = [int](Get-Content $cfgPath -Raw | ConvertFrom-Json).daemon.port } catch { }
  }
  $BaseUrl = "http://127.0.0.1:$port"
}

if (-not $Objective) {
  $Objective = 'Create src/math.ts in this project with exactly two exported TypeScript functions: sum(a: number, b: number): number returning a + b, and product(a: number, b: number): number returning a * b. Do not create probe, scratch, log, or diagnostic script files. This is the only deliverable.'
}
if (-not $WorkspaceDir) {
  $WorkspaceDir = Join-Path $root ('.local\smoke\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}

function Fail([string]$Message) {
  Write-Host "[smoke] FAIL: $Message" -ForegroundColor Red
  exit 2
}

# ── 0. Preconditions ────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $TokenPath)) {
  Fail "token not found: $TokenPath`n         start the daemon first: pwsh -NoProfile -File scripts/start-all.ps1 -Service local"
}
$token = (Get-Content -Raw -LiteralPath $TokenPath).Trim()
$headers = @{ Authorization = "Bearer $token" }
try {
  $null = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/missions" -Headers $headers -TimeoutSec 8
} catch {
  Fail "daemon not reachable/authorized at $BaseUrl ($($_.Exception.Message.Split([Environment]::NewLine)[0]))`n         start it: pwsh -NoProfile -File scripts/start-all.ps1 -Service local"
}

# ── 1. Disposable git workspace ─────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path (Join-Path $WorkspaceDir 'src') | Out-Null
Set-Content -LiteralPath (Join-Path $WorkspaceDir 'README.md') -Value '# HELLDESK mission smoke workspace'
Set-Content -LiteralPath (Join-Path $WorkspaceDir 'src\index.ts') -Value 'export const placeholder = 1;'
git -C $WorkspaceDir init -q
git -C $WorkspaceDir add -A
git -C $WorkspaceDir -c user.name=helldesk-smoke -c user.email=smoke@local commit -q -m 'seed'
Write-Host "[smoke] workspace: $WorkspaceDir"

# ── 2. Register workspace + file the mission ────────────────────────────────
$registered = Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/workspaces/register" -Headers $headers `
  -ContentType 'application/json' -Body (@{ path = ($WorkspaceDir -replace '\\', '/') } | ConvertTo-Json)
$wsId = $registered.workspace.workspaceId
Write-Host "[smoke] workspaceId: $wsId"

$created = Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/missions" -Headers $headers `
  -ContentType 'application/json' -Body (@{
    workspaceId = $wsId
    objective   = $Objective
    taskGates   = @('functional_correctness')
  } | ConvertTo-Json -Depth 4)
$missionId = $created.missionId
Write-Host "[smoke] missionId: $missionId"
Write-Host "[smoke] objective: $Objective"
Write-Host '[smoke] waiting for VERIFIED_10_10 (mutation + reviewer A/B + adjudicator + gates)...'

# ── 3. Wait for the verdict ─────────────────────────────────────────────────
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$state = 'UNKNOWN'
$last = ''
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 10
  $mission = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/missions/$missionId" -Headers $headers -TimeoutSec 20
  $state = [string]$mission.mission.state
  if ($state -ne $last) {
    Write-Host "[smoke] $((Get-Date).ToString('HH:mm:ss')) mission -> $state"
    $last = $state
  }
  if ($state -in @('VERIFIED_10_10', 'BLOCKED_EXTERNAL', 'CANCELLED')) { break }
}

# ── 4. Report ───────────────────────────────────────────────────────────────
Write-Host ''
try {
  $tickets = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/missions/$missionId/tickets" -Headers $headers -TimeoutSec 20
  foreach ($t in $tickets.tickets) {
    Write-Host ("[smoke] ticket {0} exec={1} verify={2}" -f $t.ticketId, $t.executionState, $t.verificationState)
  }
} catch { Write-Host "[smoke] (tickets unavailable: $($_.Exception.Message.Split([Environment]::NewLine)[0]))" }

$deliverable = Join-Path $WorkspaceDir 'src\math.ts'
if (Test-Path -LiteralPath $deliverable) {
  Write-Host "[smoke] deliverable: $deliverable"
  Get-Content -LiteralPath $deliverable | Select-Object -First 12 | ForEach-Object { Write-Host "    $_" }
} else {
  Write-Host '[smoke] deliverable src/math.ts NOT present'
}
Write-Host '[smoke] git log:'
git -C $WorkspaceDir log --oneline -5 | ForEach-Object { Write-Host "    $_" }

Write-Host ''
if ($state -eq 'VERIFIED_10_10') {
  Write-Host '[smoke] PASS — mission independently verified (VERIFIED_10_10).' -ForegroundColor Green
  Write-Host "[smoke] UI: http://127.0.0.1:8790/helldesk"
  if ($CleanupWorkspace) { Remove-Item -Recurse -Force -LiteralPath $WorkspaceDir -ErrorAction SilentlyContinue }
  exit 0
}
Write-Host "[smoke] FAIL — mission ended in $state (workspace kept for inspection: $WorkspaceDir)" -ForegroundColor Red
exit 1
