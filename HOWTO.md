# HELLDESK runtime HOWTO

Everything you need to start, inspect, and stop the local infrastructure — production
and isolated benchmark runs — without guessing ports or killing the wrong process.

> **Process rule (enforced by the scripts):** a process is signalled only if its PID
> comes from an instance pidfile **and** its live command line still matches. Never use
> `Get-Process kilo | Stop-Process`, `taskkill /IM`, or any image-name scan — the VS Code
> extension owns `kilo.exe` sessions that are not HELLDESK's.

---

## 0. Prerequisites

| Need | Check |
|---|---|
| Windows 10/11 + PowerShell 7 | `pwsh --version` |
| Bun | `bun --version` |
| Git | `git --version` |
| BrowserOS Neo (visual gates) | MCP listening on `127.0.0.1:9210` (override with `HELLDESK_BROWSEROS_MCP_URL`) |
| A Kilo provider/model | the engine resolves the Kilo CLI; no silent fallback if missing |

Ports used by default: control plane **4790**, Operator Console **8790** (`/helldesk/`),
NAI fabric host **8787** (optional), BrowserOS MCP **9210**. Isolated runs choose their
own control port (e.g. 4817) and dashboard port (e.g. 8792).

---

## 1. Production stack (the normal way)

One-time install (dependencies, UI build, user-level logon services, Start Menu shortcut):

```powershell
scripts\install.cmd
```

Start / inspect / stop:

```powershell
scripts\start.cmd            # attach if already up, otherwise launch; opens the Operator Console
scripts\start.cmd -Status    # what is running
scripts\start.cmd -Stop      # stop the stack
```

URLs: control plane `http://127.0.0.1:4790/health` · Operator Console
`http://127.0.0.1:8790/helldesk/`.

Developer alternative (no installed services, logs under `scripts\logs\`):

```powershell
scripts\start-all.ps1                 # local + local-live (+ NAI host if NAI_LATTICE_ROOT is set)
scripts\start-all.ps1 -Service local  # just the control plane
scripts\start-all.ps1 -Stop
```

If the console is not installed, `scripts\start.ps1` falls back to the documented hidden
launchers and still writes pidfiles.

---

## 2. Isolated benchmark run (never touches production)

```powershell
$run = "$env:LOCALAPPDATA\HELLDESK\bench\m6x"

# 1. Prepare a blind workspace + config (refuses while another instance owns a
#    benchmark mission; the workspace lives OUTSIDE the repository).
pwsh -File benchmarks\m6\prepare-run.ps1 -RunId m6x -Port 4817 -Root $run

# 2. Start the control plane (product launcher, hidden, pidfile in $run\live-data).
pwsh -File services\helldesk\local\scripts\start.ps1 -Config "$run\live.config.json"

# 3. Start the dashboard for that instance (optional; pidfile + meta).
pwsh -File services\helldesk\local-live\scripts\launch-dashboard-hidden.ps1 `
  -Root services\helldesk\local-live -Port 8792 `
  -ControlConfig "$run\live.config.json" `
  -DataRoot "$run\local-live" `
  -PidFile "$run\dashboard.pid"
```

Register the workspace and dispatch the mission through the control plane (bearer token
is generated in `$run\live-data\token`):

```powershell
$token = (Get-Content "$run\live-data\token" -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }

$ws = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4817/v1/workspaces/register `
  -Headers $headers -ContentType application/json `
  -Body (@{ path = "$run\live-workspace" } | ConvertTo-Json)
$ws.workspace.workspaceId

# put that workspaceId into $run\mission.request.json, then:
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4817/v1/missions `
  -Headers $headers -ContentType application/json `
  -Body (Get-Content "$run\mission.request.json" -Raw)
```

The mission runs autonomously: mutation → host gates (BrowserOS, real screenshots) →
A/B reviewers + adjudicator. Progress:

```powershell
Invoke-RestMethod http://127.0.0.1:4817/health
# dashboard: http://127.0.0.1:8792/helldesk/
# sqlite:    "$run\live-data\helldesk.db"
```

Export and audit the evidence (offline, content-addressed):

```powershell
bun run benchmarks\m6\export-evidence.ts --db "$run\live-data\helldesk.db" `
  --run-id m6x --workspace "$run\live-workspace" --out benchmarks\m6\evidence\m6x
bun run benchmarks\m6\verify-bundle.ts benchmarks\m6\evidence\m6x
# integrity PASS + certification VALID -> exit 0; a finding bundle exits 1, never lies.
```

Stop **exactly** this run (dry-run first if unsure):

```powershell
pwsh -File services\helldesk\local\scripts\stop-daemon.ps1 -Config "$run\live.config.json" -DryRun
pwsh -File services\helldesk\local\scripts\stop-daemon.ps1 -Config "$run\live.config.json"
pwsh -File services\helldesk\local-live\scripts\stop-dashboard.ps1 -PidFile "$run\dashboard.pid"
```

`-Config` may be relative or absolute; identity checks use the resolved absolute path.

---

## 3. Visual fixture and screenshots (optional)

The visual gates build and serve their own candidate copy; you only need the dev server
for manual captures or for the broken-state screenshot:

```powershell
cd benchmarks\v0\visual-fixture
bun install                                   # once
bun run dev -- --host 127.0.0.1 --port 5274 --strictPort

# from the repository root, in another shell:
bun run benchmarks\m6\capture-broken.ts       # 460x460 broken stage -> benchmarks\m6\media\broken-stage.png
```

The broken/fixed pair in `benchmarks/m6/media/` was produced this way and through the
run L gate (both 460x460 at the declared 1280x720 / DPR-1 geometry).

Regenerate the protected golden (fixed render) through the same BrowserOS path:

```powershell
bun run benchmarks\v0\visual-fixture\scripts\capture-golden.ts
```

The gate keeps BrowserOS in the background: it creates a tab, pins the viewport, and
captures via CDP — it never calls `bringToFront`, so your window is not maximized or
stolen.

---

## 4. Where things live

| Item | Path |
|---|---|
| Production data / DB / token | `%LOCALAPPDATA%\HELLDESK\LocalDepartment\` |
| Production daemon logs | `services\helldesk\local\daemon.out.log`, `daemon.err.log` |
| Production dashboard pidfile | `services\helldesk\local-live\dashboard.pid` |
| Developer stack logs | `scripts\logs\` |
| Isolated run | `%LOCALAPPDATA%\HELLDESK\bench\<run>\` (workspace, data, logs, pidfiles) |
| Evidence bundles | `benchmarks\m6\evidence\<run>\` (`bundle.json` + `artifacts/`) |
| Offline verifier | `benchmarks\m6\verify-bundle.ts` |
| M6 run record | `benchmarks\m6\README.md` |

---

## 5. Troubleshooting

**"already running (lock held)"** — use `scripts\start.ps1 -Status` or
`stop-daemon.ps1 -Config <that config>`. Do not delete the lock blindly.

**A port is busy** — find the exact owner, then stop it through its instance pidfile:

```powershell
Get-NetTCPConnection -LocalPort 4817 -State Listen | Select-Object OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select-Object CommandLine
```

If it is a benchmark/stray instance, its pidfile is in that run's `live-data`
(control plane) or run root (dashboard). If the pidfile is gone, create a temporary
pidfile for the verified PID and use `stop-dashboard.ps1` / `stop-daemon.ps1`; the
scripts refuse a command line that does not match.

**Health timeout after start** — read `services\helldesk\local\daemon.err.log` (or the
run's logs). Common causes: port already bound by a zombie, a config/provider error,
or the data directory not writable.

**BrowserOS gate fails / wedges** — confirm BrowserOS Neo is running and the MCP URL is
reachable (`127.0.0.1:9210`). The gate captures a background tab; if the page was never
loaded, check the gate's `stdout.log` under the run's `live-data\gate-runs\`.

**No model/provider** — the engine fails closed and reports it; set the provider/model
in the config or the effective Kilo provider configuration. There is no silent fallback.

**A stop script refuses a PID** — that is the PID-reuse guard working. Inspect the
command line it prints; do not force-kill an unverified PID.
