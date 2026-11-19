# HELLDESK — autonomous code-delivery engine

HELLDESK is a provider-agnostic autonomous software delivery engine: a runtime
kanban that takes a task, runs a **writable mutation agent** to build a real
delta in a workspace (or cross-repo output), captures evidence, runs an
**independent review** over quality gates, and lands `VERIFIED_10_10` revisions —
or replans the next mutation against the real findings. It is built to ship
actual code, not to simulate productivity.

> **Reprocessing note.** HELLDESK is being renamed and will move to a new
> public remote. This README documents the engine as it exists today; branding,
> remote, and final naming land with the release instructions.

## What it does

- **Runtime kanban** over missions → tickets → revisions → evidence →
  review → `VERIFIED_10_10`. Each rejected revision carries a **truthful
  diagnosis** (no-change, empty-workspace, server-boot-timeout,
  review-reject, quality-gate-fail, transient) so the operator never guesses
  why the agent stalled.
- **Provider-agnostic engine matrix** — per-stage engine selection
  (`mutation` / `review` / `adjudicate`), each over `kilo` / `codex` / `openai`,
  UI-configurable as the department default and overridable per task.
- **Writable mutation actuators** that actually build deltas:
  - `kilo` — headless `@kilocode/sdk` session, with PATH/ENOENT hardening and
    fail-loud `kilo-binary-on-path` / `kilo-binary-enoent` diagnostics.
  - `openai` — a direct OpenAI-compatible `chat/completions` tool-driven
    actuator (list/read/write/run-shell/git-status confined to the workspace),
    auto-committing every delta so work is a durable revision.
  - `codex` — ChatGPT Codex CLI transport in an isolated child process.
- **Liveness & concurrency** — per-workspace fenced mutation-writer lease with
  heartbeat renewal and stale-lease reclaim; a 15-minute mutation watchdog and
  a 10-minute inference bound so a wedged agent can never strand a mission.
- **Live observability** — `GET /v1/missions/:id` reports `mutationActivity`
  (`working` / `stalled` / … , commits ahead, files touched, newest source file)
  so the operator-console sees what the agent is actually doing, not a blind
  `MUTATING` state.
- **Operator-console** — a federated Vite + React browser app (Task Studio,
  engine-matrix Settings, ticket board, topology, observability, agent terminal
  over PTY, memo, merges) plus the local-live runtime.

## Layout

```
services/helldesk/
  local/            native Bun control plane (missions, revisions, evidence,
                    review orchestras, engine matrix, liveness)
  local-live/       local runtime + operator-console UI (federated Vite app)
  container/        containerized runner adapters
  scripts/          daemon restarts + operator-console launchers
```

## Quick start (local-live)

```bash
# control plane
cd services/helldesk/local
bun install
bun run src/main.ts --daemon --config config.json

# operator-console UI
cd services/helldesk/local-live/ui
bun install
bun run dev            # TaskStudio at http://127.0.0.1:<port>

# or the one-shot daemons
../../scripts/start-all.ps1
```

See `docs/operator-console.md` and `services/helldesk/local/docs/kilo-config-discovery.md`
for the runtime wiring and kilo config discovery.

## Licensing

The public release is **AGPL-3.0-only** (`services/helldesk/local/LICENSE`).
Commercial / proprietary licensing and enterprise integration are available
separately — see `COMMERCIAL.md` (`satin@nanotrik.cz`).

## Roadmap / current state

- [x] Engine matrix (kilo / codex / openai) per stage, UI-configurable.
- [x] Real mutation actuators that commit durable deltas (openai auto-commit).
- [x] Truthful failure diagnosis + live `mutationActivity`.
- [x] Liveness: mutation watchdog, inference bound, lease heartbeat + reclaim.
- [x] Operator-console UI (federated, typechecks clean).
- [ ] Final naming / branding / public remote (in progress, per release instructions).
- [ ] Full end-to-end valve test on a fresh machine (no pre-seeded state).
- [ ] Screenshots + annotated setup for the public README.