# CyberLuke Local HELLDESK — hidden launcher for the local-live dashboard.
# Spawns `bun run src/entry.ts` fully detached (windowless) so the dashboard
# survives the launcher exit and any driving Kilo/VS Code session. Output is
# redirected to a durable run.log. Invoked by launch-dashboard-task.vbs with
# -Root <local-live root>.
param(
    [Parameter(Mandatory=$true)][string]$Root
)
$ErrorActionPreference = "Stop"

$bun = (Get-Command bun -ErrorAction SilentlyContinue)?.Source
if (-not $bun) { $bun = "C:\Users\lukes.COREI9\.bun\bin\bun.exe" }
if (-not (Test-Path $bun)) { throw "bun not found: $bun" }

$entry = Join-Path $Root "src\entry.ts"
$log   = Join-Path $Root "dashboard.log"
if (-not (Test-Path $entry)) { throw "entry not found: $entry" }

# Detached, hidden: inherit $HOME/user scope (LiteLLM gateway, kilo) but no console.
$p = Start-Process -FilePath $bun -ArgumentList @("run", $entry) `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError ($log + ".err") `
    -PassThru
# Leave a pid stamp so an operator can inspect/reap it.
Set-Content -Path (Join-Path $Root "dashboard.pid") -Value $p.Id
Write-Output "dashboard started pid=$($p.Id)"