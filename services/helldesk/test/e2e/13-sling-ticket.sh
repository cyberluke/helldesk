#!/usr/bin/env bash
# Test 13: Sling a ticket (atomic create ticket + assign agent)
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

api_post "/api/users/${USER_ID}/departments" '{"name":"Sling-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_DEPARTMENT_ID="$DEPARTMENT_ID"

api_post "/api/users/${USER_ID}/workstations" "$(jq -n --arg department_id "$DEPARTMENT_ID" \
  '{department_id: $department_id, name: "sling-workstation", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
assert_status "201" "create workstation"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Slinging ticket..."
api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/sling" '{"title":"Slung ticket","body":"Do something","priority":"high"}'
assert_status "201" "sling ticket"
assert_json_exists "$HTTP_BODY" ".data.ticket.id" "slung ticket should have id"
assert_json_exists "$HTTP_BODY" ".data.agent.id" "slung ticket should have agent"
assert_json "$HTTP_BODY" ".data.ticket.status" "in_progress" "slung ticket should be in_progress"

TICKET_ID=$(echo "$HTTP_BODY" | jq -r '.data.ticket.id')
AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.agent.id')
echo "  Slung ticket=${TICKET_ID} → agent=${AGENT_ID}"

# Verify agent is hooked to the ticket
echo "  Checking agent hook..."
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents/${AGENT_ID}"
assert_status "200" "get agent"
assert_json "$HTTP_BODY" ".data.current_hook_ticket_id" "$TICKET_ID" "agent should be hooked to ticket"

echo "  Sling OK"
