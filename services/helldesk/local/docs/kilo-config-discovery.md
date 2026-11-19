# Kilo configuration discovery and session refresh

The local-live server scans on startup and exposes `GET /api/kilo/config` and `POST /api/kilo/config/reload`. Reload reads metadata only: it does not import plugins, start MCP services, invoke a model, restart agents or write the user's configuration.

Sources are `~/.config/kilo/kilo.json`, then `kilo.jsonc`, then the same files under `KILO_CONFIG_DIR` when configured. Object values merge; later arrays replace earlier arrays. Plugin references resolve relative to their declaring configuration directory. Both `plugin/` and `plugins/` are enumerated. Directory entries are metadata only and are never injected into the explicit plugin list. Kilo retains ownership of its native directory loading, avoiding duplicate hook registration. Modules outside native discovery must be explicitly configured; nested helper modules are not independently imported. Discovery is bounded and excludes dependency/test/build trees and symlinks.

The public response contains model route, provider names, MCP names/types/enabled states, source paths, plugin paths/hashes and sanitized errors. It never includes provider options, MCP commands/arguments, environment values, headers or raw configuration. Plugin URL credentials, queries and fragments are not exposed. `ready` means configuration discovery succeeded, not that every provider or MCP server was contacted and proved healthy.

Writable `KiloMutationRunner` sessions reread configuration before starting each turn and inherit MCP, plugin files, provider definitions, global instructions and the selected default agent's prompt/permissions. Operator permission overrides remain authoritative. The global model route is re-resolved per invocation. A malformed reload retains the last valid in-process configuration; a bad initial configuration blocks a new session with an explicit error. Running sessions keep their already-loaded modules. This is safe next-session refresh, not JavaScript module hot replacement inside an active model turn.

Independent reviewers retain their read-only boundary. Discovery does not grant them mutation/MCP tools and does not replace their explicitly configured review model. Explicitly configured npm plugins are not installed by discovery; the Kilo runtime handles its normal plugin resolution when a session starts.

Run parser/discovery checks without any model call:

```powershell
Set-Location C:\src\kilo-helldesk-local\services\helldesk\local
bun test tests/unit/config-discovery.test.ts
```

Operational acceptance remains the operator's decision. The checks cover JSONC comments/trailing commas, merge pollution rejection, both directory spellings, secret redaction and last-known-good retention.
