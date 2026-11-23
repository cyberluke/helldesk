# HELLDESK Local — hidden launcher for the local-live dashboard.
# Spawns `bun run src/entry.ts` fully detached (windowless) so the dashboard
# survives the launcher exit and any driving Kilo/VS Code session. Output is
# redirected to a durable run.log. Invoked by launch-dashboard-task.vbs with
# -Root <local-live root>.
param(
    [Parameter(Mandatory=$true)][string]$Root
)
$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 is used by the scheduled task; do NOT use `?.` here.
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCmd) {
    $bun = $bunCmd.Source
} else {
    # Scheduled tasks do not always inherit the interactive PATH; check the
    # official user install and common machine-wide package locations.
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
    Invoke-RestMethod "http://127.0.0.1:8790/health" -TimeoutSec 2 | Out-Null
    Write-Output "dashboard already healthy on 127.0.0.1:8790 (no launch needed)."
    exit 0
} catch {
    # not up yet — launch detached, hidden, no console.
}

$entry = Join-Path $Root "src\entry.ts"
$log   = Join-Path $Root "dashboard.log"
if (-not (Test-Path $entry)) { throw "entry not found: $entry" }

# Detached, hidden: inherit $HOME/user scope (Kilo gateway/config) but no console.
$p = Start-Process -FilePath $bun -ArgumentList @("run", $entry) `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError ($log + ".err") `
    -PassThru
# Leave a pid stamp so an operator can inspect/reap it.
Set-Content -Path (Join-Path $Root "dashboard.pid") -Value $p.Id
Write-Output "dashboard started pid=$($p.Id)"