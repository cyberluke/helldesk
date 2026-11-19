#!/usr/bin/env bash
# Test 19: Escalation tickets — create an escalation-type ticket, list escalations
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
api_post "/api/users/${USER_ID}/departments" '{"name":"Escalation-department"}'
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_DEPARTMENT_ID="$DEPARTMENT_ID"

api_post "/api/users/${USER_ID}/workstations" "$(jq -n --arg t "$DEPARTMENT_ID" '{department_id: $t, name: "esc-workstation", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Creating escalation ticket..."
api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/escalations" '{"title":"Agent stuck","body":"Stuck for 30 min","priority":"high"}'
assert_status "201" "create escalation"
ESC_TICKET_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
assert_json "$HTTP_BODY" ".data.type" "escalation" "type should be escalation"
echo "  Escalation ticket: ${ESC_TICKET_ID}"

echo "  Listing department escalations..."
api_get "/api/departments/${DEPARTMENT_ID}/escalations"
assert_status "200" "list escalations"
# department-level escalations are routed via routeEscalation — this is a separate system
# The ticket we created above is in the tickets table, not the escalations table

echo "  Listing tickets to find escalation..."
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/tickets"
assert_status "200" "list tickets"
ESC_COUNT=$(echo "$HTTP_BODY" | jq '[.data[] | select(.type == "escalation")] | length')
assert_eq "$ESC_COUNT" "1" "should have 1 escalation ticket"

echo "  Escalation routing OK"
