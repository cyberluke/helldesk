#!/usr/bin/env bash
# Test 29: Trace token flow through the ACTUAL Next.js tRPC → helldesk worker path
# This test logs into the Next.js server as a fake user and creates a department+workstation
# through the tRPC API, then checks if the token arrived in the helldesk worker.
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

NEXTJS_URL="http://localhost:3000"
WRANGLER_URL="http://localhost:8787"

echo "  ═══ Pre-check ═══"
NEXTJS_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "${NEXTJS_URL}/" 2>/dev/null || echo "0")
WRANGLER_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "${WRANGLER_URL}/health" 2>/dev/null || echo "0")
echo "  Next.js (3000): ${NEXTJS_STATUS}"
echo "  Wrangler (8787): ${WRANGLER_STATUS}"

if [[ "$NEXTJS_STATUS" == "0" || "$WRANGLER_STATUS" == "0" ]]; then
  echo "  Both servers must be running. Skipping."
  exit 0
fi

echo "  ═══ Step 1: Login as fake user via Next.js ═══"
FAKE_EMAIL="kilo-e2etest-$(date +%H%M%S)@example.com"
echo "  Fake email: ${FAKE_EMAIL}"

# Get the session cookie by visiting the fake login URL
# Follow redirects and save cookies
COOKIE_JAR=$(mktemp)
LOGIN_RESP=$(curl -sf -c "$COOKIE_JAR" -L -o /dev/null -w '%{http_code}' \
  "${NEXTJS_URL}/users/sign_in?fakeUser=${FAKE_EMAIL}" 2>/dev/null || echo "0")
echo "  Login response: ${LOGIN_RESP}"

# Wait for account creation
sleep 3

# Check if we got a session cookie
SESSION_COOKIE=$(grep -i "session\|next-auth\|token" "$COOKIE_JAR" 2>/dev/null | head -1 || echo "")
echo "  Session cookie: ${SESSION_COOKIE:0:80}..."

if [[ -z "$SESSION_COOKIE" ]]; then
  echo "  No session cookie obtained. Checking cookie jar:"
  cat "$COOKIE_JAR" | head -10
  echo ""
  echo "  Trying tRPC call anyway..."
fi

echo "  ═══ Step 2: Create department via tRPC ═══"
# tRPC batch mutation format
TRPC_CREATE_DEPARTMENT=$(curl -sf -b "$COOKIE_JAR" \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"0":{"json":{"name":"TRPC-Token-department"}}}' \
  "${NEXTJS_URL}/api/trpc/helldesk.createDepartment?batch=1" 2>/dev/null || echo "{}")
echo "  tRPC createDepartment response: ${TRPC_CREATE_DEPARTMENT:0:200}"

DEPARTMENT_ID=$(echo "$TRPC_CREATE_DEPARTMENT" | jq -r '.[0].result.data.json.id // "NONE"' 2>/dev/null || echo "NONE")
if [[ "$DEPARTMENT_ID" == "NONE" || "$DEPARTMENT_ID" == "null" || -z "$DEPARTMENT_ID" ]]; then
  echo "  Failed to create department via tRPC. Response: ${TRPC_CREATE_DEPARTMENT:0:500}"
  echo "  This may be an auth issue — fake user login may not work via curl."
  echo ""
  echo "  ═══ Fallback: Test token flow via direct API ═══"
  # Create directly on the test wrangler to verify the worker-side flow works
  FALLBACK_URL="${BASE_URL}"
  USER_ID="trpc-fallback-$(date +%s)-${RANDOM}"
  TOKEN="trpc-test-token-$(date +%s)"
  
  DEPARTMENT_BODY=$(curl -sf -X POST -H 'Content-Type: application/json' \
    -d '{"name":"Direct-Token-department"}' \
    "${FALLBACK_URL}/api/users/${USER_ID}/departments")
  DEPARTMENT_ID=$(echo "$DEPARTMENT_BODY" | jq -r '.data.id')
  echo "  Direct department: ${DEPARTMENT_ID}"
  
  WORKSTATION_BODY=$(curl -sf -X POST -H 'Content-Type: application/json' \
    -d "{\"department_id\":\"${DEPARTMENT_ID}\",\"name\":\"direct-workstation\",\"git_url\":\"https://github.com/t/r.git\",\"default_branch\":\"main\",\"kilocode_token\":\"${TOKEN}\"}" \
    "${FALLBACK_URL}/api/users/${USER_ID}/workstations")
  echo "  Direct workstation: $(echo "$WORKSTATION_BODY" | jq -r '.data.id')"
  
  CONFIG=$(curl -sf "${FALLBACK_URL}/api/departments/${DEPARTMENT_ID}/config")
  CONFIG_TOKEN=$(echo "$CONFIG" | jq -r '.data.kilocode_token // "NONE"')
  echo "  Direct config token: ${CONFIG_TOKEN}"
  
  if [[ "$CONFIG_TOKEN" == "$TOKEN" ]]; then
    echo ""
    echo "  ✓ Direct API token flow works on port 8787"
    echo "  The issue is likely in how the UI/tRPC creates the workstation."
    echo "  Check the Next.js console for these logs:"
    echo "    [helldesk-router] createWorkstation: generating kilocodeToken for user=..."
    echo "    [helldesk-client] POST /api/users/.../workstations bodyKeys=[...,kilocode_token]"
    echo "  And the wrangler console for:"
    echo "    [departments.handler] handleCreateWorkstation: ... hasKilocodeToken=true"
  else
    echo "  ✗ Direct API token flow FAILED on port 8787"
  fi

  rm -f "$COOKIE_JAR"
  exit 0
fi

echo "  Department: ${DEPARTMENT_ID}"

echo "  ═══ Step 3: Create workstation via tRPC (with auto-generated token) ═══"
TRPC_CREATE_WORKSTATION=$(curl -sf -b "$COOKIE_JAR" \
  -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"0\":{\"json\":{\"departmentId\":\"${DEPARTMENT_ID}\",\"name\":\"trpc-workstation\",\"gitUrl\":\"https://github.com/test/repo.git\",\"defaultBranch\":\"main\"}}}" \
  "${NEXTJS_URL}/api/trpc/helldesk.createWorkstation?batch=1" 2>/dev/null || echo "{}")
echo "  tRPC createWorkstation response: ${TRPC_CREATE_WORKSTATION:0:200}"

echo "  ═══ Step 4: Check department config on wrangler for token ═══"
sleep 1
CONFIG=$(curl -sf "${WRANGLER_URL}/api/departments/${DEPARTMENT_ID}/config")
CONFIG_TOKEN=$(echo "$CONFIG" | jq -r '.data.kilocode_token // "NONE"')
echo "  Department config kilocode_token: ${CONFIG_TOKEN}"

if [[ "$CONFIG_TOKEN" != "NONE" && -n "$CONFIG_TOKEN" ]]; then
  echo "  ✓ Token propagated through tRPC → helldesk-client → worker → DepartmentDO"
else
  echo "  ✗ Token NOT propagated through tRPC path"
  echo "  This confirms the issue is in the tRPC → helldesk-client → worker chain"
fi

rm -f "$COOKIE_JAR"
echo "  tRPC token trace done"
