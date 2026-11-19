#!/usr/bin/env bash
# Test 15: Send memo between agents and check delivery
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
api_post "/api/users/${USER_ID}/departments" '{"name":"memo-department"}'
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_DEPARTMENT_ID="$DEPARTMENT_ID"

api_post "/api/users/${USER_ID}/workstations" "$(jq -n --arg t "$DEPARTMENT_ID" '{department_id: $t, name: "memo-workstation", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents" '{"role":"soul","name":"Sender","identity":"sender-1"}'
SENDER_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents" '{"role":"soul","name":"Receiver","identity":"receiver-1"}'
RECEIVER_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Sending memo..."
api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/memo" "$(jq -n --arg from "$SENDER_ID" --arg to "$RECEIVER_ID" \
  '{from_agent_id: $from, to_agent_id: $to, subject: "test", body: "hello"}')"
assert_status "201" "send memo"

echo "  Checking memo for receiver..."
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents/${RECEIVER_ID}/memo"
assert_status "200" "check memo"
MEMO_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$MEMO_COUNT" "1" "should have 1 memo"
assert_json "$HTTP_BODY" ".data[0].subject" "test" "memo subject"

echo "  Checking memo again (should be empty — already delivered)..."
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents/${RECEIVER_ID}/memo"
assert_status "200" "check memo again"
MEMO_COUNT2=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$MEMO_COUNT2" "0" "should have 0 memo (already delivered)"

echo "  Memo OK"
