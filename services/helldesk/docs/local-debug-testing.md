# Local Debug Testing Guide

Guide for an AI agent to test helldesk features locally — dispatching work, monitoring agents, triggering container eviction, and verifying the drain flow.

## Prerequisites

- Wrangler dev server running for helldesk (`pnpm dev` in `cloudflare-helldesk/`)
- Read the dev server port from the wrangler config (default: 8803)
- A department ID (ask the user or check the UI)
- Docker running (containers are managed by wrangler's container runtime)

## Quick Reference

```bash
BASE=http://localhost:8803
DEPARTMENT_ID="<department-id>"
```

## 1. Debug Endpoints

All `/debug/` endpoints are unauthenticated in local dev.

### Department Status

The primary status endpoint — shows agents, tickets, alarm, attendance, and drain state:

```bash
curl -s $BASE/debug/departments/$DEPARTMENT_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
a = d.get('alarmStatus', {})
print('Agents:', json.dumps(a.get('agents', {})))
print('Draining:', a.get('draining', False))
print()
for am in d.get('agentMeta', []):
    print(f\"  {am.get('role', '?'):12s} ticket={am.get('ticket_id', '?')[:8]} status={am.get('status', '?'):10s} hook={str(am.get('current_hook_ticket_id', 'NULL'))[:8]}\")
print()
for b in d.get('ticketSummary', []):
    if b.get('type') == 'issue' and b.get('status') in ('open', 'in_progress'):
        print(f\"  ticket={b.get('ticket_id', '?')[:8]} status={b.get('status', '?'):15s} {b.get('title', '')[:60]}\")
"
```

### Drain Status

```bash
curl -s $BASE/debug/departments/$DEPARTMENT_ID/drain-status | python3 -m json.tool
```

### Pending Nudges

```bash
curl -s $BASE/debug/departments/$DEPARTMENT_ID/nudges | python3 -m json.tool
```

### Send Message to FrontDesk (dev only)

Creates tickets by telling the frontDesk what to do:

```bash
curl -s -m 120 -X POST $BASE/debug/departments/$DEPARTMENT_ID/send-message \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a ticket for this task: Write src/example.ts with 10 utility functions. Commit and push when done."}'
```

### Trigger Graceful Stop (dev only)

Sends SIGTERM to the container, initiating the drain flow:

```bash
curl -s -X POST $BASE/debug/departments/$DEPARTMENT_ID/graceful-stop
```

## 2. Container Monitoring

### Find the Active Container

```bash
CONTAINER_ID=$(docker ps --format "{{.ID}}\t{{.Image}}" | grep helldesk-container | head -1 | awk '{print $1}')
echo "Container: $CONTAINER_ID"
```

### Container Health

```bash
docker exec $CONTAINER_ID curl -s http://localhost:8080/health | python3 -m json.tool
```

### Live Container Logs

Stream to a file for analysis:

```bash
docker logs -f $CONTAINER_ID > /tmp/container-logs.log 2>&1 &
```

### Filter Drain Logs

```bash
grep -E "\[drain\]|handleIdleEvent|idle timeout|agent\.(exit|start)|Drain complete" /tmp/container-logs.log
```

### Check Agent Events

```bash
docker logs $CONTAINER_ID 2>&1 | grep "Event #" | tail -10
```

## 3. Testing Graceful Container Eviction

### Full Test Loop

The recommended sequence for verifying the drain flow end-to-end:

#### Step 1: Verify clean state

```bash
# Not draining, agents are available
curl -s $BASE/debug/departments/$DEPARTMENT_ID/drain-status  # draining: false
curl -s $BASE/debug/departments/$DEPARTMENT_ID/status         # check agent statuses
```

#### Step 2: Send work to the frontDesk

```bash
curl -s -m 120 -X POST $BASE/debug/departments/$DEPARTMENT_ID/send-message \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a ticket for this task: <describe a task that takes 1-3 minutes>."}'
```

#### Step 3: Wait for a soul to be dispatched and working

Poll until a soul shows `status=working`:

```bash
for i in $(seq 1 40); do
  WORKING=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
for am in d.get('agentMeta', []):
    if am.get('role') == 'soul' and am.get('status') == 'working':
        print(f\"soul:{am.get('ticket_id', '?')[:8]}\")
" 2>/dev/null)
  echo "$(date +%H:%M:%S) $WORKING"
  if [ -n "$WORKING" ]; then echo "READY"; break; fi
  sleep 15
done
```

#### Step 4: Start monitoring container logs

```bash
CONTAINER_ID=$(docker ps --format "{{.ID}}\t{{.Image}}" | grep helldesk-container | head -1 | awk '{print $1}')
docker logs -f $CONTAINER_ID > /tmp/drain-test.log 2>&1 &
```

#### Step 5: Trigger graceful stop

```bash
curl -s -X POST $BASE/debug/departments/$DEPARTMENT_ID/graceful-stop
```

#### Step 6: Monitor the drain

```bash
# Watch for container exit
for i in $(seq 1 60); do
  sleep 10
  RUNNING=$(docker ps -q --filter "id=$CONTAINER_ID")
  if [ -z "$RUNNING" ]; then
    echo "$(date +%H:%M:%S) CONTAINER EXITED"
    break
  fi
  DRAIN_LINE=$(grep "\[drain\]" /tmp/drain-test.log | tail -1)
  echo "$(date +%H:%M:%S) ${DRAIN_LINE:0:100}"
done
```

#### Step 7: Verify the drain log

```bash
grep -E "\[drain\]|handleIdleEvent.*(idle timeout fired)|agent\.(exit|start)|Drain complete" /tmp/drain-test.log
```

**Expected drain flow:**

1. `Phase 1: DepartmentDO responded 200` — DepartmentDO notified, dispatch blocked
2. `Phase 2: waiting up to 300s` — waiting for non-front-desk agents
3. `Waiting for N non-front-desk agents` — polling until agents finish or idle
4. `All N non-front-desk agents are idle` — agents finished, timers pending
5. `idle timeout fired` / `agent.exit` — agents exit via normal path
6. `Phase 3: freezing N straggler(s)` — only the frontDesk (or truly stuck agents)
7. `Phase 3: force-saving agent ...` — WIP git commit for stragglers
8. `Drain complete` — container exits

#### Step 8: Verify post-drain state

```bash
# Drain flag should clear within ~30s (heartbeat instance ID detection)
curl -s $BASE/debug/departments/$DEPARTMENT_ID/drain-status

# Check ticket states — evicted tickets should be 'open' with eviction context
curl -s $BASE/debug/departments/$DEPARTMENT_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
for am in d.get('agentMeta', []):
    print(f\"  {am.get('role', '?'):12s} status={am.get('status', '?'):10s} hook={str(am.get('current_hook_ticket_id', 'NULL'))[:8]}\")
"
```

## 4. Wrangler Management

### Restart Wrangler

When you need to pick up code changes:

```bash
# Kill existing
ps aux | grep -i wrangler | grep helldesk | grep -v grep | awk '{print $2}' | xargs kill -9
ps aux | grep workerd | grep -v grep | awk '{print $2}' | xargs kill -9
sleep 3

# Start fresh
cd cloudflare-helldesk && nohup pnpm dev > /tmp/helldesk-wrangler.log 2>&1 &
sleep 25
curl -s http://localhost:8803/health
```

### Check Wrangler Logs

```bash
# Dispatch errors
grep -i "error\|failed\|dispatch" /tmp/helldesk-wrangler.log | tail -20

# Container lifecycle
grep "container\|startAgent\|eviction" /tmp/helldesk-wrangler.log | tail -20
```

## 5. Drain Architecture

### 3-Phase Drain (SIGTERM handler)

1. **Phase 1: Notify DepartmentDO** — POST `/api/departments/:id/container-eviction`. Sets `_draining = true` on the DepartmentDO, blocking new agent dispatch. Records the drain nonce and start time.

2. **Phase 2: Wait for agents** — Poll the container's local `agents` Map every 5s for up to 5 minutes. Excludes frontDesk (they never exit on their own). When all non-front-desk agents have idle timers pending (meaning they called `gt_done` and went idle), polls at 1s for fast exit. Agents exit through the normal `exitAgent` → `reportAgentCompleted` path.

3. **Phase 3: Force-save stragglers** — Any agents still running after 5 minutes are frozen (SDK session aborted), WIP git committed and pushed, eviction context written on the ticket body, and `reportAgentCompleted(agent, 'completed', 'container eviction')` called. The DepartmentDO resets the ticket to `open` and clears the assignee so the reconciler re-dispatches on the next tick.

### Drain Flag Clearing

The DepartmentDO's `_draining` flag is cleared by whichever happens first:

- **Heartbeat instance ID change** (~30s): each container has a UUID. When a new container's heartbeat arrives with a different ID, the drain clears.
- **Nonce handshake**: the new container calls `/container-ready` with the drain nonce.
- **Hard timeout** (7 min): safety net if no heartbeat or handshake arrives.

### Key Behaviors During Drain

- `isDraining()` returns true → `/agents/start` returns 503
- `handleIdleEvent` skips `fetchPendingNudges` (avoids hanging outbound HTTP)
- Idle timeout is 10s (vs normal 120s/600s) so agents exit promptly
- `reconcileAgents` skips stale-heartbeat checks (heartbeat reporter is stopped)
- `reconcileGUPP` skips entirely (no false "idle for 15 minutes" nudges)
- Evicted `in_progress` tickets are reset to `open` with assignee cleared

## 6. Common Issues

### Container Keeps Cycling

Containers start and immediately get killed (exit code 137). This is usually the wrangler container runtime recreating them. Kill all containers and restart wrangler cleanly:

```bash
docker kill $(docker ps -q) 2>/dev/null
# Then restart wrangler (see section 4)
```

### Drain Stuck "Waiting for N agents"

Agents show as `running` but aren't doing work. Common causes:

- **`fetchPendingNudges` hanging**: should be skipped during drain (check `_draining` flag)
- **`server.heartbeat` clearing idle timer**: these events should be in `IDLE_TIMER_IGNORE_EVENTS`
- **Agent in `starting` status**: `session.prompt()` blocking. Status is set to `running` before the prompt now.

### Drain Flag Persists After Restart

The drain banner stays visible after the container restarted. Causes:

- **No heartbeats arriving**: container failed to start, no agents registered
- **`_containerInstanceId` not persisted**: should be in `ctx.storage`
- Fallback: wait for the 7-minute hard timeout

### Git Credential Errors

Container starts but agents fail at `git clone`:

```
Error checking if container is ready: Invalid username
```

This means the git token is stale/expired. Refresh credentials in the department settings.

### Accumulating Escalation Tickets

Triage/escalation tickets pile up with `workstation_id=NULL`. These are by design:

- `type=escalation` tickets surface for human attention (merge conflicts, rework)
- `type=issue` triage tickets are handled by `maybeDispatchTriageAgent`
- GUPP force-stop tickets are created by the attendance system for stuck agents

During testing, container restarts generate many of these. Bulk-close via admin panel if needed.

## 7. Auto-Merge with Workers AI Thread Classification

The auto-merge flow classifies unresolved PR review threads as blocking vs non-blocking. This prevents informational bot comments (status reports, code review summaries) from blocking auto-merge.

### How It Works

1. `poll_pr` runs every ~60s for MR tickets with a `pr_url`
2. `checkPRFeedback` fetches review threads via GitHub GraphQL (including comment bodies)
3. If unresolved threads exist, `areThreadsBlocking()` classifies them:
   - Direct-BYOK departments (configured model's provider prefix is a direct BYOK provider, e.g. `neuralwatt/...`) call the Kilo gateway at `/api/openrouter/chat/completions` on `role_models.qualityAssurance ?? default_model`, billing the user's own provider key
   - Everyone else uses Workers AI (Gemma 4 26B)
4. The model classifies threads as BLOCKING (requires code changes, bugs, security) or NON-BLOCKING (informational, nits, bot status reports)
5. Only truly blocking threads prevent auto-merge

A rejected BYOK gateway call blocks auto-merge (`blocking=true`) rather than falling back to the Kilo-billed Workers AI path.

### Config Required

Set these on the department config (via `PATCH /debug/departments/:departmentId/config`):

```json
{
  "qualityAssurance": {
    "auto_merge": true,
    "auto_merge_delay_minutes": 0,
    "auto_resolve_pr_feedback": true
  }
}
```

### Testing Locally

The `areThreadsBlocking` AI call only triggers when:

- An MR ticket has a `pr_url` (external GitHub PR exists)
- The PR has unresolved review threads on GitHub
- `auto_merge` is enabled in the department config

In local dev, PRs created by the qualityAssurance in review-and-merge mode may not create external GitHub PRs, so the AI classification branch won't fire. To test the AI path end-to-end:

1. Manually create a PR with unresolved review comments on the target repo
2. Create an MR ticket that references that PR
3. Watch the wrangler logs for `areThreadsBlocking` output

### Monitoring in Production

Query Analytics Engine for the `areThreadsBlocking` log output:

```bash
# Check wrangler tail for AI classification logs
npx wrangler tail helldesk --format json --search "areThreadsBlocking"
```

The `areThreadsBlocking` method logs its decision:

```
[department] areThreadsBlocking: blocking=false reason=<explanation> threads=2
```

If the AI call fails, it conservatively defaults to `blocking=true` and logs a warning.

## 8. KV-Backed Agent Session Persistence

Agent session state (kilo.db) is persisted to Cloudflare KV via the `AGENT_DB_SNAPSHOTS_KV` binding. The container registry (which agents should be running) is stored in the `DepartmentContainerDO`'s persistent storage.

### Architecture

```
Container Cold Start
    │
    ▼
main.ts → bootHydration()
    │
    ├─ GET /container-registry → DepartmentContainerDO.getRegistry()
    │   (reads agent entries from DO persistent storage)
    │
    ▼ For each registered agent:
startAgent()
    │
    └─ hydrateDbFromSnapshot()
        └─ GET /db-snapshot → AGENT_DB_SNAPSHOTS_KV.get(agentId)
            (restores kilo.db to /tmp/agent-home-{agentId}/)

Agent Lifecycle (save snapshots):
    ├─ Agent completes   → saveDbSnapshot()
    ├─ Agent stopped     → saveDbSnapshot()
    ├─ Container drain   → saveDbSnapshot() (awaited)
    └─ Container shutdown → saveDbSnapshot() (fire-and-forget)
```

### KV Namespace Setup

The `AGENT_DB_SNAPSHOTS_KV` binding in `wrangler.jsonc` must have a valid KV namespace ID for both production and dev environments. The dev env section must re-declare `kv_namespaces` (wrangler does not inherit it from the top level when other bindings are overridden).

### Testing the Container Registry

```bash
# Read registry (should be empty or contain agent entries)
curl -s $BASE/api/departments/$DEPARTMENT_ID/container-registry | python3 -m json.tool

# Write a test entry
curl -s -X POST $BASE/api/departments/$DEPARTMENT_ID/container-registry \
  -H "Content-Type: application/json" \
  -d '[{"agentId":"test-agent","request":{"role":"soul"},"workdir":"/tmp/test","env":{}}]'

# Verify persistence
curl -s $BASE/api/departments/$DEPARTMENT_ID/container-registry | python3 -m json.tool

# Clear registry
curl -s -X POST $BASE/api/departments/$DEPARTMENT_ID/container-registry \
  -H "Content-Type: application/json" \
  -d '[]'
```

### Testing DB Snapshots

```bash
AGENT_ID="test-snapshot-agent"
WORKSTATION_ID="test-workstation"

# GET non-existent snapshot (expect 404)
curl -s -w "\n%{http_code}" $BASE/api/departments/$DEPARTMENT_ID/workstations/$WORKSTATION_ID/agents/$AGENT_ID/db-snapshot

# POST a snapshot
echo -n "test-data" > /tmp/test-snapshot.bin
curl -s -X POST $BASE/api/departments/$DEPARTMENT_ID/workstations/$WORKSTATION_ID/agents/$AGENT_ID/db-snapshot \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/tmp/test-snapshot.bin

# GET and verify round-trip
curl -s -o /tmp/snapshot-read.bin $BASE/api/departments/$DEPARTMENT_ID/workstations/$WORKSTATION_ID/agents/$AGENT_ID/db-snapshot
diff /tmp/test-snapshot.bin /tmp/snapshot-read.bin && echo "PASS: round-trip match"
```

### Verifying Boot Hydration

After a container restart, check the logs for hydration activity:

```bash
CONTAINER_ID=$(docker ps --format "{{.ID}}\t{{.Image}}" | grep helldesk-container | head -1 | awk '{print $1}')
docker logs $CONTAINER_ID 2>&1 | grep -E "boot-hydration|snapshot"
```

**Expected log entries:**

- `[boot-hydration] Fetching container registry for department=<departmentId>` — registry fetch
- `[boot-hydration] No agents in registry — nothing to hydrate` — if registry is empty
- `[boot-hydration] Hydrating N agent(s)` — if agents are registered
- `[process-manager] No DB snapshot found for agent <id>, starting fresh` — no prior snapshot
- `[process-manager] Hydrated DB snapshot for agent <id>` — snapshot restored

### Verifying Snapshot Save During Drain

During graceful container eviction, snapshots are saved before exit:

```bash
grep -E "saveDbSnapshot|snapshot|kilo\.db" /tmp/drain-test.log
```

**Expected:** Either `Saved DB snapshot for agent <id>` (kilo.db exists) or `No kilo.db found for agent <id>, skipping snapshot save` (agents that didn't create a local DB).

### Common Issues

- **500 on db-snapshot endpoints**: The KV namespace ID is likely `"placeholder"`. Set the real ID in both the top-level and dev env `kv_namespaces` in `wrangler.jsonc`.
- **Boot hydration skipped**: Check that `HELLDESK_API_URL`, `HELLDESK_DEPARTMENT_ID`, and `HELLDESK_CONTAINER_TOKEN` environment variables are set in the container. `HELLDESK_DEPARTMENT_ID` is passed by the worker on container provision.
- **Snapshot save fails silently**: The `saveDbSnapshot` function catches errors and logs them as warnings. Check container logs for `saveDbSnapshot failed` messages.

## 9. Re-Escalation Filtering

The `reEscalateStaleEscalations()` function in `Department.do.ts` re-escalates unacknowledged escalation tickets by bumping their severity over time. The query filters out tickets with `status = 'closed'` or `status = 'failed'` to prevent phantom re-escalation messages for already-resolved tickets.

### Verifying the Filter

The re-escalation logic runs in the DO alarm loop. To verify it works:

1. Create an escalation ticket, acknowledge it (sets status to closed)
2. Verify the reconciler dry-run doesn't produce re-escalation actions for closed tickets
3. Check that only `open` unacknowledged escalation tickets are candidates

The filter is covered by the unit test suite (`pnpm --filter cloudflare-helldesk test` — `pr-feedback.test.ts` covers `DepartmentConfigSchema` and related escalation logic).
