# CyberLuke Local HELLDESK — one-command reproducible verification
# Runs: typecheck -> unit tests -> integration (git/folder fixtures) -> fault
# injection -> e2e smoke against a real local fixture -> report + API check.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
Push-Location $root

Write-Host "== [verify] typecheck ==" -ForegroundColor Cyan
& bunx tsc --noEmit -p tsconfig.json
if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }

Write-Host "== [verify] unit tests ==" -ForegroundColor Cyan
& bun test tests/unit/
if ($LASTEXITCODE -ne 0) { throw "unit tests failed" }

Write-Host "== [verify] integration tests ==" -ForegroundColor Cyan
& bun test tests/integration/
if ($LASTEXITCODE -ne 0) { throw "integration tests failed" }

Write-Host "== [verify] e2e + fault injection ==" -ForegroundColor Cyan
& bun test tests/e2e/
if ($LASTEXITCODE -ne 0) { throw "e2e tests failed" }

Write-Host "== [verify] smoke (real fixture completion) ==" -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke.ps1
if ($LASTEXITCODE -ne 0) { throw "smoke failed" }

Write-Host ""
Write-Host "== [verify] ALL GATES PASSED ==" -ForegroundColor Green
Pop-Location