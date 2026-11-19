#!/usr/bin/env bash
# Test 26: Verify token flow through the Next.js tRPC layer
# This test calls the helldesk worker directly (simulating what helldesk-client.ts does)
# to check if the token arrives when included in the POST body
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
KNOWN_TOKEN="e2e-nextjs-token-$(date +%s)"

echo "  ═══ Step 1: Create department via helldesk worker ═══"
api_post "/api/users/${USER_ID}/departments" '{"name":"NextJS-Token-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Department: ${DEPARTMENT_ID}"

echo "  ═══ Step 2: Create workstation with explicit kilocode_token ═══"
WORKSTATION_PAYLOAD=$(jq -n \
  --arg department_id "$DEPARTMENT_ID" \
  --arg name "nextjs-workstation" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg kilocode_token "$KNOWN_TOKEN" \
  '{department_id: $department_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')
echo "  Payload: $(echo "$WORKSTATION_PAYLOAD" | jq -c '.')"

api_post "/api/users/${USER_ID}/workstations" "$WORKSTATION_PAYLOAD"
assert_status "201" "create workstation with token"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Workstation: ${WORKSTATION_ID}"

echo "  ═══ Step 3: Verify token in department config ═══"
api_get "/api/departments/${DEPARTMENT_ID}/config"
AFTER_TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // "NONE"')
echo "  Department config kilocode_token: ${AFTER_TOKEN}"
assert_eq "$AFTER_TOKEN" "$KNOWN_TOKEN" "token should be propagated"

echo "  ═══ Step 4: Now try calling the NEXT.JS server on port 3000 ═══"
echo "  Checking if Next.js is running..."
NEXTJS_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "http://localhost:3000/" 2>/dev/null || echo "0")
echo "  Next.js status: ${NEXTJS_STATUS}"

if [[ "$NEXTJS_STATUS" != "0" ]]; then
  echo "  Next.js is running. Checking what HELLDESK_SERVICE_URL it uses..."
  # We can't directly check env vars, but we can verify the helldesk worker
  # is reachable at the URL the Next.js server expects
  
  # Check if wrangler is running on port 8787 (Next.js default target)
  WRANGLER_8787=$(curl -sf -o /dev/null -w '%{http_code}' "http://localhost:8787/health" 2>/dev/null || echo "0")
  echo "  Port 8787 health: ${WRANGLER_8787}"
  
  # Check our test port
  WRANGLER_TEST=$(curl -sf -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/health" 2>/dev/null || echo "0")
  echo "  Port ${PORT} health: ${WRANGLER_TEST}"
  
  if [[ "$WRANGLER_8787" == "0" ]]; then
    echo ""
    echo "  ⚠ WARNING: No helldesk worker on port 8787!"
    echo "  The Next.js server (port 3000) points HELLDESK_SERVICE_URL to localhost:8787"
    echo "  but your helldesk worker is running on port ${PORT}."
    echo "  When creating workstations via the UI, the token goes to port 8787 (nowhere)!"
    echo "  To fix: either run 'wrangler dev' on port 8787, or set"
    echo "  HELLDESK_SERVICE_URL=http://localhost:${PORT} in your .env"
  elif [[ "$WRANGLER_8787" != "200" ]]; then
    echo ""
    echo "  ⚠ WARNING: Port 8787 returned ${WRANGLER_8787} (not 200)"
    echo "  The helldesk worker may not be healthy"
  fi
else
  echo "  Next.js not running on port 3000 — skipping cross-service check"
fi

echo "  NextJS workstation creation test OK"
