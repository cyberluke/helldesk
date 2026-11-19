# CyberLuke Local HELLDESK — bootstrap
# Idempotent, user-scoped setup for native Windows. No admin rights, no Docker/WSL.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

Write-Host "[bootstrap] Checking toolchain..." -ForegroundColor Cyan

# Bun (required for running the daemon/tests)
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "[bootstrap] Bun not found. Installing user-scoped Bun..." -ForegroundColor Yellow
    # Official Windows installer script via PowerShell
    Invoke-WebRequest -Uri "https://bun.sh/install" -OutFile "$env:TEMP\bun-install.ps1"
    & "$env:TEMP\bun-install.ps1"
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
} else {
    Write-Host "[bootstrap] bun: $(bun --version)" -ForegroundColor Green
}

# Node (>= 18 recommended; Bun runs the engine but some tooling wants node)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[bootstrap] Node not found. Install Node 24 LTS from https://nodejs.org then re-run." -ForegroundColor Red
} else {
    Write-Host "[bootstrap] node: $(node --version)" -ForegroundColor Green
}

# Git (required for git-target reviews, optional for plain-folder mode)
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "[bootstrap] git NOT found. Git targets will be unavailable (plain-folder reviews still work)." -ForegroundColor Yellow
} else {
    Write-Host "[bootstrap] git: $(git --version)" -ForegroundColor Green
}

Write-Host "[bootstrap] Resolving dependencies (pinned)..." -ForegroundColor Cyan
Push-Location $root
& bun install
if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
Pop-Location

# Persistent state dir
$stateDir = Join-Path $env:LOCALAPPDATA "CyberLuke\LocalGasDepartment"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Write-Host "[bootstrap] State dir: $stateDir" -ForegroundColor Green

Write-Host "[bootstrap] Writing default config if absent..." -ForegroundColor Cyan
$cfg = Join-Path $root "config.json"
if (-not (Test-Path $cfg)) {
    Copy-Item (Join-Path $root "config.example.json") $cfg
    Write-Host "[bootstrap] Created $cfg (runner=fake default for first-run safety)." -ForegroundColor Yellow
}

Write-Host "[bootstrap] Done. Run .\scripts\start.ps1 to start, .\scripts\verify.ps1 to self-test." -ForegroundColor Green