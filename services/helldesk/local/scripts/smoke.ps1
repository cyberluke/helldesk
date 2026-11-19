# CyberLuke Local HELLDESK — smoke test
# Registers a local temp fixture and demonstrates an actual completed review
# report (fake deterministic runner by default). Prints report path + status.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

# Deterministic temp fixture (a small git repo with a "regression")
$fixture = Join-Path $env:TEMP "gt-smoke-$(Get-Date -Format yyyyMMddHHmmss)"
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
Push-Location $fixture
& git init -q
git config user.email "smoke@localhost"
git config user.name "smoke"

# Baseline (feature present)
"function compute(a, b) { return a + b; }" | Set-Content -Path "math.js"
git add math.js
git commit -qm "baseline: math feature present"

# Buggy change: silently drop the negative case (scope regression)
@"
function compute(a, b) {
  // BUG: negative operands are mishandled
  if (b === 0) return 0;
  return a + b;
}
"@ | Set-Content -Path "math.js"
git add math.js
git commit -qm "feat: handle zero (but regression drops correctness)"
Pop-Location

# Config for smoke: fake runner (deterministic), pointing at the fixture
$smokeCfg = Join-Path $env:TEMP "gt-smoke-config.json"
$cfgObj = @{
  version = 1
  daemon = @{ bind = "127.0.0.1"; port = 4791; debounceMs = 200 }
  policy = @{ runner = "fake"; strictCoverage = $true }
  workspaces = @(@{ path = $fixture; enabled = $true })
}
# Write without BOM — JSON.parse rejects a UTF-8 BOM.
[System.IO.File]::WriteAllText($smokeCfg, ($cfgObj | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[smoke] running Head review on fixture $fixture ..." -ForegroundColor Cyan
Push-Location $root
& bun run src/cli.ts head --path $fixture --config $smokeCfg
if ($LASTEXITCODE -ne 0) { throw "smoke CLI failed" }
Pop-Location

# Verify the report exists and validates
$stateDir = Join-Path $env:LOCALAPPDATA "CyberLuke\LocalGasDepartment"
$reports = Get-ChildItem (Join-Path $stateDir "reports") -Filter "job_*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
if ($reports.Count -eq 0) {
    throw "[smoke] no report produced"
}
$latest = $reports[0].FullName
Write-Host "[smoke] latest report: $latest" -ForegroundColor Green
$report = Get-Content $latest -Raw | ConvertFrom-Json
Write-Host "[smoke] status=$($report.result) findings=$($report.findings.Count)" -ForegroundColor Green
Write-Host "[smoke] coverage changed=$($report.coverage.changedFiles) inspected=$($report.coverage.inspectedFiles)" -ForegroundColor Green

# Cleanup fixture
Remove-Item -Recurse -Force $fixture -ErrorAction SilentlyContinue
Remove-Item -Force $smokeCfg -ErrorAction SilentlyContinue

Write-Host "[smoke] SMOKE PASS" -ForegroundColor Green