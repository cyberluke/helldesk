# Plan: Full HELLDESK → Local Port (AAF-federated, keep NAI ExcellenceGovernor, add NAI Lattice)

Objective: give the user the **full HELLDESK Cloudflare experience locally** in
`C:\src\kilo-helldesk-local\services\helldesk`, **not** a partial NAI-excellence-governor-only
dashboard. Keep the NAI ExcellenceGovernor dashboard (`:8787`) as the UI. Federate —
do not rewrite — the entire Cloudflare HELLDESK domain (`services/helldesk/src`).
Build only the missing runtime delta.

## AAF principle applied
- **Discover / Federate:** `services/helldesk/src` already contains the complete HELLDESK
  domain (Department DO, Agent DO, workstations, shifts, tickets, scheduling, attendance, review-queue,
  triage, memo, escalations, container dispatch, billing, prompts). Do NOT re-implement it.
- **Build only the delta:** a local Cloudflare-Worker **runtime adapter** (SqlStorage→
  bun:sqlite, `DurableObject`/alarm shim, env bindings) + a Bun HTTP entry that mounts
  the existing Hono worker + DOs. NAI ExcellenceGovernor stays the dashboard. NAI Lattice is
  federated via the published NAI-Lattice client dependency.
- **Revalidate:** the `local/` orchestrator currently duplicates a slice of this. It is
  kept as the introspection/QA/mission runner, then overlaid (review-queue/scheduling
  are already department-DO concepts in Cloudflare) rather than duplicated further.

## Verified facts (this session)
- `:8787` = NAI ExcellenceGovernor dashboard (Cloudflare shift backend) — ALIVE, one-stop token baked in.
- This repo's `local` engine (configured port, runner=kilo with the effective `kilo.jsonc` model) is DOWN.
- `services/helldesk/src` = the full Cloudflare HELLDESK (Hono worker + 6 DOs + handlers + prompts + billing).
- Domain code depends on `cloudflare:workers` `DurableObject`, `SqlStorage.exec`, env bindings,
  `@sentry/cloudflare`, `@kilocode/worker-utils`, `drizzle` table interpolators, `hono`, `@trpc/server`.
- `query.util.ts` = thin `sql.exec(query, ...params)` wrapper → the whole adapter surface is `SqlStorage`.
- `local/package.json` depends on the published NAI-Lattice client (`^0.2.0`); the vendored copy under
  `services/helldesk/vendor/` remains an optional offline fallback.

## Milestone 1 (this build) — Local HELLDESK via federated handlers + local runtime
Bring the REAL HELLDESK up locally on a native Bun server, no Cloudflare, no `wrangler`,
NO billing, NO Sentry, no auth on localhost.

**Corrected AAF strategy (verified this session):** the 26 `handlers/*` and 28 `dos/department/*`
modules are plain functions over `SqlStorage` + args and import NO CF-only code. The CF-specific
surface is confined to `helldesk.worker.ts` (auth/Sentry/Container/WS shell) + the DO *class
shells* (`Department.do.ts`, `DepartmentContainer.do.ts`). So we FEDERATE the handlers + department submodules
verbatim and build a thin local worker + local Department proxy (implementing just the ~25 methods the
handlers/stub surface actually call, delegating to the SAME submodules over a local SqlStorage).

1. **`local-live/` Bun package** (self-contained; deps: hono, @trpc/server, drizzle-orm, jose,
   zod, the published NAI-Lattice client). No monorepo workspace install — Bun resolves these directly from npm.
2. **Vendored local shims** under `local-live/vendor/`:
   - `@sentry/cloudflare` → `withSentry(cfg, handlers) => handlers`, `captureException` no-op.
   - `@kilocode/worker-utils` subpaths actually imported (kilo-token, auth-middleware,
     worker-admin-capability/actions, git-url, direct-byok-model, internal-service-token-audiences,
     cf-access, root res/extractBearerToken/signKiloToken/withDORetry) — **dev-auth**, no real JWT.
   - `@kilocode/db` + `@kilocode/container-usage` are NOT needed (billing excluded; only referenced
     by billing modules we do not mount).
3. **`local-live/src/runtime/sql.ts`** — `SqlStorage`-compatible impl on `bun:sqlite`
   (`.exec()` cursor with `toArray/raw/next/meta`), one DB file per department/agent id under `data/`.
   Mirrors `util/query.util` contract exactly.
4. **`local-live/src/runtime/do.ts`** — DO runtime: `env.department.get(idFromName(id))` returns a proxy
   whose methods delegate to a local Department instance built from the `dos/department/*` submodules + the
   `db/tables` interpolators (pk: reuse `scm`? not needed). Bridges `ctx.storage` for alarms.
5. **`local-live/src/local-worker.ts`** — Bun `serve`: re-register the concrete HELLDESK routes
   (workstations/tickets/agents/shifts/memo/triage/escalations/events/department-config/users/departments) exactly as
   `helldesk.worker.ts` wires them (extract the route list, reuse each handler fn). Dev-auth: a
   fixed bearer token (reuse the NAI ExcellenceGovernor in-page token as default, overridable) — localhost.
6. **NAI Lattice federation** — `NafClient` provided for token/secret + optional per-user pipe;
   token prefilled from the dashboard page default. Storage/secrets go through NAF when Lattice
   is up; file fallback otherwise.
7. **Dashboard** — serve the NAI ExcellenceGovernor HTML (the live `:8787` page source) so the single-user
   one-stop look persists.

Acceptance (M1): `bun run` in `local-live` starts a server; a real Department is created; `GET
/api/departments/:id/dashboard|workstations|tickets|shifts` returns data; the NAI ExcellenceGovernor UI loads and drives
create-ticket + dispatch; no billing/Sentry/auth required. Verify with the existing `test/unit`
submodule tests where they are substrate-free, plus a local smoke.

## Milestone 2 — Reconcile the split-brain orchestrators
- Evaluate whether `local/src/mission-controller.ts` + `/v1/missions` should be re-homed onto
  the local department-DO's real `review-queue`/`scheduling` (Cloudflare native) instead of the
  hand-rolled mission row. Per AAF: reuse the department-DO path; keep only the genuinely-missing
  delta (a local "give me a real task from NAI ExcellenceGovernor" driver).
- Remove/retire duplicates once a capability overlap is proven (AAF revalidate).

## Milestone 3 — Container agents locally
- `container/` runs soul/qualityAssurance in Docker already; ensure it works against the local
  worker mount (control-server ↔ Department DO control plane via in-process or HTTP), so the full
  agent dispatch/execution/review loop runs locally end-to-end.

## Risks / decisions to confirm with the operator
- `@sentry/cloudflare` import: needs a stub or `withSentry` passthrough locally.
- Auth (`@kilocode/worker-utils/kilo-auth`, JWT, CF Access): local dev auth enabled via a
  dev token (the same `a9793aad…`-style in-page token), cloud checks strangled.
- Billing / cloud-only containers: local fallback or explicitly marked NOT_RUN.
- The published NAI-Lattice client (NAF) is consumed from npm at `^0.2.0`; verify the registry tarball on a
  clean install. The vendored 0.2.0 copy remains an offline fallback.