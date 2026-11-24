# HELLDESK Local — hidden launcher for one local-live dashboard instance.
#
# Spawns the dashboard detached (windowless) so it survives the launcher exit
# and any driving Kilo/VS Code session. Writes a pidfile + identity metadata so
# stop-dashboard.ps1 can signal EXACTLY this process (never a name scan).
#
# Instance-aware: -Port / -ControlConfig / -DataRoot select an isolated run.
#
# Usage:
#   launch-dashboard-hidden.ps1 -Root <local-live root>
#   launch-dashboard-hidden.ps1 -Root <local-live root> -Port 8792 `
#       -ControlConfig <run config> -DataRoot <run local-live data> -PidFile <path>
param(
    [Parameter(Mandatory=$true)][string]$Root,
    [int]$Port = 8790,
    [string]$ControlConfig,
    [string]$DataRoot,
    [string]$PidFile
)
$ErrorActionPreference = "Stop"

if (-not $PidFile) { $PidFile = Join-Path $Root "dashboard.pid" }

# Windows PowerShell 5.1 is used by the scheduled task; do NOT use `?.` here.
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCmd) {
    $bun = $bunCmd.Source
} else {
    $candidates = @(
        (Join-Path $env:USERPROFILE ".bun\bin\bun.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\bun\bun.exe"),
        (Join-Path $env:LOCALAPPDATA "UniGetUI\Chocolatey\bin\bun.exe"),
        (Join-Path $env:ProgramData "chocolatey\bin\bun.exe")
    )
    $bun = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $bun -or -not (Test-Path -LiteralPath $bun)) {
    throw "bun not found. Install Bun or add it to PATH."
}

# Idempotent boot: do not start a second dashboard on an occupied port.
try {
    Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null
    Write-Output "dashboard already healthy on 127.0.0.1:$Port (no launch needed)."
    exit 0
} catch {
    # not up yet — launch detached, hidden, no console.
}

$entry = Join-Path $Root "src\entry.ts"
if (-not (Test-Path -LiteralPath $entry)) { throw "entry not found: $entry" }
$log = Join-Path $Root "dashboard.log"

# Child env: the dashboard reads these; Start-Process inherits the current env.
$envKeys = @('HELLDESK_CONTROL_CONFIG', 'HELLDESK_PORT', 'HELLDESK_DATA_ROOT')
$saved = @{}
foreach ($key in $envKeys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key) }
try {
    if ($ControlConfig) { [Environment]::SetEnvironmentVariable('HELLDESK_CONTROL_CONFIG', $ControlConfig) }
    [Environment]::SetEnvironmentVariable('HELLDESK_PORT', "$Port")
    if ($DataRoot) { [Environment]::SetEnvironmentVariable('HELLDESK_DATA_ROOT', $DataRoot) }
    # Direct interpreter invocation (no `bun run` wrapper) so the recorded PID is
    # the dashboard server itself, not a wrapper that can exit and orphan it.
    $p = Start-Process -FilePath $bun -ArgumentList @($entry) `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $log `
        -RedirectStandardError ($log + ".err") `
        -PassThru
} finally {
    foreach ($key in $envKeys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
}

Set-Content -Path $PidFile -Value $p.Id
$meta = [ordered]@{
    schema = 'helldesk.dashboard.pid.v1'
    pid = $p.Id
    port = $Port
    controlConfig = $ControlConfig
    dataRoot = $DataRoot
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$meta | ConvertTo-Json | Set-Content -LiteralPath ($PidFile + '.meta.json') -Encoding utf8NoBOM
Write-Output "dashboard started pid=$($p.Id) port=$Port"
