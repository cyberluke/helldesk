#!/usr/bin/env bash
# Reusable: start all HELLDESK / NAI-Lattice runtimes (Windows .ps1 does the real
# work; this delegates so `./scripts/start-all.sh` is a single call from bash).
# Uses the Windows PowerShell launcher since bun/cargo/pwsh are the local runtimes.
# Usage: ./scripts/start-all.sh [-stop]
set -euo pipefail
ARGS=()
[[ "${1:-}" == "-stop" ]] && ARGS+=("-Stop")
powershell -ExecutionPolicy Bypass -File "$(dirname "$0")/start-all.ps1" "${ARGS[@]}"