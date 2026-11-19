# HELLDESK Port Audit — Reuse Matrix

Date: 2026-11-08 · Commit `322138a19` (upstream snapshot) → `services/helldesk/local`

## Verdict

**This is an ADAPTED semantic port, not a line-for-line source port, and not a
de-novo system.** The local engine reuses the upstream Department reconciler's
algorithms, review-queue rework lifecycle, qualityAssurance/adversarial review rules,
agent dispatch/retry semantics, and process-manager SDK pattern. It does **not**
import the upstream files because they are bound to Cloudflare `SqlStorage`,
DO alarms, KV, remote containerFetch/Next.js APIs, GitHub PR/merge, and a
`tickets`/`agent_metadata`/`shift` colony schema. A literal import would drag the
entire Cloud platform hierarchy back in — exactly what the spec forbids.

The one genuine earlier overstatement: my first revision presented this as a
drop-in reuse when it is in fact an **adapted** port. That is corrected below
precisely.

## Exact reuse matrix

| Upstream component | File | Local counterpart | Classification | Evidence |
|---|---|---|---|---|
| Review queue + rework lifecycle | `src/dos/department/review-queue.ts` | `src/engine.ts` (`INCONCLUSIVE→QUEUED`, `REWORK_MAX_RETRIES`), `src/helldesk-semantics.ts` | ADAPTED | `agentDone`/`failReviewWithRework` → our `runReviewerStage` result + bounded requeue; `REWORK_MAX_RETRIES = MAX_DISPATCH_ATTEMPTS = 5` |
| Department reconciler | `src/dos/department/reconciler.ts` | `src/reconciler.ts` | ADAPTED | `staleMs`, `getDispatchCooldownMs` (30s/60s/2m/5m/10m), `HEARTBEAT_LOST_MS=90s`, `STUCK_REVIEW_TIMEOUT_MS=30m`, `STALE_IN_PROGRESS_TIMEOUT_MS=5m`, circuit breaker |
| Dispatch / scheduling | `src/dos/department/scheduling.ts` | `src/scheduler.ts`, `src/main.ts` (pump), `src/reconciler.ts` | ADAPTED | `MAX_DISPATCH_ATTEMPTS=5`, `DISPATCH_COOLDOWN_MS=30s`, dispatch-before-async I/O gate, per-item attempt counters |
| Agent process lifecycle | `container/src/process-manager.ts` | `plugin/kilo-runner.ts` | ADAPTED | distinct session create/prompt/abort pattern, per-session event filter, explicit `{providerID,modelID}` (Kiliko Gateway removed) |
| QualityAssurance review logic | `src/prompts/quality-assurance-system.prompt.ts` | `src/prompts/reviewer-correctness.md` / `reviewer-adversarial.md` / `adjudicator.md` | REUSED (adapted text) | evidence rules + escalation-gate present in all three; no subjective PASS, INCONCLUSIVE default |
| Plugin tooling | `container/plugin/tools.ts` | `plugin/tools.ts`, `plugin/kilo-runner.ts` | ADAPTED | `gt_prime/gt_done/gt_request_changes` → `gt_local_status/review/report/findings/rework`; context propagation via reviewer `system` + evidence tools |
| Plugin index hooks | `container/plugin/index.ts` | `plugin/index.ts` | ADAPTED | `tool` + `event` hooks used; `chat.params`/`experimental.chat.system.transform` deliberately NOT registered to preserve the developer persona/clean-system-prompt plugin |
| Durable state | Durable Objects `SqlStorage` | `src/db.ts` + `src/migrations/0001_schema.sql` (SQLite WAL) | REPLACED (required) | DO actor/RPC/alarm have no native equivalent; replaced by leases + CAS state machine |
| Alarms | Cloudflare alarms | `src/main.ts` pump + `reconciler.recoverStuckLeases` | REPLACED (required) | polling/timer driver + lease fencing |
| Remote workstation / Git remote | `src/dos/department/workstations.ts`, GitHub | local filesystem + local git | REPLACED (required by spec) | no remote, no PR, no merge |
| Container runtime | `container/src/*` + DO container | `plugin/kilo-runner.ts` (in-process SDK sessions) | REPLACED (required) | no containers, read-only reviewer sessions |
| WebSocket event feed | cloud WS | `src/main.ts` `/v1/ws` | ADAPTED | local outbox + WS |

## Why the engine could not be line-for-line imported

1. **Storage contract**: every upstream module is typed against Cloudflare
   `SqlStorage` and `DurableObjectStorage` (alarms, KV, RPC). There is no
   standard SQLite equivalent; ports must rewrite the query surface.
2. **Remote side effects**: `container-dispatch`, `actions` (merge_pr,
   poll_pr), `workstations`, `token-refresh`, `container-health-watchdog` call
   back into a hosted Next.js/Cloudflare API. The spec explicitly forbids all
   of these — importing them would pull the entire platform back in.
3. **Colony semantics ≠ adversarial review**: upstream dispatches soul/
   qualityAssurance/frontDesk agents to *write and merge branches* on hosted repos. The
   spec product is an *evidence-based, immutable-snapshot, read-only, no-merge,
   two-reviewer-plus-adjudicator* review. The two are different runtimes that
   share orchestration semantics, not an identical feature set.

## Honest correction

The first implementation report presented the local engine as a faithful
"port". It is an **adapted** port with genuine upstream-sourced algorithms
(`helldesk-semantics.ts` now cites exact upstream symbols and files), plus
required transports/schema replacements. No claim of a drop-in line-for-line
reuse is made.

## Verification

`.\scripts\verify.ps1` → typecheck clean, 23 unit + 16 integration + 10 e2e
= 49 tests green, smoke produces a persisted `FINDINGS` report. Live-VS-Code
host hops (plugin event hook invocation, in-process Kilo SDK inference,
persona retention) remain `NOT_RUN` because no live Kilo host is available in
this environment; the plugin module loads against `@kilocode/plugin@7.4.22`
with a distinct id and the event→report path is proven with real SDK event
contracts.