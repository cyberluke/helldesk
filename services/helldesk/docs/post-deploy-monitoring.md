# Post-Deploy Department Health Monitoring

Guide for an AI agent to verify department health after a production deploy.

## Prerequisites

- The debug endpoint is deployed: `GET /debug/departments/:departmentId/status`
- The debug endpoint is protected by Cloudflare Access. Requests must include service token headers.
- Base URL: `https://helldesk.kiloapps.io`
- Department ID: obtain from `GET /trpc/helldesk.listOrgDepartments` (requires auth) or from the user

### Authentication

The debug endpoint requires Cloudflare Access service token headers. These are the same credentials the Next.js app uses to communicate with helldesk:

```bash
# Set these from your Cloudflare Access service token
export CF_ACCESS_CLIENT_ID="<service-token-client-id>"
export CF_ACCESS_CLIENT_SECRET="<service-token-client-secret>"
```

For querying Cloudflare logs and Analytics Engine, you also need:

```bash
# Cloudflare API token with Workers Observability + Analytics Engine read permissions
export HELLDESK_CF_ANALYTICS_API_KEY="<api-token>"
# Cloudflare account ID (found at: Workers & Pages → Overview, right sidebar)
export CF_ACCOUNT_ID="<account-id>"
```

All `curl` commands in this document use a helper function that includes these headers:

```bash
debug_curl() {
  curl -s \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    "$@"
}
```

## 1. Monitor Script

The monitoring script at `scripts/monitor-department.sh` polls the debug endpoint:

```bash
export CF_ACCESS_CLIENT_ID="<client-id>"
export CF_ACCESS_CLIENT_SECRET="<client-secret>"
./scripts/monitor-department.sh <departmentId> [interval_seconds]
```

Or poll manually:

```bash
debug_curl "https://helldesk.kiloapps.io/debug/departments/$DEPARTMENT_ID/status" | python3 -c "
import sys, json
d = json.load(sys.stdin)
a = d['alarmStatus']
print(f\"Working: {a['agents']['working']}  Idle: {a['agents']['idle']}\")
print(f\"open: {a['tickets']['open']}  inProgress: {a['tickets']['inProgress']}  inReview: {a['tickets']['inReview']}\")
ref = [x for x in d['agentMeta'] if x.get('role') == 'qualityAssurance']
if ref:
    r = ref[0]
    print(f\"QualityAssurance: status={r['status']} hook={r.get('current_hook_ticket_id') or 'NULL'}\")
recon = a.get('reconciler')
if recon:
    print(f\"Reconciler: events={recon['eventsDrained']} actions={recon['actionsEmitted']} violations={recon['invariantViolations']} wallMs={recon['wallClockMs']}\")
for e in a.get('recentEvents', [])[:5]:
    print(f\"  {e['time'][:19]}  {e['message'][:80]}\")
"
```

## 2. Post-Deploy Health Checks

After `pnpm deploy:prod`, verify these in order:

### Phase 1: DO Reset (0-30s)

The Durable Object reinitializes. Check the alarm is running:

```bash
# Alarm should show 'active (5s)' within 10s of deploy
debug_curl "https://helldesk.kiloapps.io/debug/departments/$DEPARTMENT_ID/status" | python3 -c "
import sys, json; d = json.load(sys.stdin)
print(d['alarmStatus']['alarm']['intervalLabel'])
"
```

**Expected**: `active (5s)` or `idle (60s)`

### Phase 2: Container Restart (30s-3min)

The container is evicted and a new one starts. The `ensureFrontDesk` tRPC call can kick-start it:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"departmentId\":\"$DEPARTMENT_ID\"}" \
  "https://helldesk.kiloapps.io/trpc/helldesk.ensureFrontDesk"
```

Poll until agents start working:

```bash
# Should see Working > 0 within 2-3 min
debug_curl "https://helldesk.kiloapps.io/debug/departments/$DEPARTMENT_ID/status" | python3 -c "
import sys, json; d = json.load(sys.stdin)
print(f\"Working: {d['alarmStatus']['agents']['working']}\")
"
```

### Phase 3: Agent Recovery (1-5min)

Verify agents recover from the container restart. The reconciler handles all recovery:

- **Souls**: idle+hooked agents are re-dispatched by `reconcileTickets` Rule 2
- **QualityAssurance**: if it was mid-review, the container status observation detects the dead container and sets the qualityAssurance to idle. `reconcileReviewQueue` Rule 6 re-dispatches it.
- **Orphaned tickets**: `reconcileTickets` Rule 3 resets in-progress tickets with no working agent to open after 5 min, then Rule 1 assigns a new agent.

**Red flags**:

- `Working: 0` for more than 5 min after container is active
- `invariantViolations > 0` in reconciler metrics
- `failed` count increasing rapidly (dispatch attempts burning out)

### Phase 4: Review Pipeline (5-15min)

Watch for a full review cycle:

```
in_progress → in_review → review_completed → closed
```

Check that:

- The qualityAssurance picks up MR tickets (status transitions to `working`)
- Reviews complete as `merged` (not `QualityAssurance container failed to start`)
- Source tickets reach `closed` and stay closed

### Phase 5: Reconciler Health

Verify the reconciler is running correctly:

```bash
debug_curl "https://helldesk.kiloapps.io/debug/departments/$DEPARTMENT_ID/status" | python3 -c "
import sys, json; d = json.load(sys.stdin)
r = d['alarmStatus'].get('reconciler')
if r:
    print(f\"Events drained: {r['eventsDrained']}\")
    print(f\"Actions emitted: {r['actionsEmitted']}\")
    print(f\"Invariant violations: {r['invariantViolations']}\")
    print(f\"Wall clock: {r['wallClockMs']}ms\")
    print(f\"Pending events: {r['pendingEventCount']}\")
    if r.get('actionsByType'):
        print(f\"Action types: {r['actionsByType']}\")
else:
    print('No reconciler metrics yet')
"
```

**Expected**: `invariantViolations: 0`, `wallClockMs < 100`, `pendingEventCount: 0`

## 3. Test Shift

Create a simple test shift to verify the full pipeline. Use the tRPC `slingShift` endpoint:

```bash
TOKEN="<bearer-token>"
DEPARTMENT_ID="<department-id>"
WORKSTATION_ID="<workstation-id>"

# Create a 2-ticket test shift
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"workstationId\": \"$WORKSTATION_ID\",
    \"shiftTitle\": \"Post-deploy health check $(date -u +%H:%M)\",
    \"tasks\": [
      {\"title\": \"Update README with current timestamp (pass 1 of 2)\"},
      {\"title\": \"Update README with current timestamp (pass 2 of 2)\"}
    ]
  }" \
  "https://helldesk.kiloapps.io/trpc/helldesk.slingShift"
```

Then monitor until both tickets reach `closed`:

```bash
# Poll every 30s until no non-terminal issue tickets remain
while true; do
  RESP=$(debug_curl "https://helldesk.kiloapps.io/debug/departments/$DEPARTMENT_ID/status")
  ISSUES=$(echo "$RESP" | python3 -c "
import sys, json
tickets = json.load(sys.stdin).get('ticketSummary', [])
issues = [b for b in tickets if b.get('type') == 'issue']
print(len(issues))
for b in issues:
    print(f\"  {b['status']:12s} {b.get('title','')[:60]}\")
")
  echo "$(date -u +%H:%M:%S) Non-terminal issues: $ISSUES"
  # Exit when 0 non-terminal issues
  echo "$ISSUES" | head -1 | grep -q "^0$" && echo "All tickets closed!" && break
  sleep 30
done
```

**Expected timeline**:

- 0-2 min: tickets created, souls dispatched by reconciler (lazy assignment)
- 2-10 min: souls work, submit reviews
- 10-15 min: qualityAssurance reviews and merges
- 15-25 min: second ticket goes through the same cycle
- 25-30 min: shift lands (all tickets closed)

**Failure indicators**:

- Tickets stuck in `open` for >5 min → check reconciler actions (should emit `dispatch_agent`)
- Tickets stuck in `in_review` for >15 min → check qualityAssurance status and MR tickets
- MR tickets stuck in `in_progress` for >5 min → check qualityAssurance dispatch retry
- Tickets cycling `in_progress → open` → check `agentCompleted` events and STALE_IN_PROGRESS_TIMEOUT_MS
- Reviews completing as `failed` → check container start errors on qualityAssurance agent status message

## 4. Cleanup

After monitoring is complete, clean up test tickets.

### Remove test shift tickets

```bash
# Get all tickets for the workstation
tickets=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://helldesk.kiloapps.io/trpc/helldesk.listTickets?input=$(python3 -c \
  'import json,urllib.parse; print(urllib.parse.quote(json.dumps({"workstationId":"'$WORKSTATION_ID'"})))')")

# Find and delete test shift tickets (match by title prefix)
echo "$tickets" | python3 -c "
import sys, json
data = json.load(sys.stdin)['result']['data']
for b in data:
    title = b.get('title', '')
    if 'Post-deploy health check' in title or 'Update README with current timestamp' in title:
        print(b['ticket_id'])
" | while read TICKET_ID; do
  curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"workstationId\":\"$WORKSTATION_ID\",\"ticketId\":\"$TICKET_ID\"}" \
    "https://helldesk.kiloapps.io/trpc/helldesk.deleteTicket"
  echo "Deleted $TICKET_ID"
done
```

## 5. Key Metrics to Watch

| Metric | Healthy | Unhealthy |
|---|---|---|
| Working agents | >0 when tickets exist | 0 for >5 min with open tickets |
| Failed ticket count | Stable | Increasing rapidly |
| Invariant violations | 0 | >0 (check reconciler logs) |
| QualityAssurance status | `working` during review, `idle` between | `idle` with in_progress MR for >5 min |
| Review outcomes | `merged` | `QualityAssurance container failed to start` |
| Alarm interval | `active (5s)` with work | Stuck at same `nextFireAt` |
| Reconciler wall clock | <100ms | >500ms consistently |
| Pending event count | 0 between ticks | Growing (events not draining) |

## 6. Querying Cloudflare Logs (Workers Observability)

Workers Observability is enabled at 100% sampling (`wrangler.jsonc` → `observability`). All `console.log/warn/error` output is indexed and searchable via the Cloudflare API. Key log lines emit structured JSON with `departmentId`, `workstationId`, `userId`, `orgId`, and `agentId` fields for filtering.

### Log Query Script

The `scripts/query-logs.sh` script wraps the Workers Observability and Analytics Engine APIs:

```bash
export HELLDESK_CF_ANALYTICS_API_KEY="<api-token>"
export CF_ACCOUNT_ID="<account-id>"

# Fetch recent logs mentioning a department (last 30 min by default)
./scripts/query-logs.sh logs <departmentId> [minutes]

# Fetch only errors/warnings for a department
./scripts/query-logs.sh errors <departmentId> [minutes]

# Query Analytics Engine events for a department
./scripts/query-logs.sh ae-events <departmentId> [hours]

# Query reconciler tick metrics from Analytics Engine
./scripts/query-logs.sh ae-reconciler <departmentId> [hours]
```

### Manual Log Queries

Query the Workers Observability API directly. The structured logs use JSON format with fields like `departmentId`, `workstationId`, `userId`, `orgId`, `agentId`:

```bash
# Search for all logs mentioning a specific department in the last hour
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/observability/telemetry/query" \
  -H "Authorization: Bearer $HELLDESK_CF_ANALYTICS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "queryId": "",
    "timeframe": { "from": '$(($(date +%s) - 3600))'000, "to": '$(date +%s)'000 },
    "limit": 50,
    "view": "events",
    "parameters": {
      "datasets": ["helldesk"],
      "calculations": [{ "operator": "count" }],
      "filters": [
        { "key": "message", "operation": "contains", "value": "'$DEPARTMENT_ID'", "type": "string" }
      ],
      "orderBy": { "value": "timestamp", "order": "desc" }
    }
  }' | python3 -c "
import sys, json
data = json.load(sys.stdin)
for ds, evts in data.get('result',{}).get('events',{}).items():
    for e in evts:
        ts = e.get('timestamp','')
        msg = e.get('message','')[:200]
        level = e.get('level','info')
        print(f'{ts}  [{level}]  {msg}')
"
```

### Useful search patterns

Since the structured logs are JSON, you can search for specific fields:

- **All errors for a department**: filter `message contains "<departmentId>"` + `level in ["error","warn"]`
- **FrontDesk session issues**: search for `"ensureFrontDesk"` or `"sendFrontDeskMessage"` in message
- **Workstation configuration**: search for `"configureWorkstation"` in message
- **Reconciler problems**: search for `"reconciler"` + `level = "error"`
- **Container dispatch failures**: search for `"startAgentInContainer"` + `level = "error"`
- **Git credential issues**: search for `"git credential"` or `"refreshGitCredentials"` in message
- **Workstation repo setup failures (container)**: search for `"/repos/setup: FAILED"` or `"browse worktree setup FAILED"` — these are container-side errors logged at `error` level when git clone or worktree creation fails. Visible in Workers Observability via `$containers` log enrichment.
- **FrontDesk can't see workstations**: search for `"frontDesk workstation setup:"` to see summary of workstation setup failures during frontDesk startup

### Dashboard

The Cloudflare Workers Observability dashboard provides an interactive UI for the same data:

1. Go to **Workers & Pages** → select **helldesk** → **Observability** → **Overview**
2. Use the search bar with the query language: `message : "<departmentId>"`
3. Filter by level: `level = "error"` or `level = "warn"`
4. Group by invocation to see all logs from a single request

## 7. Querying Analytics Engine

The `helldesk_events` Analytics Engine dataset stores all lifecycle events (ticket status changes, agent dispatches, reconciler ticks, reviews, etc.). Unlike logs, AE data is designed for aggregation and time-series queries.

### Dataset schema

The `helldesk_events` dataset maps fields as follows:

| Column | Field | Description |
|---|---|---|
| blob1 | event | Event name (e.g. `ticket.created`, `agent.spawned`) |
| blob2 | userId | User who triggered the event |
| blob3 | delivery | `http`, `trpc`, or `internal` |
| blob4 | route | HTTP route pattern (for HTTP events) |
| blob5 | error | Error message (if any) |
| blob6 | departmentId | Department ID |
| blob7 | workstationId | Workstation ID |
| blob8 | agentId | Agent ID |
| blob9 | ticketId | Ticket ID |
| blob10 | label | Free-form label (e.g. actionsByType JSON) |
| blob11 | shiftId | Shift ID |
| blob12 | role | Agent role (`soul`, `qualityAssurance`, `frontDesk`) |
| blob13 | ticketType | Ticket type |
| blob14 | reason | Failure/action reason (e.g. `timeout`, `auto_restart`) |
| blob15 | containerStartedAt | Container boot timestamp (ISO) |
| blob16 | containerId | Cloudflare container id (DepartmentContainerDO Durable Object id) |
| double1 | durationMs | Duration in milliseconds |
| double2 | value | Generic numeric value |
| double3 | actionsEmitted | (reconciler_tick) actions count |
| double7 | invariantViolations | (reconciler_tick) violation count |
| double8 | pendingEventCount | (reconciler_tick) pending event count |

### Example AE queries

```bash
AE_API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql"

# Count events by type for a department in the last hour
curl -s "$AE_API" \
  -H "Authorization: Bearer $HELLDESK_CF_ANALYTICS_API_KEY" \
  -d "SELECT blob1 AS event, SUM(_sample_interval) AS count
      FROM helldesk_events
      WHERE blob6 = '$DEPARTMENT_ID'
        AND timestamp > NOW() - INTERVAL '1' HOUR
      GROUP BY event ORDER BY count DESC LIMIT 20
      FORMAT JSONCompact"

# Reconciler health over the last 6 hours (5-min buckets)
curl -s "$AE_API" \
  -H "Authorization: Bearer $HELLDESK_CF_ANALYTICS_API_KEY" \
  -d "SELECT
        intDiv(toUInt32(timestamp), 300) * 300 AS t,
        SUM(_sample_interval * double1) / SUM(_sample_interval) AS avg_wall_ms,
        SUM(_sample_interval * double3) AS total_actions,
        SUM(_sample_interval * double7) AS total_violations
      FROM helldesk_events
      WHERE blob1 = 'reconciler_tick' AND blob6 = '$DEPARTMENT_ID'
        AND timestamp > NOW() - INTERVAL '6' HOUR
      GROUP BY t ORDER BY t
      FORMAT JSONCompact"

# Agent dispatch failures in the last day
curl -s "$AE_API" \
  -H "Authorization: Bearer $HELLDESK_CF_ANALYTICS_API_KEY" \
  -d "SELECT timestamp, blob8 AS agent_id, blob12 AS role, blob5 AS error
      FROM helldesk_events
      WHERE blob1 = 'agent.dispatch_failed' AND blob6 = '$DEPARTMENT_ID'
        AND timestamp > NOW() - INTERVAL '1' DAY
      ORDER BY timestamp DESC LIMIT 20
      FORMAT JSONCompact"

# Ticket lifecycle for a specific department (status changes)
curl -s "$AE_API" \
  -H "Authorization: Bearer $HELLDESK_CF_ANALYTICS_API_KEY" \
  -d "SELECT timestamp, blob1 AS event, blob9 AS ticket_id, blob10 AS label
      FROM helldesk_events
      WHERE blob1 LIKE 'ticket.%' AND blob6 = '$DEPARTMENT_ID'
        AND timestamp > NOW() - INTERVAL '1' HOUR
      ORDER BY timestamp DESC LIMIT 50
      FORMAT JSONCompact"
```

### Structured log fields

Worker logs now emit JSON-structured entries. Key fields available for filtering in Workers Observability:

| JSON field | Description | Example filter |
|---|---|---|
| `source` | Module that emitted the log | `"Department.do"`, `"helldesk-worker"` |
| `departmentId` | Department UUID | `message : "departmentId":"<uuid>"` |
| `workstationId` | Workstation UUID | `message : "workstationId":"<uuid>"` |
| `userId` | User UUID | `message : "userId":"<uuid>"` |
| `orgId` | Organization UUID | `message : "orgId":"<uuid>"` |
| `agentId` | Agent UUID | `message : "agentId":"<uuid>"` |
| `level` | `info`, `warn`, or `error` | `message : "level":"error"` |

These fields are embedded in the `message` text as JSON, so use the `contains` operator or `:` in the dashboard query language to filter by them.
