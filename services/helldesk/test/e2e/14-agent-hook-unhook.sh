#!/usr/bin/env bash
# Test 14: Hook and unhook an agent from a ticket
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

api_post "/api/users/${USER_ID}/departments" '{"name":"Hook-department"}'
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_DEPARTMENT_ID="$DEPARTMENT_ID"

api_post "/api/users/${USER_ID}/workstations" "$(jq -n --arg department_id "$DEPARTMENT_ID" \
  '{department_id: $department_id, name: "hook-workstation", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

# Register agent and create ticket
api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents" '{"role":"soul","name":"HookSoul","identity":"hook-1"}'
AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/tickets" '{"type":"issue","title":"Hook ticket"}'
TICKET_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Hooking agent to ticket..."
api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents/${AGENT_ID}/hook" "{\"ticket_id\":\"${TICKET_ID}\"}"
assert_status "200" "hook agent"

# Verify agent has the hook
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents/${AGENT_ID}"
assert_json "$HTTP_BODY" ".data.current_hook_ticket_id" "$TICKET_ID" "agent should be hooked"

# Verify ticket is in_progress
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/tickets/${TICKET_ID}"
assert_json "$HTTP_BODY" ".data.status" "in_progress" "ticket should be in_progress"

echo "  Unhooking agent..."
api_call DELETE "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents/${AGENT_ID}/hook"
assert_status "200" "unhook agent"

# Verify agent is unhooked
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/agents/${AGENT_ID}"
assert_json "$HTTP_BODY" ".data.current_hook_ticket_id" "null" "agent should be unhooked"

echo "  Hook/unhook OK"
