# NAI HELLDESK: autonomous work, asynchronous steering

This local fork runs Kilo implementers against durable tasks, with independent machine review and rework. The operator can observe, talk to agents and redirect tasks without becoming a routine approval gate. Machine review never grants CTO production acceptance.

## Run today

From the repository root in PowerShell 7:

```powershell
pwsh -NoProfile -File .\scripts\launch-operator-console.ps1
```

The launcher builds the current UI, backs up the local daemon configuration, enables autonomous Kilo mutation and selects the existing Codex reviewer transport with `gpt-6-luna`. `-ReviewerModel` changes that explicit choice. It preserves provider/workspace settings and uses the current Kilo default model for implementation. The model must be available to the user's authenticated Codex CLI; no substitute is selected silently. No model job is submitted until there is work to execute.

Open `http://127.0.0.1:8790/helldesk/`. Create/select a department and workstation. In **Task Studio**, enter the input repository, optional output repository, full objective and acceptance requirements. Keep ExcellenceGovernor selected to run implementers and reviewers together. The prerequisite checklist creates real task dependencies; a failed prerequisite does not unlock consumers. Configured output repositories are writable destinations, not copies of the entire input tree.

In **Operator-console**, choose a crew member for a directed message or chat with the room. Steering is durable and applies at the next work/review boundary. “Queued” means queued, not read or obeyed. “Challenge it” and “Needs more work” feed the review loop. A direction nudge does not cancel work. Explicit cancellation remains a separate operation.

**ExcellenceGovernor** displays the local daemon's actual mission states. The NAI-Lattice canonical ExcellenceGovernor is a separate deployment; its verdict cannot stand in for these tasks. A machine-satisfied task is not customer or CTO acceptance.

## Connections and reload

**Connections** shows sanitized declarations from `kilo.json`, `kilo.jsonc`, configured plugins, and both `plugin/` and `plugins/` subdirectories. MCP command arguments, headers, credentials and environment values are not displayed. The user's actual plugin directory in this installation is singular `plugin/`.

Discovery runs at startup; **Reload connections** scans again. New writable Kilo sessions inherit the refreshed configuration, global instructions, default-agent prompt, permissions, MCP servers and plugins. Running sessions keep their existing modules. This avoids aborting work or falsely calling an in-process module replacement safe. Malformed configuration retains the last good in-process snapshot and reports errors. Explicit permission restrictions remain authoritative.

## Launcher lifecycle

```powershell
# Restart only processes whose identity was recorded by this launcher:
pwsh -NoProfile -File .\scripts\launch-operator-console.ps1 -Restart
# Stop only those owned processes:
pwsh -NoProfile -File .\scripts\launch-operator-console.ps1 -Stop
# Optional local checks; does not submit model work:
pwsh -NoProfile -File .\scripts\check-operator-console.ps1 -Build -Running
```

Logs and configuration backup: `scripts/logs/operator-console/`. Existing processes on occupied ports are reported, not killed by a broad process-name match. If an older launcher owns a server, close that launcher before starting this one. `-LatticeRoot` (or `NAI_LATTICE_ROOT`) selects the existing companion NAI-Lattice deployment. This checkout still depends on that companion client/runtime; it is not a standalone hosted service. Bun, Git, PowerShell 7, Kilo and authenticated Codex are prerequisites.

## Implementation changes and checks

- Replaced the old Git-prepare/commit-only dispatch with durable daemon missions.
- Removed whole-source recursive output copying and false success after dispatch/binding failures.
- Added per-task prerequisites, per-mission acceptance gates and bounded concurrent mission advancement.
- Preserved original objectives through asynchronous steering; changed objectives invalidate stale reviews.
- Added explicit connection discovery/reload and writable-session inheritance.
- Replaced application Lucide imports with a shared Tencent TDesign icon vocabulary. Fonts are locally bundled Manrope and JetBrains Mono; motion respects reduced-motion preferences.
- Added Operator-console participants, bounded event history, reconnect backoff, conversation/tool filters, visible failures and responsive task/dependency controls.

The UI build and both backend TypeScript checks completed. Focused configuration and dependency/reconciler fixtures were run without models. The full UI TypeScript check still reports inherited federated tRPC/shim typing errors; it is not reported as clean. The UI build also reports a large-chunk warning. No browser acceptance, week-long run, model generation, game extraction or external publication was performed for this delivery. Those results belong to the operator's run.

New mission submissions use durable idempotency keys: retrying a lost response returns the existing mission, while a changed payload under the same key is rejected. Legacy ambiguous submissions without a key still require reconciliation or explicit repair.

Icon source: [Tencent TDesign](https://github.com/Tencent/tdesign-icons), MIT. See `core/runtime/MISSION-BRIDGE.md` under `local-live` and `kilo-config-discovery.md` here for the implementation contracts.
