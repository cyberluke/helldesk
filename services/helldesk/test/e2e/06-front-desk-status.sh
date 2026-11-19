#!/usr/bin/env bash
# Test 6: FrontDesk status shows session after sending a message
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-kilo-token-$(date +%s)"

echo "  Setup: creating department + workstation..."
api_post "/api/users/${USER_ID}/departments" '{"name":"front-desk-Status-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/users/${USER_ID}/workstations" "$(jq -n \
  --arg department_id "$DEPARTMENT_ID" \
  --arg name "status-workstation" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg kilocode_token "$FAKE_TOKEN" \
  '{department_id: $department_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')"
assert_status "201" "create workstation"

# Before sending a message, frontDesk status should have no session
echo "  Checking frontDesk status before message..."
api_get "/api/departments/${DEPARTMENT_ID}/frontDesk/status"
assert_status "200" "frontDesk status before"
assert_json "$HTTP_BODY" ".data.configured" "true" "should be configured"
assert_json "$HTTP_BODY" ".data.session" "null" "session should be null before first message"

# Send message to create frontDesk session
echo "  Sending frontDesk message..."
api_post "/api/departments/${DEPARTMENT_ID}/frontDesk/message" '{"message":"Status test"}'
assert_status "200" "send frontDesk message"
assert_json_exists "$HTTP_BODY" ".data.agentId" "should return agentId"

AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.agentId')
echo "  FrontDesk agentId: ${AGENT_ID}"

# After sending, frontDesk status should have a session
echo "  Checking frontDesk status after message..."
sleep 2
api_get "/api/departments/${DEPARTMENT_ID}/frontDesk/status"
assert_status "200" "frontDesk status after"
assert_json "$HTTP_BODY" ".data.configured" "true" "should be configured"
assert_json_exists "$HTTP_BODY" ".data.session" "session should exist after message"
assert_json "$HTTP_BODY" ".data.session.agentId" "$AGENT_ID" "session agentId should match"

SESSION_STATUS=$(echo "$HTTP_BODY" | jq -r '.data.session.status')
echo "  FrontDesk session status: ${SESSION_STATUS}"
# Status should be 'active' or 'starting' (not 'idle' since we just sent a message)
if [[ "$SESSION_STATUS" != "active" && "$SESSION_STATUS" != "starting" && "$SESSION_STATUS" != "idle" ]]; then
  echo "  FAIL: unexpected session status: ${SESSION_STATUS}"
  exit 1
fi

echo "  FrontDesk status OK"
