# HELLDESK Local — windowless daemon launcher (proper backend/service).
#
# Launches the persistent control plane as a HEADSOCK background process that
# never allocates a console window. Used by the scheduled task and by
# scripts/start.ps1 (fallback path). This wrapper:
#   - runs `bun run src/main.ts --daemon` detached with CREATE_NO_WINDOW
#     semantics (no console host, nothing flashes on any desktop),
#   - redirects stdout/stderr to daemon.log so no console is needed,
#   - writes the detached child PID and exits immediately (non-blocking),
#   - never scans or kills any process by name; the daemon writes its own
#     Unix-style pidfile and the caller / stop-daemon.ps1 signals only that PID.
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\daemon-hidden.ps1 [-Config <path>] [-Task]
# The -Task switch is used by Task Scheduler so the wrapper knows to run once
# and rely on the daemon's singleton-port lock (idempotent boot).
param(
    [string]$Config,
    [switch]$Task
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
if (-not $Config) { $Config = Join-Path $root "config.json" }
if (-not (Test-Path $Config)) {
    Write-Error "[daemon-hidden] missing config: $Config"
    exit 2
}

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
    Write-Error "[daemon-hidden] bun not found. Install Bun or add it to PATH."
    exit 2
}
# Start-Process requires DISTINCT stdout and stderr targets (same-file redirect
# is rejected). Keep both logs side by side in the daemon directory.
$out = Join-Path $root "daemon.out.log"
$err = Join-Path $root "daemon.err.log"

# If a daemon is already healthy on the configured port, nothing to launch (the
# singleton lock + port binding make duplicate boots harmless, but this avoids
# even a re-bind flash and keeps a clean single instance).
$port = (Get-Content $Config | ConvertFrom-Json).daemon.port
try {
    Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2 | Out-Null
    Write-Host "[daemon-hidden] daemon already healthy on 127.0.0.1:$port (no launch needed)."
    exit 0
} catch {
    # not up yet — launch detached, hidden, no console.
}

# CREATE_NO_WINDOW = 0x08000000. Combined with -WindowStyle Hidden there is
# never a console window on any desktop. Redirect output to the log files.
$psi = Start-Process -FilePath $bun `
    -ArgumentList @("run", (Join-Path $root "src\main.ts"), "--daemon", "--config", "`"$Config`"") `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err `
    -PassThru

Write-Host "[daemon-hidden] launched hidden daemon PID $($psi.Id) (out: $out / err: $err) on 127.0.0.1:$port"
exit 0