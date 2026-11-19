#!/usr/bin/env bash
# Test 12: Register an agent and list agents
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

api_post "/api/users/${USER_ID}/departments" '{"name":"Agent-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_DEPARTMENT_ID="$DEPARTMENT_ID"

api_post "/api/users/${USER_ID}/workstations" "$(jq -n --arg department_id "$DEPARTMENT_ID" \
  '{department_id: $department_id, name: "agent-workstation", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
assert_status "201" "create workstation"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Registering agent..."
api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents" '{"role":"soul","name":"TestSoul","identity":"test-soul-1"}'
assert_status "201" "register agent"
assert_json "$HTTP_BODY" ".data.role" "soul" "agent role"
assert_json "$HTTP_BODY" ".data.name" "TestSoul" "agent name"
assert_json "$HTTP_BODY" ".data.status" "idle" "agent should be idle"
AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Agent: ${AGENT_ID}"

echo "  Listing agents..."
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents"
assert_status "200" "list agents"
AGENT_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$AGENT_COUNT" "1" "should have 1 agent"

echo "  Getting agent by ID..."
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents/${AGENT_ID}"
assert_status "200" "get agent"
assert_json "$HTTP_BODY" ".data.id" "$AGENT_ID" "agent id"

echo "  Agent register OK"
