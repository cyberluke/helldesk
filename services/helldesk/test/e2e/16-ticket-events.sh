#!/usr/bin/env bash
# Test 16: Ticket events are recorded when tickets change status
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
api_post "/api/users/${USER_ID}/departments" '{"name":"Events-department"}'
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_DEPARTMENT_ID="$DEPARTMENT_ID"

api_post "/api/users/${USER_ID}/workstations" "$(jq -n --arg t "$DEPARTMENT_ID" '{department_id: $t, name: "ev-workstation", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

# Sling a ticket (creates ticket + hooks agent → generates 'created' and 'hooked' events)
echo "  Slinging ticket..."
api_post "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/sling" '{"title":"Event ticket"}'
assert_status "201" "sling"
TICKET_ID=$(echo "$HTTP_BODY" | jq -r '.data.ticket.id')

echo "  Fetching ticket events..."
api_get "/api/departments/${DEPARTMENT_ID}/workstations/${WORKSTATION_ID}/events"
assert_status "200" "ticket events"
EVENT_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
echo "  Events: ${EVENT_COUNT}"

# Should have at least 'created' and 'hooked' events
if [[ "$EVENT_COUNT" -lt 2 ]]; then
  echo "  FAIL: expected at least 2 events, got ${EVENT_COUNT}"
  echo "  Events: ${HTTP_BODY}"
  exit 1
fi

echo "  Ticket events OK"
