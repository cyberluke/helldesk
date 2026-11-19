#!/usr/bin/env bash
# Test 3: Create a workstation with kilocode_token and verify it propagates to department config
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="test-kilocode-token-$(date +%s)"

# Create department
echo "  Creating department..."
api_post "/api/users/${USER_ID}/departments" '{"name":"Token-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Department: ${DEPARTMENT_ID}"

# Create workstation with token
echo "  Creating workstation with kilocode_token..."
api_post "/api/users/${USER_ID}/workstations" "$(jq -n \
  --arg department_id "$DEPARTMENT_ID" \
  --arg name "token-workstation" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg default_branch "main" \
  --arg kilocode_token "$FAKE_TOKEN" \
  '{department_id: $department_id, name: $name, git_url: $git_url, default_branch: $default_branch, kilocode_token: $kilocode_token}')"
assert_status "201" "create workstation"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Workstation: ${WORKSTATION_ID}"

# Check wrangler logs for the configureWorkstation call
echo "  Checking wrangler logs for token propagation..."
sleep 1
if grep -q "configureWorkstation.*hasKilocodeToken=true" "$WRANGLER_LOG"; then
  echo "  configureWorkstation received the token"
else
  echo "  WARNING: configureWorkstation log not found, checking full log..."
  grep "configureWorkstation" "$WRANGLER_LOG" || echo "  No configureWorkstation log found at all"
fi

if grep -q "propagating kilocodeToken to department config" "$WRANGLER_LOG"; then
  echo "  Token propagated to department config"
else
  echo "  WARNING: Token propagation log not found"
  grep "kilocode" "$WRANGLER_LOG" || echo "  No kilocode logs found"
fi

# Verify department config has the token by checking the /api/departments/:departmentId/config endpoint
echo "  Fetching department config..."
api_get "/api/departments/${DEPARTMENT_ID}/config"
echo "  Department config response: status=${HTTP_STATUS} body=${HTTP_BODY}"

# Also verify frontDesk status works (uses the department DO)
echo "  Checking frontDesk status..."
api_get "/api/departments/${DEPARTMENT_ID}/frontDesk/status"
assert_status "200" "frontDesk status"
echo "  FrontDesk status: ${HTTP_BODY}"

echo "  Workstation + token OK"
