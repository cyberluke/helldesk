# rename-polecat-to-soul.ps1 — reusable HELLDESK terminology rename.
#
# Renames the worker/developer agent terminology "Polecat" -> "Soul" (and the
# plural "Polecats" -> "Souls") across user-facing copy, comments, prompts, and
# the persisted config key / state identifiers that still carry the old term.
#
# Usage:  pwsh -File scripts\rename-polecat-to-soul.ps1 [-Scope <repo-root>]
#
# The scope defaults to the HELLDESK repository root (the directory containing
# services\helldesk + CONTEXT.md). Vendored/build/scratch directories are
# excluded so the tool never rewrites dependencies or derived artifacts.
#
# IMPORTANT (protocol boundary): this renames HELLDESK's own copy of the term
# only. The shared NAI-Lattice engine (D:\_SATIN_AI\NAI-Lattice) still uses the
# legacy "polecat" JSON-RPC role string in its own Rust runtime. Do NOT run this against the
# engine repo — that is a separate Don's protocol contract and is intentionally
# out of scope here.

param(
    [string]$Scope = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

$excludes = @(
    'node_modules', 'dist', '.git', '\.kilo', '\\.local', 'coverage',
    'dashboard.log', 'daemon.out.log', 'daemon.err.log', 'assets',
    '\\data\\department-', '\\data\\storage-', '\\data\\data\\'  # only actual store files
)

# ── 1. Specific, order-important identifier replacements (run FIRST so the
#    generic word pass below cannot re-touch them and so longer identifiers are
#    always final before the short-word pass). ────────────────────────────────
$specific = [ordered]@{
    'max_polecats_per_workstation' = 'max_souls_per_workstation'
    'max_concurrent_polecats'      = 'max_concurrent_souls'
    'setMaxPolecats'               = 'setMaxSouls'
    'maxPolecats'                  = 'maxSouls'
}

# ── 2. Generic word replacements (word-boundary safe). Plural first so the
#    singular pass never produces a stray plural. Case-sensitive passes. ──────
$generic = @(
    @('Polecats', 'Souls'),
    @('Polecat', 'Soul'),
    @('polecats', 'souls'),
    @('polecat', 'soul')
)

function Get-TargetFiles {
    param([string]$Root)
    Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch ($excludes -join '|') -and $_.Extension -in @('.ts', '.tsx', '.js', '.mjs', '.md', '.rs', '.hbs', '.html') }
}

function Apply-Renames {
    param([string]$Path)
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $orig = $text

    foreach ($k in $specific.Keys) {
        $text = $text.Replace($k, $specific[$k])
    }
    foreach ($pair in $generic) {
        $text = [regex]::Replace($text, ("\b{0}\b" -f [regex]::Escape($pair[0])), $pair[1])
    }

    if ($text -ne $orig) {
        # Preserve UTF-8 (no BOM) so TS/TSX/markdown stay clean.
        [System.IO.File]::WriteAllText((Resolve-Path -LiteralPath $Path),
            $text, (New-Object System.Text.UTF8Encoding($false)))
        return $true
    }
    return $false
}

$files = Get-TargetFiles -Root $Scope
$changed = @()
foreach ($f in $files) {
    if (Apply-Renames -Path $f.FullName) { $changed += $f.FullName }
}

Write-Output "renamed in $($changed.Count) file(s):"
$changed | ForEach-Object { Write-Output "  $_" }