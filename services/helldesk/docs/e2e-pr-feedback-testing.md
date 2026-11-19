# E2E Local Testing: PR Feedback Auto-Resolve & Auto-Merge

Guide for an AI agent to test the PR feedback auto-resolve and auto-merge feature locally. Covers the full lifecycle for both single tickets and shifts.

## Architecture Overview

When `merge_strategy: 'pr'` is configured:

1. **Soul creates the PR** — pushes branch, runs `gh pr create`, passes `pr_url` to `gt_done`
2. **QualityAssurance reviews the existing PR** — runs quality gates, reviews diff, adds GitHub review comments (approve or request changes)
3. **Auto-resolve detects comments** — `poll_pr` checks for unresolved review threads, dispatches soul to fix
4. **Auto-merge** — once all comments resolved and CI passes, grace period timer starts, then PR is merged via API

### Shift Merge Modes

Shifts (multi-ticket jobs) come in two flavors, controlled by `shift_merge_mode` in department config:

- **`review-and-merge`** — each ticket opens a PR directly to `main`. Independent landings.
- **`review-then-land`** (default) — each ticket's PR targets a shared **shift feature branch**, and a single **landing PR** is opened from that feature branch to `main` after all tickets close. Test this with [Test C](#test-c-review-then-land-shift-via-direct-sling).

## Prerequisites

- Wrangler dev server running for helldesk (`pnpm dev` in `cloudflare-helldesk/`, port 8803)
- Docker running (containers are managed by wrangler's container runtime)
- A department with an active container and at least one workstation configured with a GitHub repo
- `gh` CLI authenticated (for adding PR comments and verifying merges)

## Quick Reference

```bash
BASE=http://localhost:8803
DEPARTMENT_ID="${DEPARTMENT_ID:-a093a551-ff4d-4c36-9274-252df66128fd}"
WORKSTATION_ID="${WORKSTATION_ID:-mega-todo-app5}"
REPO="${REPO:-jrf0110/mega-todo-app5}"
```

## Pre-Flight Checklist

Run this before EACH scenario to validate department state.

### 1. Verify/Update Department Settings via Debug API

The debug config endpoint (dev only) allows reading and updating department configuration without auth:

```bash
# Read current settings
curl -s $BASE/debug/departments/$DEPARTMENT_ID/config | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('merge_strategy:', d.get('merge_strategy'))
ref = d.get('qualityAssurance', {})
print('qualityAssurance.code_review:', ref.get('code_review'))
print('qualityAssurance.auto_merge:', ref.get('auto_merge'))
print('qualityAssurance.auto_resolve_pr_feedback:', ref.get('auto_resolve_pr_feedback'))
print('qualityAssurance.auto_merge_delay_minutes:', ref.get('auto_merge_delay_minutes'))
print('qualityAssurance.review_mode:', ref.get('review_mode'))
"
```

Update settings with PATCH (partial update, unspecified fields preserved):

```bash
curl -s -X PATCH $BASE/debug/departments/$DEPARTMENT_ID/config \
  -H "Content-Type: application/json" \
  -d '{
    "merge_strategy": "pr",
    "qualityAssurance": {
      "code_review": false,
      "auto_merge": true,
      "auto_resolve_pr_feedback": true,
      "auto_merge_delay_minutes": 2,
      "review_mode": "rework"
    }
  }'
```

### 2. Verify Clean State

```bash
curl -s $BASE/debug/departments/$DEPARTMENT_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
alarm = d.get('alarmStatus', {})
agents = alarm.get('agents', {})
tickets = alarm.get('tickets', {})
recon = alarm.get('reconciler', {})
print('Agents:', json.dumps(agents))
print('Tickets:', json.dumps(tickets))
print(f'Reconciler: violations={recon.get(\"invariantViolations\", \"?\")}, pending={recon.get(\"pendingEventCount\", \"?\")}')
summary = d.get('ticketSummary', [])
if summary:
    print(f'WARNING: {len(summary)} non-terminal ticket(s)')
    for b in summary:
        assignee = b.get('assignee_agent_ticket_id') or 'none'
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {assignee[:12]:14s} {str(b.get(\"title\",\"\"))[:50]}')
else:
    print('Clean state.')
active = [am for am in d.get('agentMeta', []) if am.get('status') != 'idle']
if active:
    print(f'Active agents ({len(active)}):')
    for am in active:
        print(f'  {am[\"role\"]:12s} {am[\"status\"]:10s}')
"
```

### 3. Wait for Active Agents to Settle

If agents are still working from a previous test, wait:

```bash
for i in $(seq 1 20); do
  WORKING=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
w = d.get('alarmStatus', {}).get('agents', {}).get('working', 0)
print(w)
" 2>/dev/null)
  echo "$(date +%H:%M:%S) working=$WORKING"
  if [ "$WORKING" -le 1 ]; then echo "Settled"; break; fi
  sleep 15
done
```

Note: The frontDesk often stays `working` for extended periods while processing stale triage tickets. It's safe to proceed with `working=1` if only the frontDesk is active.

---

## Scenario 1: Auto-Merge Without Code Review

**Settings:** `merge_strategy=pr`, `code_review=false`, `auto_resolve_pr_feedback=false`, `auto_merge=true`, `auto_merge_delay_minutes=2`

**Goal:** Verify that with code review disabled, the soul creates a PR and it auto-merges without qualityAssurance involvement.

### 1.1. Configure Settings

```bash
curl -s -X PATCH $BASE/debug/departments/$DEPARTMENT_ID/config \
  -H "Content-Type: application/json" \
  -d '{
    "merge_strategy": "pr",
    "qualityAssurance": {
      "code_review": false,
      "auto_merge": true,
      "auto_resolve_pr_feedback": false,
      "auto_merge_delay_minutes": 2,
      "review_mode": "rework"
    }
  }' | python3 -c "
import sys, json; d = json.load(sys.stdin); ref = d.get('qualityAssurance', {})
print(f'code_review={ref.get(\"code_review\")} auto_merge={ref.get(\"auto_merge\")} delay={ref.get(\"auto_merge_delay_minutes\")}')
"
```

### 1.2. Send Work

```bash
curl -s -m 120 -X POST $BASE/debug/departments/$DEPARTMENT_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a ticket for this task on the $WORKSTATION_ID workstation: Add a new file src/utils/color-helpers.ts with 3 simple utility functions (hexToRgb, rgbToHex, lightenColor). Each function should have JSDoc comments. Commit and push when done.\"}"
```

### 1.3. Monitor Until Complete

```bash
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('ticketSummary', []):
    title = b.get('title', '') or ''
    if 'color' in title.lower() or b.get('type') == 'merge_request':
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {title[:60]}')
for am in d.get('agentMeta', []):
    if am.get('status') != 'idle':
        hook = str(am.get('current_hook_ticket_id') or 'NULL')[:12]
        print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s} hook={hook}')
for e in d.get('alarmStatus', {}).get('recentEvents', [])[:3]:
    t = e.get('type', '')
    msg = e.get('message', '')
    if 'color' in msg.lower() or 'pr_' in t or 'merge' in t.lower():
        print(f'  EVT: {t:20s} {msg[:60]}')
" 2>/dev/null
  sleep 15
done
```

### 1.4. Verify

```bash
# Check PR was merged
gh pr list --repo $REPO --state merged --limit 3 --json number,title,mergedAt,mergedBy

# Check no stray post-merge comments
PR_NUMBER=<number>
gh api repos/$REPO/issues/$PR_NUMBER/comments --jq 'length'
gh api repos/$REPO/pulls/$PR_NUMBER/comments --jq 'length'
```

### Expected Outcome

- Soul creates PR (not qualityAssurance)
- No qualityAssurance agent becomes `working`
- MR ticket transitions `open` → `in_progress` (fast-tracked by reconciler)
- Auto-merge fires after ~2 min delay
- PR merged on GitHub, no post-merge comments

### Historical Test Results (2026-04-05)

Early test rounds found two issues that have since been addressed:

1. **QualityAssurance dispatched during `pr_url=null` window** — Fixed by transitioning all open MR tickets with `pr_url` when `code_review=false`, and always dispatching the qualityAssurance for direct-merge tickets.
2. **Soul not reliably creating PRs** — The soul LLM occasionally skips the `gh pr create` step despite prompt instructions. This is a prompt reliability issue, not a code bug. The system prompt includes clear PR creation instructions; LLM compliance varies by run.

---

## Scenario 2: QualityAssurance Review (Rework Mode) + Auto-Merge

**Settings:** `merge_strategy=pr`, `code_review=true`, `review_mode=rework`, `auto_resolve_pr_feedback=false`, `auto_merge=true`, `auto_merge_delay_minutes=2`

**Goal:** Verify the full review pipeline: soul pushes code, qualityAssurance reviews and creates PR, optional rework, then auto-merge.

### 2.1. Configure Settings

```bash
curl -s -X PATCH $BASE/debug/departments/$DEPARTMENT_ID/config \
  -H "Content-Type: application/json" \
  -d '{
    "merge_strategy": "pr",
    "qualityAssurance": {
      "code_review": true,
      "auto_merge": true,
      "auto_resolve_pr_feedback": false,
      "auto_merge_delay_minutes": 2,
      "review_mode": "rework"
    }
  }' | python3 -c "
import sys, json; d = json.load(sys.stdin); ref = d.get('qualityAssurance', {})
print(f'code_review={ref.get(\"code_review\")} review_mode={ref.get(\"review_mode\")} auto_merge={ref.get(\"auto_merge\")}')
"
```

### 2.2. Send Work

```bash
curl -s -m 120 -X POST $BASE/debug/departments/$DEPARTMENT_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a ticket for this task on the $WORKSTATION_ID workstation: Add a new file src/utils/date-helpers.ts with 3 utility functions (formatDate, daysBetween, isLeapYear). Each function should have JSDoc comments. Commit and push when done.\"}"
```

### 2.3. Monitor Until Complete

```bash
for i in $(seq 1 80); do
  STATUS=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('ticketSummary', []):
    title = b.get('title', '') or ''
    if 'date' in title.lower() or b.get('type') == 'merge_request':
        marker = ' <-- REWORK' if 'Rework' in title else ''
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {title[:55]}{marker}')
for am in d.get('agentMeta', []):
    if am.get('status') != 'idle' and am.get('role') != 'frontDesk':
        hook = str(am.get('current_hook_ticket_id') or 'NULL')[:12]
        print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s} hook={hook}')
for e in d.get('alarmStatus', {}).get('recentEvents', [])[:5]:
    t = e.get('type', '')
    msg = e.get('message', '')
    if 'date' in msg.lower() or 'pr_' in t or 'rework' in msg.lower() or 'review' in t:
        print(f'  EVT: {t:24s} {msg[:70]}')
" 2>/dev/null
  ALL_DONE=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tickets = d.get('ticketSummary', [])
relevant = [b for b in tickets if 'date' in str(b.get('title','')).lower()]
if not relevant: print('DONE')
" 2>/dev/null)
  if [ "$ALL_DONE" = "DONE" ]; then echo "=== SCENARIO 2 COMPLETE ==="; break; fi
  sleep 15
done
```

### 2.4. Verify

```bash
# Check PR was merged
gh pr list --repo $REPO --state merged --limit 3 --json number,title,mergedAt

# Check for rework tickets (if qualityAssurance requested changes)
# Look for tickets titled "Rework: ..." with parent_ticket_id matching the MR ticket
MR_TICKET_ID=<mr_ticket_id>
curl -s $BASE/debug/departments/$DEPARTMENT_ID/tickets/$MR_TICKET_ID | python3 -c "
import sys, json
d = json.load(sys.stdin)
rm = d.get('reviewMetadata')
if rm:
    print(f'PR URL: {rm.get(\"pr_url\")}')
deps = d.get('dependencies', [])
for dep in deps:
    print(f'  {dep[\"dependency_type\"]}: {dep[\"depends_on_ticket_id\"][:12]}')
"

# Check no stray post-merge comments
PR_NUMBER=<number>
MERGE_TIME=$(gh pr view $PR_NUMBER --repo $REPO --json mergedAt --jq '.mergedAt')
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  --jq ".[] | select(.created_at > \"$MERGE_TIME\") | {created_at, body: (.body[:80])}"
```

### Expected Outcome

- Soul pushes code and calls `gt_done`
- MR ticket created as `open`
- QualityAssurance dispatched, reviews diff, calls `gt_done` (with `pr_url`)
- If qualityAssurance requests changes: rework ticket created with `parent_ticket_id = MR ticket`
- If qualityAssurance approves: MR ticket → `in_progress`, `poll_pr` starts
- Auto-merge fires after ~2 min delay
- No stray post-merge comments

### Expected Timeline

| Step | Duration |
|---|---|
| FrontDesk slings ticket | ~30s |
| Soul works + pushes code | 2-5 min |
| QualityAssurance reviews, creates PR | 1-3 min |
| Rework cycle (if needed) | 2-5 min |
| Auto-merge grace period | 2 min |
| **Total** | **6-15 min** |

---

## Scenario 3: Human Feedback + Auto-Resolve + Auto-Merge

**Settings:** `merge_strategy=pr`, `code_review=false`, `auto_resolve_pr_feedback=true`, `auto_merge=true`, `auto_merge_delay_minutes=2`

**Goal:** Verify the human feedback loop: soul creates PR, human adds review comment, system detects and resolves it, then auto-merges.

### 3.1. Configure Settings

```bash
curl -s -X PATCH $BASE/debug/departments/$DEPARTMENT_ID/config \
  -H "Content-Type: application/json" \
  -d '{
    "merge_strategy": "pr",
    "qualityAssurance": {
      "code_review": false,
      "auto_merge": true,
      "auto_resolve_pr_feedback": true,
      "auto_merge_delay_minutes": 2,
      "review_mode": "rework"
    }
  }' | python3 -c "
import sys, json; d = json.load(sys.stdin); ref = d.get('qualityAssurance', {})
print(f'code_review={ref.get(\"code_review\")} auto_resolve={ref.get(\"auto_resolve_pr_feedback\")} auto_merge={ref.get(\"auto_merge\")}')
"
```

### 3.2. Send Work

```bash
curl -s -m 120 -X POST $BASE/debug/departments/$DEPARTMENT_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a ticket for this task on the $WORKSTATION_ID workstation: Add a new file src/utils/array-helpers.ts with 3 utility functions (unique, flatten, chunk). Each function should have JSDoc comments and handle edge cases. Commit and push when done.\"}"
```

### 3.3. Wait for PR Creation

Monitor until the PR appears on GitHub:

```bash
for i in $(seq 1 40); do
  PR_EXISTS=$(gh pr list --repo $REPO --state open --json number,headRefName,title \
    --jq '.[] | select(.title | test("array|Array"; "i")) | .number' 2>/dev/null | head -1)
  echo "$(date +%H:%M:%S) PR=$PR_EXISTS"
  if [ -n "$PR_EXISTS" ]; then echo "=== PR #$PR_EXISTS FOUND ==="; break; fi
  sleep 15
done
PR_NUMBER=$PR_EXISTS
```

### 3.4. Add Human Review Comment

Get the diff to find a valid position, then add a review with inline feedback:

```bash
# View diff to find a valid file and position
gh pr diff $PR_NUMBER --repo $REPO | head -30

# Add a review with inline comment (creates a review thread)
gh api repos/$REPO/pulls/$PR_NUMBER/reviews \
  --method POST \
  --input - <<EOF
{
  "event": "REQUEST_CHANGES",
  "body": "The unique function needs input validation.",
  "comments": [
    {
      "path": "src/utils/array-helpers.ts",
      "position": 8,
      "body": "Please add input validation for null and undefined values - throw a TypeError with a descriptive message if the input is not an array."
    }
  ]
}
EOF
```

**Important:** You must use inline comments (with `path` and `position`) to create review threads. The `checkPRFeedback` function detects **unresolved review threads** via GitHub GraphQL, not review state. A `REQUEST_CHANGES` review without inline comments does NOT create detectable threads.

### 3.5. Monitor Feedback Resolution and Auto-Merge

```bash
for i in $(seq 1 80); do
  STATUS=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('ticketSummary', []):
    title = b.get('title', '') or ''
    if 'array' in title.lower() or 'Address' in title or '#$PR_NUMBER' in title:
        marker = ' <-- FEEDBACK' if 'Address' in title else ''
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {title[:55]}{marker}')
for am in d.get('agentMeta', []):
    if am.get('status') != 'idle' and am.get('role') != 'frontDesk':
        hook = str(am.get('current_hook_ticket_id') or 'NULL')[:12]
        print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s} hook={hook}')
for e in d.get('alarmStatus', {}).get('recentEvents', [])[:5]:
    t = e.get('type', '')
    msg = e.get('message', '')
    if 'array' in msg.lower() or 'Address' in msg or 'feedback' in msg.lower():
        print(f'  EVT: {t:24s} {msg[:70]}')
" 2>/dev/null
  ALL_DONE=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tickets = d.get('ticketSummary', [])
relevant = [b for b in tickets if 'array' in str(b.get('title','')).lower() or 'Address' in str(b.get('title',''))]
if not relevant: print('DONE')
" 2>/dev/null)
  if [ "$ALL_DONE" = "DONE" ]; then echo "=== SCENARIO 3 COMPLETE ==="; break; fi
  sleep 15
done
```

### 3.6. Verify

```bash
# Check PR was merged
gh pr view $PR_NUMBER --repo $REPO --json state,mergedAt,mergedBy

# Verify review thread was resolved
gh api graphql -f query='query {
  repository(owner: "'$(echo $REPO | cut -d/ -f1)'", name: "'$(echo $REPO | cut -d/ -f2)'") {
    pullRequest(number: '$PR_NUMBER') {
      reviewThreads(first: 100) {
        nodes { isResolved, comments(first: 3) { nodes { body, author { login }, createdAt } } }
      }
    }
  }
}'

# Check no stray post-merge comments
MERGE_TIME=$(gh pr view $PR_NUMBER --repo $REPO --json mergedAt --jq '.mergedAt')
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  --jq ".[] | select(.created_at > \"$MERGE_TIME\") | {created_at, body: (.body[:80])}"
```

### Expected Outcome

- Soul creates PR
- Human adds REQUEST_CHANGES review with inline comment
- `poll_pr` detects unresolved review thread within ~30s
- Feedback ticket created: "Address review comments on PR #N"
- Feedback ticket has `parent_ticket_id` = MR ticket
- Soul dispatched to resolve feedback
- Soul pushes fix and resolves review thread on GitHub
- Auto-merge fires after ~2 min delay
- PR merged, no post-merge comments

### Expected Timeline

| Step | Duration |
|---|---|
| FrontDesk slings ticket | ~30s |
| Soul works + creates PR | 2-5 min |
| Human adds review comment | manual |
| Feedback detected by poll_pr | ~30s (poll cycle) |
| Soul resolves feedback | 1-3 min |
| Auto-merge grace period | 2 min |
| **Total (from human comment)** | **4-6 min** |

---

## Test A: Single Ticket Flow (Full Pipeline)

This is the original comprehensive test that exercises the full pipeline: soul → qualityAssurance review → human feedback → auto-resolve → auto-merge.

### A.1. Send Work to the FrontDesk

```bash
curl -s -m 120 -X POST $BASE/debug/departments/$DEPARTMENT_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a ticket for this task on the $WORKSTATION_ID workstation: Add a new utility file src/utils/string-helpers.ts with 5 string utility functions (capitalize, truncate, slugify, camelToKebab, kebabToCamel). Each function should have JSDoc comments. Commit and push when done.\"}"
```

### A.2. Wait for Soul to Create PR

The soul now creates the PR itself. Poll until the MR ticket appears with a PR URL:

```bash
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('ticketSummary', []):
    btype = b.get('type', '?')
    if btype in ('issue', 'merge_request'):
        print(f'  {btype:16s} {b.get(\"status\",\"?\"):12s} {str(b.get(\"title\",\"\"))[:55]}')
for am in d.get('agentMeta', []):
    if am.get('status') != 'idle':
        hook = str(am.get('current_hook_ticket_id', 'NULL') or 'NULL')[:12]
        print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s} hook={hook}')
for e in d.get('alarmStatus', {}).get('recentEvents', [])[:3]:
    t = e.get('type', '')
    if 'pr_' in t or 'created' in t or 'review' in t:
        print(f'  EVT: {t:20s} {e.get(\"message\",\"\")[:60]}')
" 2>/dev/null
  MR_READY=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('ticketSummary', []):
    if b.get('type') == 'merge_request':
        print('MR_EXISTS')
        break
" 2>/dev/null)
  if [ "$MR_READY" = "MR_EXISTS" ]; then echo "=== MR ticket CREATED (soul created PR) ==="; break; fi
  sleep 15
done
```

**Expected:** The soul creates the PR and calls `gt_done(branch, pr_url)`. The MR ticket appears as `open`.

### A.3. Verify PR Exists on GitHub

```bash
gh pr list --repo $REPO --state open --limit 5 --json number,title,headRefName,createdAt
```

Record the PR number:

```bash
PR_NUMBER=<number>
```

### A.4. Wait for QualityAssurance Review

The qualityAssurance is dispatched to review the existing PR. It runs quality gates, reviews the diff, and adds review comments. Watch for the qualityAssurance to complete:

```bash
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('ticketSummary', []):
    if b.get('type') == 'merge_request':
        print(f'  MR: status={b.get(\"status\",\"?\"):12s} {str(b.get(\"title\",\"\"))[:50]}')
for am in d.get('agentMeta', []):
    if am.get('role') == 'qualityAssurance' and am.get('status') != 'idle':
        print(f'  qualityAssurance: status={am.get(\"status\",\"?\"):10s}')
for e in d.get('alarmStatus', {}).get('recentEvents', [])[:3]:
    t = e.get('type', '')
    if 'pr_' in t or 'review' in t:
        print(f'  EVT: {t:20s} {e.get(\"message\",\"\")[:60]}')
" 2>/dev/null
  # MR in_progress means qualityAssurance called gt_done with pr_url
  IN_PROGRESS=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('ticketSummary', []):
    if b.get('type') == 'merge_request' and b.get('status') == 'in_progress':
        print('yes')
" 2>/dev/null)
  if [ "$IN_PROGRESS" = "yes" ]; then echo "=== qualityassurance DONE — MR in_progress, poll_pr active ==="; break; fi
  sleep 15
done
```

### A.5. Check for QualityAssurance Comments (Optional)

If the qualityAssurance requested changes, an auto-resolve cycle will begin automatically. Check:

```bash
gh api graphql -f query='query {
  repository(owner: "'$(echo $REPO | cut -d/ -f1)'", name: "'$(echo $REPO | cut -d/ -f2)'") {
    pullRequest(number: '$PR_NUMBER') {
      reviewThreads(first: 100) {
        nodes { isResolved, comments(first: 1) { nodes { body, author { login } } } }
      }
    }
  }
}'
```

### A.6. Add a Human Review Comment

To test the human feedback loop, add a review with inline comments:

```bash
gh api repos/$REPO/pulls/$PR_NUMBER/reviews \
  --method POST \
  --input - <<'EOF'
{
  "event": "REQUEST_CHANGES",
  "body": "The capitalize function needs input validation.",
  "comments": [
    {
      "path": "src/utils/string-helpers.ts",
      "position": 5,
      "body": "Please add input validation - handle empty strings and non-string inputs gracefully."
    }
  ]
}
EOF
```

**Note:** You must use inline comments (with `path` and `position`) to create review threads. The `checkPRFeedback` function detects **unresolved review threads** via GitHub GraphQL, not review state.

### A.7. Observe Feedback Detection and Resolution

```bash
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('ticketSummary', []):
    title = str(b.get('title', ''))
    if b.get('type') in ('issue', 'merge_request'):
        marker = ' <-- FEEDBACK' if ('Address' in title or 'PR #' in title) else ''
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {title[:50]}{marker}')
for am in d.get('agentMeta', []):
    if am.get('status') != 'idle':
        print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s}')
" 2>/dev/null
  sleep 10
done
```

### A.8. Wait for Auto-Merge

After all review threads are resolved and CI passes, the auto-merge timer starts (configured delay, e.g. 2 minutes). Monitor until all tickets close:

```bash
echo "Waiting for auto-merge..."
MERGE_START=$(date +%s)
for i in $(seq 1 60); do
  STATUS=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/status)
  ELAPSED=$(( $(date +%s) - MERGE_START ))
  echo "$(date +%H:%M:%S) [${ELAPSED}s]"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tickets = d.get('ticketSummary', [])
relevant = [b for b in tickets if b.get('type') in ('merge_request',) or 'string' in str(b.get('title','')).lower() or 'Address' in str(b.get('title',''))]
if not relevant:
    print('  ALL DONE')
else:
    for b in relevant:
        print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {str(b.get(\"title\",\"\"))[:50]}')
" 2>/dev/null
  ALL_DONE=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tickets = d.get('ticketSummary', [])
relevant = [b for b in tickets if b.get('type') in ('merge_request',) or 'string' in str(b.get('title','')).lower() or 'Address' in str(b.get('title',''))]
if not relevant: print('DONE')
" 2>/dev/null)
  if [ "$ALL_DONE" = "DONE" ]; then echo "=== AUTO-MERGE COMPLETE ==="; break; fi
  sleep 10
done
```

### A.9. Verify Merge

```bash
gh pr view $PR_NUMBER --repo $REPO --json state,mergedAt
```

---

## Test B: 3-ticket Shift Flow

This tests the review-and-merge shift mode where each ticket gets its own PR, review, and auto-merge.

### B.1. Send Shift Work to the FrontDesk

```bash
curl -s -m 120 -X POST $BASE/debug/departments/$DEPARTMENT_ID/send-message \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Create a shift of 3 tickets on the $WORKSTATION_ID workstation with merge mode review-and-merge. The tickets should be: (1) Add src/utils/array-helpers.ts with functions: unique, flatten, chunk, zip, groupBy. (2) Add src/utils/object-helpers.ts with functions: pick, omit, deepClone, merge, hasKey. (3) Add src/utils/math-helpers.ts with functions: clamp, lerp, roundTo, sum, average. Each file should have JSDoc comments and a simple test file alongside it. Use review-and-merge mode so each ticket gets its own PR.\"}"
```

### B.2. Monitor All 3 Tickets

Poll the status showing all tickets and their progress:

```bash
for i in $(seq 1 120); do
  STATUS=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/status)
  echo "$(date +%H:%M:%S)"
  echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tickets = d.get('ticketSummary', [])
for b in tickets:
    btype = b.get('type', '?')
    if btype in ('issue', 'merge_request', 'shift'):
        print(f'  {btype:16s} {b.get(\"status\",\"?\"):12s} {str(b.get(\"title\",\"\"))[:55]}')
agents = d.get('agentMeta', [])
active = [a for a in agents if a.get('status') != 'idle']
for am in active:
    hook = str(am.get('current_hook_ticket_id', 'NULL') or 'NULL')[:8]
    print(f'  {am.get(\"role\",\"?\"):12s} status={am.get(\"status\",\"?\"):10s} hook={hook}')
alarm = d.get('alarmStatus', {})
recon = alarm.get('reconciler', {})
actions = recon.get('actionsByType', {})
if actions:
    print(f'  reconciler: {json.dumps(actions)}')
" 2>/dev/null
  # Check if all relevant tickets are closed
  ALL_DONE=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tickets = d.get('ticketSummary', [])
relevant = [b for b in tickets if b.get('type') in ('issue', 'merge_request', 'shift') and ('helper' in str(b.get('title','')).lower() or 'Review' in str(b.get('title','')) or 'shift' in b.get('type',''))]
if not relevant: print('DONE')
" 2>/dev/null)
  if [ "$ALL_DONE" = "DONE" ]; then echo "=== ALL shift tickets COMPLETE ==="; break; fi
  sleep 15
done
```

### B.3. Verify All PRs Merged

```bash
gh pr list --repo $REPO --state merged --limit 10 --json number,title,mergedAt | python3 -c "
import sys, json
prs = json.load(sys.stdin)
today = '$(date -u +%Y-%m-%d)'
for pr in prs:
    if today in pr.get('mergedAt', ''):
        print(f'  PR #{pr[\"number\"]}: {pr[\"title\"]} (merged: {pr[\"mergedAt\"][:19]})')
"
```

---

## Test C: review-then-land Shift via Direct Sling

This tests the **review-then-land** shift mode where each sub-ticket gets its own PR into the shift's feature branch, and a final landing PR is created from the feature branch into the default branch (`main`).

Unlike Test B (which goes through the frontDesk's `gt_sling_batch` tool via a chat message), this test directly slings a shift through a debug endpoint, eliminating frontDesk LLM variability. Use this when you want a deterministic E2E test of the shift plumbing itself.

### Prereqs and Debug Endpoints

These dev-only endpoints are used by this test (all `application/json`, no auth in dev):

| Method | Path | Description |
|---|---|---|
| GET | `/debug/departments/:departmentId/workstations` | List workstations registered with the department (returns `{ workstations: [...] }`) |
| POST | `/debug/departments/:departmentId/sling-shift` | Directly call `Department.slingShift()` — bypasses the frontDesk |
| GET | `/debug/departments/:departmentId/shifts` | List active shifts with progress (`closed_tickets`/`total_tickets`) |

The `sling-shift` body matches `Department.slingShift()` input:

```json
{
  "workstationId": "<workstation-uuid>",
  "shiftTitle": "Bogus shift E2E test 175337",
  "merge_mode": "review-then-land",
  "staged": false,
  "tasks": [
    { "title": "Add src/utils/foo.ts with function bar" },
    { "title": "Add src/utils/baz.ts ...", "depends_on": [0] }
  ]
}
```

### C.1. Look Up the Workstation

```bash
WORKSTATION_ID=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/workstations | python3 -c "import sys, json; print(json.load(sys.stdin)['workstations'][0]['id'])")
echo "WORKSTATION_ID=$WORKSTATION_ID"
```

### C.2. Confirm Department Configured for review-then-land

```bash
curl -s $BASE/debug/departments/$DEPARTMENT_ID/config | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('merge_strategy:', d.get('merge_strategy'))
print('shift_merge_mode:', d.get('shift_merge_mode'))
print('qualityAssurance.auto_merge:', d.get('qualityAssurance',{}).get('auto_merge'))
"
```

If `shift_merge_mode` is not `review-then-land`, set it:

```bash
curl -s -X PATCH $BASE/debug/departments/$DEPARTMENT_ID/config \
  -H "Content-Type: application/json" \
  -d '{"shift_merge_mode":"review-then-land","merge_strategy":"pr","qualityAssurance":{"auto_merge":true,"auto_merge_delay_minutes":2}}'
```

### C.3. Sling a 3-ticket Shift

Use a unique title (timestamp suffix) so subsequent runs don't collide and the feature branch name is easy to grep for:

```bash
TIMESTAMP=$(date +%H%M%S)
TITLE="Bogus shift E2E test $TIMESTAMP"
RESPONSE=$(curl -s -X POST $BASE/debug/departments/$DEPARTMENT_ID/sling-shift \
  -H "Content-Type: application/json" \
  -d "{
    \"workstationId\": \"$WORKSTATION_ID\",
    \"shiftTitle\": \"$TITLE\",
    \"merge_mode\": \"review-then-land\",
    \"staged\": false,
    \"tasks\": [
      {\"title\": \"Add src/utils/bogus-step1.ts with a single function bogusGreet that returns 'hello bogus'. Include JSDoc. Commit and push.\"},
      {\"title\": \"Add src/utils/bogus-step2.ts with a single function bogusFarewell that returns 'goodbye bogus'. Include JSDoc. Commit and push.\", \"depends_on\": [0]},
      {\"title\": \"Add src/utils/bogus-step3.ts with a single function bogusEcho that takes a string and returns it prefixed with 'echo: '. Include JSDoc. Commit and push.\", \"depends_on\": [1]}
    ]
  }")
echo "$RESPONSE" | python3 -c "
import sys, json
r = json.load(sys.stdin)
c = r['shift']
print(f'SHIFT_ID={c[\"id\"]}')
print(f'FEATURE_BRANCH={c[\"feature_branch\"]}')
for i, b in enumerate(r['tickets']):
    print(f'ticket{i+1}={b[\"ticket\"][\"ticket_id\"]}')
"
```

Capture the printed env vars (`SHIFT_ID`, `FEATURE_BRANCH`, `ticket1..3`) into a sourceable file like `/tmp/shift-test.env` for the rest of the test.

### C.4. Monitor Through the Lifecycle

In **review-then-land** mode you should observe (linear chain of 3 tickets, each `depends_on` the previous):

1. Ticket 1 → `in_progress` → soul creates a sub-PR targeting `<feature_branch>` → MR ticket → qualityAssurance merges sub-PR → ticket 1 `closed`
2. Ticket 2 unblocks → same cycle, sub-PR into feature branch
3. Ticket 3 same
4. After last sub-ticket closes: a **landing MR ticket** is created with `feature_branch` → `main` PR
5. QualityAssurance reviews landing PR, auto-merge fires, shift → `closed`

Monitor with this loop:

```bash
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-\|-$//g' | head -c 40)
for i in $(seq 1 80); do
  echo "=== $(date +%H:%M:%S) ==="
  curl -s $BASE/debug/departments/$DEPARTMENT_ID/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
alarm = d.get('alarmStatus', {})
print(f'agents={json.dumps(alarm.get(\"agents\",{}))}  tickets={json.dumps(alarm.get(\"tickets\",{}))}')
for b in d.get('ticketSummary', []):
    title = (b.get('title','') or '')[:60]
    print(f'  {b.get(\"type\",\"?\"):16s} {b.get(\"status\",\"?\"):12s} {title}')
"
  curl -s $BASE/debug/departments/$DEPARTMENT_ID/shifts | python3 -c "
import sys, json
for c in json.load(sys.stdin).get('shifts', []):
    if c['id'] == '$SHIFT_ID':
        print(f'  shift {c[\"status\"]} closed={c[\"closed_tickets\"]}/{c[\"total_tickets\"]} landed={c[\"landed_at\"]}')
" 2>/dev/null
  gh pr list --repo $REPO --state all --search "head:shift/$SLUG" --limit 10 \
    --json number,title,headRefName,baseRefName,state,mergedAt 2>/dev/null | python3 -c "
import sys, json
prs = json.load(sys.stdin)
for pr in prs:
    print(f'  PR #{pr[\"number\"]:3d} {pr[\"state\"]:8s} {pr[\"headRefName\"][:40]} -> {pr[\"baseRefName\"][:40]}')
" 2>/dev/null
  # Stop when shift is gone from active list (indicates closed)
  ACTIVE=$(curl -s $BASE/debug/departments/$DEPARTMENT_ID/shifts | python3 -c "
import sys, json
ids = [c['id'] for c in json.load(sys.stdin).get('shifts', [])]
print('YES' if '$SHIFT_ID' in ids else 'NO')
" 2>/dev/null)
  if [ "$ACTIVE" = "NO" ]; then echo '=== shift CLOSED ==='; break; fi
  sleep 30
done
```

### C.5. Verify Final State

After the shift closes, check:

1. **Sub-ticket PRs** — one per non-failed ticket, each targeting the shift feature branch, all merged:

   ```bash
   gh pr list --repo $REPO --state all --search "head:$FEATURE_BRANCH" --limit 10 \
     --json number,title,baseRefName,headRefName,state,mergedAt | python3 -m json.tool
   ```

   Expect: each sub-ticket → `baseRefName: <feature_branch>`, `state: MERGED`. The landing PR → `baseRefName: main`, `state: MERGED`.

2. **Landing PR** — base=`main`, head=`<feature_branch>`, merged:

   ```bash
   gh pr view <landing-pr-number> --repo $REPO --json state,mergedAt,additions,deletions,changedFiles
   ```

3. **Files actually landed on main**:

   ```bash
   gh api "repos/$REPO/contents/src/utils?ref=main" --jq '.[] | select(.name | startswith("bogus")) | .name'
   ```

4. **Shift progress**: `closed_tickets == total_tickets`, `landed_at` set, shift ticket `status=closed`.

### Expected Timeline (review-then-land, 3 tickets)

| Step | Duration |
|---|---|
| Sling-shift creates 3 issue tickets + shift ticket | ~1s |
| Ticket 1 soul work + sub-PR + qualityAssurance merge | 3-5 min |
| Ticket 2 soul work + sub-PR + qualityAssurance merge | 3-5 min |
| Ticket 3 soul work + sub-PR + qualityAssurance merge | 3-5 min |
| Landing MR created, qualityAssurance reviews PR into `main` | 2-3 min |
| Auto-merge grace period | 2 min |
| **Total** | **15-25 min** |

### Known Issues Observed in This Flow

- **Soul occasionally pushes directly to feature branch instead of opening a sub-PR.** The MR ticket is still created (via `review_submitted`) and the qualityAssurance still merges the work into the feature branch, but `reviewMetadata.pr_url` is `null` and there is no GitHub PR for that sub-ticket. This is an LLM compliance issue in the soul prompt, not a code bug. The shift still lands successfully.
- **A failed sub-ticket does not block the shift from landing.** The reconciler treats `failed` blockers the same as `closed` (see `reconciler.ts:960`), so dependents will dispatch and the shift will land whatever did succeed. If sub-ticket 1 of 3 fails, the landing PR will only contain commits from tickets 2 and 3. This is by design but worth knowing when interpreting "successful" landings.
- **Container TLS handshake failures with `github.com`.** A wrangler-managed container may start with a 65535 MTU that breaks outgoing TLS to GitHub (`GnuTLS, handshake failed: The TLS connection was non-properly terminated`). Symptom: every `/agents/start` returns "FAILED for X: git fetch --all --prune failed". Fix: `docker kill $(docker ps -q --filter ancestor=cloudflare-dev/helldesk-container:*)` — wrangler will spin up a replacement that usually has a working network. The `cloneRepoInner` retry path treats this as non-auth so doesn't retry; the ticket burns through `MAX_DISPATCH_ATTEMPTS=5` and ends up `failed` if the container isn't restarted.

---

## Expected Timelines

### Scenario 1 (No Review + Auto-Merge)

| Step | Duration |
|---|---|
| FrontDesk slings ticket | ~30s |
| Soul works + creates PR | 2-5 min |
| Auto-merge grace period | 2 min |
| **Total** | **5-8 min** |

### Scenario 2 (QualityAssurance Review + Auto-Merge)

| Step | Duration |
|---|---|
| FrontDesk slings ticket | ~30s |
| Soul works + pushes code | 2-5 min |
| QualityAssurance reviews + creates PR | 1-3 min |
| Rework cycle (if needed) | 2-5 min |
| Auto-merge grace period | 2 min |
| **Total** | **6-15 min** |

### Scenario 3 (Human Feedback + Auto-Resolve + Auto-Merge)

| Step | Duration |
|---|---|
| FrontDesk slings ticket | ~30s |
| Soul works + creates PR | 2-5 min |
| Human adds review comment | manual |
| Feedback detected | ~30s |
| Soul resolves feedback | 1-3 min |
| Auto-merge grace period | 2 min |
| **Total (from task sent)** | **8-12 min** |

### 3-ticket Shift (review-and-merge)

| Step | Duration |
|---|---|
| FrontDesk creates shift + 3 tickets | ~1 min |
| 3 souls work in parallel + create PRs | 2-5 min |
| 3 qualityAssurance reviews (sequential per workstation) | 5-15 min |
| Feedback resolution cycles | 2-5 min each (if needed) |
| Auto-merge per PR | 2 min grace each |
| **Total** | **15-30 min** |

---

## Troubleshooting

### Soul Doesn't Create PR

If the soul pushes but doesn't create a PR:

- Check the soul's system prompt includes "Pull Request Creation" section
- Verify `merge_strategy` is `pr` in department settings
- Check wrangler logs for the soul's agent output

### QualityAssurance Dispatches Despite `code_review=false`

The reconciler's `code_review` bypass (reconciler.ts ~line 1167) only fast-tracks MR tickets that already have a `pr_url` in `review_metadata`. When a new MR ticket is created, there's a timing window where the MR ticket exists but has no `pr_url`, causing the reconciler to dispatch the qualityAssurance via Rule 5.

**Root cause:** The soul calls `review_submitted` which creates the MR ticket, but the `pr_url` is set asynchronously. During the gap, the reconciler treats it as a direct-merge MR (no `pr_url`), bypassing the `code_review=false` skip.

### QualityAssurance Tries to Create a New PR

If the qualityAssurance creates a duplicate PR instead of reviewing the existing one:

- Check that `review_metadata.pr_url` is set on the MR ticket (soul should have passed it)
- The qualityAssurance prompt switches to "PR review mode" only when `existingPrUrl` is set

### Feedback Not Detected

`checkPRFeedback` checks for **unresolved review threads** via GitHub GraphQL, not review state. A `REQUEST_CHANGES` review without inline/line comments does NOT create review threads. Use reviews with `comments[].path` and `comments[].position` to create detectable threads.

### Auto-Merge Stuck

- `allChecksPass` requires either (a) 0 check-runs (no CI = pass) or (b) all check-runs completed successfully. If the repo has CI, all checks must pass.
- The GitHub token in department config must be valid. Check wrangler logs for `401` errors from `checkPRStatus` or `checkPRFeedback`.
- Check `auto_merge_delay_minutes` is set (not null) in department config.

### Shift Tickets Not Dispatching

- In `review-and-merge` mode, each ticket is independent — no sequencing dependencies.
- In `review-then-land` mode, tickets with `blocks` dependencies wait for their predecessors. Intermediate tickets do NOT create PRs (the qualityAssurance merges directly to the feature branch).

### FrontDesk Creates Duplicate Tickets

When the frontDesk is already working (e.g., processing stale triage tickets) and receives a new message, it may create duplicate tickets for the same task. This leads to duplicate PRs and orphaned tickets. Wait for the frontDesk to be idle before sending new tasks.

### Container Networking (Local Dev)

The wrangler container runtime occasionally fails to route DO `container.fetch()` to the container's port 8080 — `send-message` returns `sessionStatus: "idle"` even though Docker shows the container as healthy. Workarounds:

1. **Have a human start wrangler** via the terminal (not `nohup`). The TTY seems to help with container proxy setup.
2. **Kill all containers and restart wrangler cleanly** — stale proxy state can prevent new connections.
3. **Wait 30-60s after wrangler starts** before sending messages — the container needs time to fully initialize.
4. The `GET /health` endpoint returning 200 does NOT mean the DO-to-container path works. The DO's `container.fetch()` uses a different routing mechanism.

---

## Debug Endpoints

All `/debug/` endpoints are unauthenticated in development. In production, they're protected by Cloudflare Access.

| Method | Path | Description |
|---|---|---|
| `GET` | `/debug/departments/:departmentId/status` | Primary status: agents, tickets, alarm, attendance, reconciler |
| `GET` | `/debug/departments/:departmentId/config` | Read department config (dev only) |
| `PATCH` | `/debug/departments/:departmentId/config` | Update department config (dev only, partial update) |
| `POST` | `/debug/departments/:departmentId/reconcile-dry-run` | Run reconciler without applying actions |
| `POST` | `/debug/departments/:departmentId/replay-events` | Replay events from time range |
| `GET` | `/debug/departments/:departmentId/drain-status` | Drain flag + nonce |
| `GET` | `/debug/departments/:departmentId/nudges` | Pending agent nudges |
| `POST` | `/debug/departments/:departmentId/send-message` | Send message to frontDesk (dev only) |
| `GET` | `/debug/departments/:departmentId/tickets/:ticketId` | Full ticket details + review metadata + dependencies |
| `POST` | `/debug/departments/:departmentId/graceful-stop` | Trigger SIGTERM on container (dev only) |
| `GET` | `/debug/departments/:departmentId/workstations` | List workstations registered with the department (dev only) |
| `POST` | `/debug/departments/:departmentId/sling-shift` | Directly call `Department.slingShift()` (dev only) |
| `GET` | `/debug/departments/:departmentId/shifts` | List active shifts with progress counts (dev only) |

### Inspect a Ticket

Get full ticket details including review_metadata and dependencies:

```bash
curl -s $BASE/debug/departments/$DEPARTMENT_ID/tickets/<ticket_id> | python3 -c "
import sys, json
d = json.load(sys.stdin)
ticket = d.get('ticket', {})
print(f'Type: {ticket.get(\"type\")}  Status: {ticket.get(\"status\")}')
print(f'Title: {ticket.get(\"title\")}')
print(f'Parent: {ticket.get(\"parent_ticket_id\", \"NULL\")}')
rm = d.get('reviewMetadata')
if rm:
    print(f'PR URL: {rm.get(\"pr_url\")}')
    print(f'Branch: {rm.get(\"branch\")} -> {rm.get(\"target_branch\")}')
    print(f'Auto-merge ready since: {rm.get(\"auto_merge_ready_since\", \"NULL\")}')
    print(f'Last feedback check: {rm.get(\"last_feedback_check_at\", \"NULL\")}')
deps = d.get('dependencies', [])
if deps:
    print(f'Dependencies ({len(deps)}):')
    for dep in deps:
        print(f'  {dep[\"ticket_id\"][:8]} -> {dep[\"depends_on_ticket_id\"][:8]} ({dep[\"dependency_type\"]})')
"
```

### Verify Ticket Chain (parent_ticket_id linkage)

After a rework or feedback cycle, verify the chain:

```bash
# Get the MR ticket
MR_ID=<mr_ticket_id>
curl -s $BASE/debug/departments/$DEPARTMENT_ID/tickets/$MR_ID | python3 -c "
import sys, json
d = json.load(sys.stdin)
deps = d.get('dependencies', [])
print('MR ticket dependencies:')
for dep in deps:
    print(f'  {dep[\"dependency_type\"]}: {dep[\"depends_on_ticket_id\"][:12]}')
"
# Then check a rework/feedback ticket's parent
REWORK_ID=<rework_ticket_id>
curl -s $BASE/debug/departments/$DEPARTMENT_ID/tickets/$REWORK_ID | python3 -c "
import sys, json
ticket = json.load(sys.stdin).get('ticket', {})
print(f'parent_ticket_id: {ticket.get(\"parent_ticket_id\", \"NULL\")}')
# Should match the MR ticket ID
"
```

---

## E2E Test Results — Round 2 (2026-04-05)

### Summary

| Scenario | Config | Result | PR | Notes |
|---|---|---|---|---|
| 1: No review + auto-merge | `code_review=false`, `auto_merge=true` | **PASS (with bug)** | #38 MERGED | QualityAssurance dispatched despite `code_review=false` (bug persists). PR merged after rework. |
| 2: QualityAssurance review (rework mode) | `code_review=true`, `review_mode=rework` | **FAIL** | None created | Soul pushed branch but never created PR. QualityAssurance stuck in rework-request loop 35+ min. |
| 3: Human feedback + auto-resolve | `code_review=false`, `auto_resolve_pr_feedback=true` | **FAIL** | None created | Same as Scenario 2: soul pushed branch but no PR. MR ticket stuck at `open`. |

### Bugs Found

#### Bug 1 (PERSISTS from round 1): QualityAssurance dispatches despite `code_review=false`

**Scenario:** 1
**Severity:** Medium
**Status:** Not fixed — the round 1 fix was insufficient.

When `code_review=false` and `merge_strategy=pr`, the qualityAssurance is still dispatched to review MR tickets. The reconciler's `code_review` bypass only works for MR tickets that already have a `pr_url` in `review_metadata`. When the soul creates the MR ticket via `review_submitted`, the MR ticket initially has `pr_url=null`. During this window, the reconciler falls through to the standard dispatch rule and sends the qualityAssurance.

In Scenario 1, the qualityAssurance happened to create the PR and complete a rework cycle, so the PR eventually merged. But this added ~3 minutes of unnecessary work and the qualityAssurance should not have been involved at all.

**Evidence:**

- 19:44:59Z: MR ticket created with `pr_url=null`, reconciler action `dispatch_agent: 1`
- 19:45:12Z: qualityAssurance `working` hook=8b5d6506
- 19:45:42Z: qualityAssurance created rework ticket "Rework: Add src/utils/set-helpers.ts..."
- 19:48:02Z: PR #38 merged after rework cycle

**Root cause location:** reconciler.ts, MR ticket dispatch rules — the `code_review=false` check requires `pr_url` to be set, but the soul doesn't pass `pr_url` in `review_submitted`.

#### Bug 2 (NEW): Soul does not create GitHub PRs

**Scenarios:** 2, 3 (and likely 1 — the qualityAssurance created it instead)
**Severity:** Critical — blocks the entire PR-based merge flow
**Status:** New

The soul pushes branches to GitHub successfully but does NOT call `gh pr create`. The MR ticket is created via `review_submitted` with `pr_url=null`. In the ticket body, the soul reports the commit was pushed, but no PR creation is mentioned.

**Evidence:**

- Scenario 2: branch `gt/toast/fa318809` exists on GitHub, 0 PRs associated
- Scenario 3: branch `gt/toast/4464f47b` exists on GitHub, 0 PRs associated
- Scenario 1: branch `gt/toast/38cba536` had PR #38, but that was created by the qualityAssurance (not the soul)

**Impact:** Without a `pr_url`:

- The `code_review=false` fast-track in the reconciler can't proceed to auto-merge
- The qualityAssurance (when dispatched) has no PR to review, leading to Bug 3
- Human feedback can't be added because there's no PR to comment on

**Likely cause:** The soul's system prompt or tooling may have changed. The soul calls `gt_done` with a branch but not a `pr_url`. Need to verify the soul's tool definitions include PR creation tooling, and that `merge_strategy=pr` is being communicated to the soul agent.

#### Bug 3 (NEW): QualityAssurance stuck in rework-request loop

**Scenario:** 2
**Severity:** High
**Status:** New

When `code_review=true` and the qualityAssurance is dispatched to an MR ticket with `pr_url=null`, the qualityAssurance enters a loop where it:

1. Reviews the diff (via git, not via GitHub PR)
2. Calls `gt_request_changes` to create a rework request
3. Continues working instead of unhoking and completing
4. After a delay (~10 min), calls `gt_request_changes` again with duplicate content
5. Creates duplicate rework/escalation tickets

**Evidence:**

- 19:50:03Z: MR ticket created with `pr_url=null`
- 19:51:00Z: qualityAssurance "Code review found gaps in test coverage; preparing rework request"
- 19:51:13Z: First rework request + escalation ticket created
- 20:02:01Z: Second rework request + escalation ticket created (duplicate)
- 20:12:35Z: Third rework request + escalation ticket (scope mismatch)
- 20:25+Z: qualityAssurance still `working` on same hook after 35+ minutes

**Impact:** Accumulates orphaned escalation/rework tickets. QualityAssurance is stuck indefinitely. GUPP attendance should eventually force-stop but hasn't triggered in the observed window.

#### Bug 4 (NEW): Duplicate rework/escalation tickets

**Scenario:** 2
**Severity:** Medium
**Status:** New (related to Bug 3)

The `gt_request_changes` tool call is not idempotent. Each call creates new rework and escalation tickets even when the qualityAssurance is re-issuing the same request for the same MR ticket. After 35 minutes, Scenario 2 accumulated:

- 5 escalation tickets (all "Rework requested: missing tests...")
- 5 "Escalation (low)" issue tickets
- 3 REWORK_REQUEST message tickets

These all remain `open` and clutter the ticket queue.

### Detailed Scenario Timelines

#### Scenario 1: code_review=false + auto_merge (PASS with bugs)

```
Config: merge_strategy=pr, code_review=false, auto_resolve_pr_feedback=false,
        auto_merge=true, auto_merge_delay_minutes=2
Task:   "Add src/utils/set-helpers.ts with union, intersection, difference,
         symmetricDifference, isSubset"
```

| Time (UTC) | Event |
|---|---|
| 19:38:42 | Task sent to frontDesk |
| 19:38:47 | Issue ticket created, frontDesk hooks it |
| 19:43:51 | FrontDesk unhooks, soul dispatched |
| 19:43:56 | Soul hooks ticket, starts implementing |
| 19:44:28 | Soul: "Set helper file added; committing and pushing" |
| 19:44:43 | Soul: "Creating pull request" |
| 19:44:59 | MR ticket created (`pr_url=null`). **BUG: qualityAssurance dispatched** |
| 19:45:42 | QualityAssurance requests rework, rework ticket created |
| 19:45:57 | Soul dispatched for rework |
| 19:46:58 | Rework ticket: qualityAssurance calls `gt_done`, `poll_pr` starts |
| 19:48:02 | **PR #38 merged** by kiloconnect-development bot |
| 19:48:13 | All tickets closed |

**Duration:** ~9.5 min (would be ~5 min without unnecessary qualityAssurance rework)
**PR:** #38 on branch `gt/toast/38cba536` — MERGED
**Post-merge comments:** None (clean)

#### Scenario 2: code_review=true + review_mode=rework (FAIL — stuck)

```
Config: merge_strategy=pr, code_review=true, review_mode=rework,
        auto_resolve_pr_feedback=false, auto_merge=true, auto_merge_delay_minutes=2
Task:   "Add src/utils/promise-helpers.ts with delay, retry, timeout,
         allSettledWithErrors, race"
```

| Time (UTC) | Event |
|---|---|
| 19:49:20 | Task sent to frontDesk |
| 19:49:35 | Issue ticket created, soul dispatched |
| 19:49:44 | Soul: "Implementing promise helper utilities" |
| 19:50:03 | MR ticket created (`pr_url=null`). QualityAssurance dispatched (expected). |
| 19:51:00 | QualityAssurance: "Code review found gaps in test coverage" |
| 19:51:13 | First rework request + escalation tickets (2 each) |
| 20:02:01 | **Second rework request** (duplicate) — qualityAssurance still working |
| 20:12:35 | Third rework request (scope mismatch) |
| 20:25+ | **QualityAssurance still stuck** on MR ticket after 35+ min |

**Duration:** 35+ min (never completed)
**PR:** None created on GitHub
**Branch:** `gt/toast/fa318809` exists on GitHub but has no PR
**Orphaned tickets:** 5 escalation + 5 escalation(low) issue + 3 REWORK_REQUEST message

#### Scenario 3: code_review=false + auto_resolve + human feedback (FAIL — stuck)

```
Config: merge_strategy=pr, code_review=false, auto_resolve_pr_feedback=true,
        auto_merge=true, auto_merge_delay_minutes=2
Task:   "Add src/utils/regex-helpers.ts with escapeRegex, isValidRegex,
         matchAll, replaceAll, extractGroups"
```

| Time (UTC) | Event |
|---|---|
| 20:13:09 | Task sent to frontDesk |
| 20:13:25 | Issue ticket created, soul dispatched |
| 20:14:01 | Soul: "Implementing regex helper utilities" |
| 20:14:05 | MR ticket created (`pr_url=null`), soul unhooks |
| 20:14:17 | MR ticket status=`open`, no assignee, no dispatch |
| 20:25+ | **MR ticket still `open`** — no one picks it up |

**Duration:** 10+ min (never completed)
**PR:** None created on GitHub
**Branch:** `gt/toast/4464f47b` exists on GitHub but has no PR
**Human feedback test:** Could not proceed — no PR to add comments to

### Config Commands Used

```bash
BASE=http://localhost:8803
DEPARTMENT_ID=a093a551-ff4d-4c36-9274-252df66128fd

# Scenario 1
curl -s -X PATCH $BASE/debug/departments/$DEPARTMENT_ID/config \
  -H "Content-Type: application/json" \
  -d '{"merge_strategy":"pr","qualityAssurance":{"code_review":false,"auto_merge":true,"auto_resolve_pr_feedback":false,"auto_merge_delay_minutes":2,"review_mode":"rework"}}'

# Scenario 2
curl -s -X PATCH $BASE/debug/departments/$DEPARTMENT_ID/config \
  -H "Content-Type: application/json" \
  -d '{"merge_strategy":"pr","qualityAssurance":{"code_review":true,"auto_merge":true,"auto_resolve_pr_feedback":false,"auto_merge_delay_minutes":2,"review_mode":"rework"}}'

# Scenario 3
curl -s -X PATCH $BASE/debug/departments/$DEPARTMENT_ID/config \
  -H "Content-Type: application/json" \
  -d '{"merge_strategy":"pr","qualityAssurance":{"code_review":false,"auto_merge":true,"auto_resolve_pr_feedback":true,"auto_merge_delay_minutes":2,"review_mode":"rework"}}'
```

### Recommended Fixes (Priority Order)

1. **Bug 2 (Critical): Soul must create PRs.** When `merge_strategy=pr`, the soul's `review_submitted` event must include a `pr_url`. Either:
   - Ensure the soul system prompt instructs PR creation via `gh pr create` before calling `gt_done`
   - Or have the MR ticket creation logic (in `review_submitted` handler) create the PR server-side using the branch name and GitHub token

2. **Bug 1 (Medium): Reconciler fast-track for `code_review=false`.** The reconciler's MR ticket dispatch logic should not require `pr_url` to honor `code_review=false`. When `code_review=false`, the MR ticket should be fast-tracked to `in_progress` regardless of `pr_url` presence.

3. **Bug 3 (High): QualityAssurance should bail when no PR exists.** If the qualityAssurance is dispatched to an MR ticket with `pr_url=null`, it should either:
   - Create the PR itself (current Scenario 1 behavior, which accidentally worked)
   - Or fail gracefully and unhook with an error message

4. **Bug 4 (Medium): Deduplicate rework requests.** The `gt_request_changes` tool should check if an active rework request already exists for the same MR ticket before creating a new one.
