# CyberLuke Local HELLDESK

Native Windows adversarial review engine, the HELLDESK local tier of
`cyberluke/helldesk` (all Cloudflare / Kilo Cloud / Kilo Gateway dependencies
removed). A local orchestrator persists
durable review jobs in SQLite (WAL), builds immutable hashed Git / filesystem
snapshots, runs two independent adversarial reviewers plus a separate
adjudicator, and persists Markdown + JSON reports accessible from a localhost
HTTP API and the Kilo plugin.

No Docker, no WSL, no GitHub/GitLab/remote-repo dependency, no Kilo Gateway,
no Kilo Cloud account, no admin rights.

## Layout

```
services/helldesk/local/
  package.json        isolated production package (pinned deps)
  bun.lock            committed reproducible lockfile
  tsconfig.json
  config.example.json
  README.md
  src/                daemon (Bun) + engine (SQLite state machine)
    main.ts           localhost HTTP+WS server + supervision
    engine.ts         end-to-end review pipeline (A/B + adjudicator)
    snapshot.ts       immutable Git/FS review subjects
    state-machine.ts  transactional job transitions
    reconciler.ts     leases, retries, death recovery, breaker
    scheduler.ts      bounded dispatch / concurrency
    reviewers.ts      independent reviewers + JSON validation
    reports.ts        persisted Markdown + JSON
    api.ts            localhost HTTP JSON API
    cli.ts            programmatic historical review entry
    ...               config/db/jobs/schemas/inference etc.
  plugin/             real @kilocode/plugin entry point
    index.ts, client.ts, tools.ts, completion-detector.ts, kilo-runner.ts
  prompts/            reviewer-correctness.md, reviewer-adversarial.md, adjudicator.md
  tests/
    unit/             unit tests
    integration/      git & folder fixture tests
    e2e/              full-lifecycle + fault injection
  scripts/
    bootstrap.ps1     user-scoped setup (idempotent)
    start.ps1         start daemon
    verify.ps1        one reproducible verification
    smoke.ps1         fixture review -> persisted report
```

## Install / run

```
.\scripts\bootstrap.ps1     # idempotent, installs bun if missing, pins deps
.\scripts\start.ps1         # starts daemon on 127.0.0.1:4789 (singleton)
.\scripts\verify.ps1        # typecheck + unit + integration + e2e + smoke
.\scripts\smoke.ps1         # fixture review to a completed report
```

State lives in `%LOCALAPPDATA%\CyberLuke\LocalGasDepartment\` (db, snapshots,
reports, logs, per-user token). The daemon binds `127.0.0.1` only and requires
the local token for mutations.

## Config

See `config.example.json`. Key fields:

- `daemon.port` (default 4789), `daemon.maxConcurrentJobs`, `debounceMs`.
- `policy.runner`:
  - `kilo` (default) — reviewer sessions run over the in-process Kilo SDK in
    the plugin, using the user's effective provider/model. No Kilo Gateway.
  - `openai` — direct OpenAI-compatible endpoint (standalone daemon).
  - `fake` — deterministic canned reviewer (tests / smoke only).
- `policy.reviewerModel` — explicit `{providerID, modelID}` for reviewer
  sessions (overrides inheritance; never the developer session).
- `workspaces[]` — local roots to watch. Git optional.

## Kilo plugin — registration (supported discovery)

Kilo auto-discovers every `.ts` file in the user `plugin/` directory
(`~/.config/kilo/plugin/`). Register Local HELLDESK alongside the existing
`cyberluke-clean-system-prompt` without disturbing it:

```
.\scripts\install-plugin.ps1            # writes ~/.config/kilo/plugin/local-helldesk.ts
.\scripts\install-plugin.ps1 -Uninstall # removes only that shim
```

The installer writes a shim that re-exports the repo factory, never touches
`clean-system-prompt.ts`, and is reversible. Both plugins load with distinct
ids (`cyberluke-clean-system-prompt`, `cyberluke-local-helldesk`); the Local
HELLDESK plugin registers only `tool` + `event` hooks (plus `dispose`) and no
`chat.system.transform` / `chat.params`, so it cannot strip the `Hakakatoni
Ultra` persona or the prompt-cleanup plugin, and never touches the developer's
active session.

The plugin manages the daemon deterministically: it probes the configured
bind:port and **reuses** a reachable daemon (for `runner=openai|fake`), or
**self-hosts** one (HTTP + auto-dispatch pump) and tears it down on `dispose`.
For `runner=kilo` it always self-hosts so the reviewer sessions use this
plugin's own in-process Kilo `client` (real SDK path, never the Kilo Gateway).

The plugin registers `gt_local_status`, `gt_local_review`, `gt_local_report`,
`gt_local_findings`, `gt_local_rework`, observes session/file/git events
(debounced + deduped into one immutable review target per stable change), and
runs reviewers/adjudicator in **distinct** Kilo SDK sessions with read-only
evidence tools and a restricted tool allowlist (no edit/bash/web).

### Manual live-host verification checklist (operator)

Loading the plugin inside a **running** Kilo process is the final step and
cannot be automated from a build sandbox. When you next open VS Code:

1. Confirm Kilo reports both plugins loaded (ids `cyberluke-clean-system-prompt`
   and `cyberluke-local-helldesk`).
2. Confirm `Hakakatoni Ultra` still routes to the same model/provider and the
   clean-system-prompt behavior is unchanged (persona intact).
3. Confirm the reviewer model used is resolved correctly — the plugin does NOT
   decide by file timestamp. It uses a four-tier resolution: (1) explicit
   `policy.reviewerModel`, (2) the ACTUAL session-selected model observed via
   the `chat.message` hook for the triggering session, (3) the running host's
   merged effective global default via `client.config.get()`, and (4) otherwise
   FAILS CLOSED (never `code`/`kilo`/silent fallback). `kilo.json` and
   `kilo.jsonc` are deep-merged per Kilo's config precedence — not by
   LastWriteTime. Verify the resolved value in a `gt_local_status`-style log.
4. Let an agent finish a task; confirm `session.idle` auto-enqueues a review
   (daemon log `[local-helldesk] auto-enqueued review …`) and a `reports/<id>.json`
   appears.
5. Run `gt_local_status` inside the workspace to confirm the daemon is healthy
   and the job terminal state matches.
6. Sanity that reviewer A/B produced findings (or INCONCLUSIVE) and the source
   tree is unchanged (read-only confirmed visually).

These live-host checks are intentionally `NOT_RUN` in this build: they require
a running Kilo host, which is not available here, and are not simulated.

## API

```
GET  /health                          liveness/readiness/queue depth
GET  /v1/jobs                         list jobs
GET  /v1/jobs/:id                     job detail
GET  /v1/reports/:id                  persisted report JSON
GET  /v1/events                       event feed (WS at /v1/ws)
POST /v1/workspaces/register          register a local root
POST /v1/reviews                      enqueue a review (HEAD/commit/range/dirty/folder)
POST /v1/reviews/:id/retry            requeue an INCONCLUSIVE/failed job
POST /v1/jobs/:id/cancel              cancel a non-terminal job
```

Mutations require `Authorization: Bearer <token>`.

## Report

`%LOCALAPPDATA%\CyberLuke\LocalGasDepartment\reports\<job-id>.json` and `.md`.

## Troubleshooting

- `runner=kilo` without a live Kilo plugin host: the standalone daemon will
  print a clear error. Use `runner=openai`/`fake` for headless use, or run
  through the plugin.
- Multiple daemons: the singleton port lock in `start.ps1` refuses a second
  instance.
- Concurrent writers to one DB are avoided: only the plugin host (in VS Code)
  or the standalone daemon writes to the SQLite file at one time.