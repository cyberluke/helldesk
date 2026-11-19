# Environment Variables

Canonical environment variable catalog for the **HELLDESK** repo (`cyberluke/helldesk`). This file describes the environment consumed directly by this repository's code across its three execution homes:

- **Local control plane** (`services/helldesk/local`) — native Bun adversarial-review engine + Kilo plugin.
- **Local federated runtime / operator UI** (`services/helldesk/local-live`) — dual-home domain adapter + operator console.
- **Cloudflare Worker seat** (`services/helldesk/src` + `services/helldesk/container`) — optional second execution home.

Each value is tagged with its scope: `[SYSTEM]`, `[SERVER]`, `[PUBLIC]`, or `[SECRET]`. Secrets must never be committed in tracked files; examples use placeholder text.

> HELLDESK is local AI-first. Cloudflare is an optional seat. This catalog is authoritative for what this repository reads; runtime may depend on the configured runner/provider. Probe actual endpoints rather than assuming ports survive restarts.

---

## Local control plane (`services/helldesk/local`)

The local engine reads configuration from `config.json` and `process.env`. Environment generally overrides defaults; see `src/config-resolve.ts`.

### Core runtime

- `HELLDESK_CONTROL_URL` - Base URL of this local control-plane daemon. [SERVER]
- `HELLDESK_CONTROL_TOKEN` - Bearer/auth token for the local control-plane HTTP+WS API. `[SECRET]`
- `HELLDESK_DETACHED_WORKERS` - `true` to run review/mutation workers as detached child processes. [SERVER]
- `HELLDESK_PLUGIN_DIAG` - Enable verbose diagnostic logging in the Kilo plugin bridge. [SERVER]
- `GT_CONFIG` - Path to the runtime `config.json` (defaults to `<local>/config.json`). [SERVER]
- `GT_DATA_DIR` - Override the durable SQLite/data directory. [SERVER]
- `GT_DAEMON_URL` / `GT_DAEMON_TOKEN` - URL and token for an integrated NAI-Lattice daemon bridge. `[SERVER]` / `[SECRET]`
- `GT_BASE` - Base path/URL resolver for runner endpoints. [SERVER]
- `CODEX_BIN` - Path or name of the `codex` CLI binary for Codex mutation runs. [SERVER]
- `GIT_EXE` - Path or name of the git executable used for snapshots. [SERVER]
- `KILO_CONFIG_DIR` - Kilo configuration directory used for the plugin/agent discovery. [SERVER]
- `NAI_FABRIC_PIPE` - Named-pipe path for the canonical NAI-Lattice fabric host (when integrated). [SERVER]

### Mutation runner

- `GT_MUTATION_RUNNER` - Mutation exec engine (e.g. `kilo`, `codex`, or a configured endpoint). [SERVER]
- `GT_MUTATION_BASE_URL` - Base URL of the mutation execution endpoint. [SERVER]
- `GT_MUTATION_MODEL_ID` - Model identifier for mutation runs. [SERVER]
- `GT_MUTATION_PROVIDER_ID` - Provider identifier for mutation runs. [SERVER]
- `GT_MUTATION_API_KEY` - API key for the mutation endpoint. `[SECRET]`
- `GT_MUTATION_TIMEOUT_MS` - Mutation run timeout in milliseconds. [SERVER]

### Review runners

- `GT_REVIEW_RUNNER` - Review exec engine for adversarial reviewers. [SERVER]
- `GT_REVIEW_MODEL` / `GT_REVIEW_PROVIDER` - Model and provider for review runs. [SERVER]
- `GT_REVIEW_BASE` - Base URL for the review endpoint. [SERVER]

### Trace

- `GT_TRACE_BASE_URL` - Base URL for trace/span collection. [SERVER]
- `GT_TRACE_MODEL` / `GT_TRACE_PROVIDER` - Model and provider for trace classification. [SERVER]

### Task gates

- `GT_TASK_GATES` - Path to task-gate policy configuration. [SERVER]
- `GT_MAX_ADVANCES` - Maximum automatic convergence advances before a task is escalated. [SERVER]
- `GT_MISSION_WS` - WebSocket endpoint for mission lifecycle events. [SERVER]

### Codex test knobs

- `GT_CODEX_BIN` - Explicit Codex binary. [SERVER]
- `GT_CODEX_MODEL_ID` - Codex model for mutation runs. [SERVER]
- `GT_CODEX_TEST_MODEL` - Codex model used under test. [SERVER]
- `GT_CODEX_TEST_STRICT` - Strict-failure flag for Codex tests. [SERVER]
- `GT_CODEX_TIMEOUT_MS` - Codex run timeout in milliseconds. [SERVER]

---

## Local federated runtime / operator UI (`services/helldesk/local-live`)

- `HELLDESK_HOST` - Loopback host the local-live runtime binds (default `127.0.0.1`). [SERVER]
- `HELLDESK_PORT` - Port the local-live runtime binds. [SERVER]
- `HELLDESK_DATA_ROOT` - Data root for the federated runtime (SQLite + local storage). [SERVER]
- `HELLDESK_WORKSTATION_ID` - Workstation identifier used by the federated runtime. [SERVER]
- `HELLDESK_EXCELLENCE_GOVERNOR_URL` - Base URL of the Chief Excellence Officer / governor engine (default `http://127.0.0.1:8787/`). [SERVER]
- `HELLDESK_PTY_IDLE_MS` - Idle timeout for front-desk PTY sessions in milliseconds. [SERVER]
- `HELLDESK_CONTAINER_TOKEN` - Token used to authenticate container/remote execution context. `[SECRET]`
- `GIT_TOKEN` - Git token used by federation/engine operations. `[SECRET]`
- `NAI_LATTICE_HOST` / `NAI_LATTICE_PORT` - Host and port of the canonical NAI-Lattice fabric host (integrated engine). [SERVER]
- `BUN_RUNTIME_PATH` - Path to the Bun runtime (start/all script). [SERVER]

---

## Cloudflare Worker seat (`services/helldesk/src` + `services/helldesk/container`)

The Worker seat consumes environment/bindings from `wrangler.jsonc` and the deployed Service. Cloudflare-specific bindings (`HYPERDRIVE`, `AI`, `AGENT_DB_SNAPSHOTS_KV`, `GIT_TOKEN_SERVICE`, `CONTAINER_USAGE`, `HELLDESK_AE`) are platform bindings, not plain env; see `wrangler.jsonc`.

### Identity & auth

- `HELLDESK_DEPARTMENT_ID` - Unique identifier for a HELLDESK department (isolated environment/agent pool). [SERVER]
- `HELLDESK_WORKSTATION_ID` - Workstation (hardware profile) identifier for HELLDESK scheduling. [SERVER]
- `HELLDESK_AGENT_ID` - Unique identifier for an individual HELLDESK agent instance. [SERVER]
- `HELLDESK_AGENT_ROLE` - Role assigned to a HELLDESK agent (e.g. `coder`, `reviewer`). [SERVER]
- `HELLDESK_ORGANIZATION_ID` / `HELLDESK_ORG` - Organization ID associated with the HELLDESK department. [SERVER]
- `HELLDESK_USER` - Canonical user/agent identity used in Worker routes. [SERVER]
- `HELLDESK_JWT_SECRET` - Secret for HELLDESK JWT signing (department/workstation/container tokens). `[SECRET]`
- `HELLDESK_API_URL` - Base URL of the HELLDESK control API. [SERVER]
- `HELLDESK_SERVICE` - Service binding name for the HELLDESK Worker seat. [SERVER]
- `HELLDESK_SESSION_TOKEN` - Per-session auth token for HELLDESK. `[SECRET]`
- `HELLDESK_CONTAINER_TOKEN` - Token used for container/agent authentication; refreshed via `token-refresh.ts`. `[SECRET]`
- `HELLDESK_GIT_AUTHOR_NAME` / `HELLDESK_GIT_AUTHOR_EMAIL` - Git author identity used by agents for commits. [SERVER]

### Container process management

- `AGENT_IDLE_TIMEOUT_MS` - Timeout in ms before an idle HELLDESK agent is terminated; used in `container/src/process-manager.ts`. [SERVER]
- `QUALITY_ASSURANCE_IDLE_TIMEOUT_MS` - Timeout in ms before an idle QualityAssurance sub-process is killed; used in `container/src/process-manager.ts`. [SERVER]

### Integration & behavior

- `HELLDESK_BILLING_ENABLED` - Enables/exposes service integration gating. [SERVER]
- `HELLDESK_DISABLE_AI_COAUTHOR` - Disables AI co-author features. [SERVER]
- `KILOCODE_TOKEN` - Auth token for KiloCode/Session service identity. `[SECRET]`
- `KILO_API_URL` / `KILO_INTERNAL_API_URL` - Kilo API base URLs for integrated agent/gateway features. [SERVER]
- `KILO_ORG_ID` - Kilo organization identifier for integration. [SERVER]
- `KILO_CLI_PAT` / `KILOCODE_TOKEN` - PAT/token for CLI integration. `[SECRET]`
- `KILO_CONFIG_CONTENT` / `OPENCODE_CONFIG_CONTENT` - JSON/Toml/YAML config string injected into agent environments. [SERVER]
- `LEGACY_ADMIN_CLAIM_MODE` - Worker-side disposition of legacy `isAdmin` claims: `honor`, `observe`, or `reject`. [SERVER]
- `NEXTAUTH_SECRET` - Secret for NextAuth-style session/JWT validation. `[SECRET]`
- `INTERNAL_API_SECRET` - Shared secret for internal service calls. `[SECRET]`
- `SENTRY_DSN` / `SENTRY_RELEASE` - Sentry error reporting. `[SERVER]` / `[SERVER]`
- `NEXT_PUBLIC_POSTHOG_KEY` - PostHog public project key (public analytics). `[PUBLIC]`

---

## Shared / system

- `HOME` - User home directory; used by child processes and identity resolution. `[SYSTEM]`
- `PATH` - System executable search path. `[SYSTEM]`
- `LOCALAPPDATA` - Windows per-user application data; default location for the HELLDESK data root. `[SYSTEM]`
- `USERPROFILE` - Windows user profile directory. `[SYSTEM]`
- `KILO_CONFIG_DIR` - Kilo config directory used for plugin discovery. [SERVER]

---

## Conventions

- Prefer `config.json` and explicit env in the local engine; keep Cloudflare bindings in `wrangler.jsonc`.
- HeLLDESK data/auth values that are machine-specific or secret-bearing live out of the repo; `*.example` files document the shape with placeholder tokens.
- Never invent an environment contract. This catalog is derived from this repository's source (`services/helldesk/**`) and `wrangler.jsonc`. If a variable is referenced in code but missing here, add it; if it is listed here but no longer read, remove it.