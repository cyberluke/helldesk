#!/usr/bin/env bash
# Test 23: Detailed token propagation trace
# Creates a workstation with a known token and traces it through every layer
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
KNOWN_TOKEN="e2e-trace-token-KNOWN-$(date +%s)"

echo "  ═══ Step 1: Create department ═══"
api_post "/api/users/${USER_ID}/departments" '{"name":"Token-Trace-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Department: ${DEPARTMENT_ID}"

echo "  ═══ Step 2: Check department config BEFORE workstation creation ═══"
api_get "/api/departments/${DEPARTMENT_ID}/config"
assert_status "200" "get config before"
BEFORE_TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // "NONE"')
echo "  Department config kilocode_token before workstation: ${BEFORE_TOKEN}"
assert_eq "$BEFORE_TOKEN" "NONE" "should have no token before workstation creation"

echo "  ═══ Step 3: Create workstation with known token ═══"
WORKSTATION_BODY=$(jq -n \
  --arg department_id "$DEPARTMENT_ID" \
  --arg name "trace-workstation" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg kilocode_token "$KNOWN_TOKEN" \
  '{department_id: $department_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')
echo "  POST body: ${WORKSTATION_BODY}"
api_post "/api/users/${USER_ID}/workstations" "$WORKSTATION_BODY"
assert_status "201" "create workstation"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Workstation: ${WORKSTATION_ID}"

echo "  ═══ Step 4: Check department config AFTER workstation creation ═══"
api_get "/api/departments/${DEPARTMENT_ID}/config"
assert_status "200" "get config after"
AFTER_TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // "NONE"')
echo "  Department config kilocode_token after workstation: ${AFTER_TOKEN}"

if [[ "$AFTER_TOKEN" == "NONE" || -z "$AFTER_TOKEN" ]]; then
  echo "  FAIL: Token was NOT propagated to department config!"
  echo "  Full department config: ${HTTP_BODY}"
  
  echo ""
  echo "  ═══ Checking wrangler logs for clues ═══"
  echo "  configureWorkstation logs:"
  grep "configureWorkstation" "$WRANGLER_LOG" | sed 's/^/    /' || echo "    (none)"
  echo "  kilocode/token logs:"
  grep -i "kilocode\|token" "$WRANGLER_LOG" | head -15 | sed 's/^/    /' || echo "    (none)"
  echo "  Department DO update logs:"
  grep "updateDepartmentConfig\|propagating" "$WRANGLER_LOG" | sed 's/^/    /' || echo "    (none)"
  
  exit 1
fi

assert_eq "$AFTER_TOKEN" "$KNOWN_TOKEN" "token should match the known token"

echo "  ═══ Step 5: Send frontDesk message and check container receives token ═══"
CURRENT_DEPARTMENT_ID="$DEPARTMENT_ID"
api_post "/api/departments/${DEPARTMENT_ID}/frontDesk/message" '{"message":"Token trace test"}'
assert_status "200" "send frontDesk message"

sleep 15

echo "  Checking wrangler logs for X-department-Config..."
if grep -q "hasKilocodeToken=true" "$WRANGLER_LOG"; then
  echo "  ✓ X-department-Config delivered with token"
else
  echo "  ✗ X-department-Config did NOT have token"
  grep "X-department-Config\|hasKilocodeToken" "$WRANGLER_LOG" | sed 's/^/    /' || echo "    (none)"
  exit 1
fi

echo "  Checking container for KILO_CONFIG_CONTENT..."
for cid in $(docker ps -q 2>/dev/null); do
  if docker logs "$cid" 2>&1 | grep -q "KILO_CONFIG_CONTENT set"; then
    echo "  ✓ Container $cid: KILO_CONFIG_CONTENT set"
    break
  fi
done

echo "  Token propagation trace OK"
