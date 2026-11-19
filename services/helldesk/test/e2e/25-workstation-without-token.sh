#!/usr/bin/env bash
# Test 25: Create a workstation WITHOUT kilocode_token and verify behavior
# This simulates what happens if the token generation fails or is omitted
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  ═══ Step 1: Create department ═══"
api_post "/api/users/${USER_ID}/departments" '{"name":"No-Token-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  ═══ Step 2: Create workstation WITHOUT kilocode_token ═══"
api_post "/api/users/${USER_ID}/workstations" "$(jq -n --arg t "$DEPARTMENT_ID" \
  '{department_id: $t, name: "no-token-workstation", git_url: "https://github.com/test/repo.git", default_branch: "main"}')"
assert_status "201" "create workstation without token"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Workstation: ${WORKSTATION_ID}"

echo "  ═══ Step 3: Check department config (should have no token) ═══"
api_get "/api/departments/${DEPARTMENT_ID}/config"
assert_status "200" "get config"
TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // "NONE"')
echo "  Department config kilocode_token: ${TOKEN}"
# Token should be NONE since we didn't pass one
assert_eq "$TOKEN" "NONE" "should have no token when workstation created without one"

echo "  ═══ Step 4: Check wrangler logs for configureWorkstation ═══"
echo "  configureWorkstation logs:"
grep "configureWorkstation" "$WRANGLER_LOG" | sed 's/^/    /' || echo "    (none)"

echo "  No-token workstation OK"
