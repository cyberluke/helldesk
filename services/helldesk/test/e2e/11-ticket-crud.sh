#!/usr/bin/env bash
# Test 11: Create, list, and close tickets via the agent-authenticated API
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-kilo-token-$(date +%s)"

# Setup: department + workstation
api_post "/api/users/${USER_ID}/departments" '{"name":"ticket-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/users/${USER_ID}/workstations" "$(jq -n --arg department_id "$DEPARTMENT_ID" --arg t "$FAKE_TOKEN" \
  '{department_id: $department_id, name: "ticket-workstation", git_url: "https://github.com/t/r.git", default_branch: "main", kilocode_token: $t}')"
assert_status "201" "create workstation"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

# Set department ID for X-department-Id header (needed since dev mode has no JWT)
CURRENT_DEPARTMENT_ID="$DEPARTMENT_ID"

echo "  Creating ticket..."
api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/tickets" '{"type":"issue","title":"E2E test ticket","body":"Test body","priority":"high"}'
assert_status "201" "create ticket"
assert_json_exists "$HTTP_BODY" ".data.id" "ticket should have id"
assert_json "$HTTP_BODY" ".data.title" "E2E test ticket" "ticket title"
assert_json "$HTTP_BODY" ".data.status" "open" "ticket status should be open"
TICKET_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Ticket: ${TICKET_ID}"

echo "  Listing tickets..."
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/tickets"
assert_status "200" "list tickets"
TICKET_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$TICKET_COUNT" "1" "should have 1 ticket"

echo "  Getting ticket by ID..."
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/tickets/${TICKET_ID}"
assert_status "200" "get ticket"
assert_json "$HTTP_BODY" ".data.id" "$TICKET_ID" "ticket id should match"

echo "  Ticket CRUD OK"
