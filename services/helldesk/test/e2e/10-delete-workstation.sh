#!/usr/bin/env bash
# Test 10: Delete a workstation from a department
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating department + workstation..."
api_post "/api/users/${USER_ID}/departments" '{"name":"Del-workstation-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/users/${USER_ID}/workstations" "$(jq -n --arg department_id "$DEPARTMENT_ID" \
  '{department_id: $department_id, name: "del-workstation", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
assert_status "201" "create workstation"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Deleting workstation ${WORKSTATION_ID}..."
api_call DELETE "/api/users/${USER_ID}/workstations/${WORKSTATION_ID}"
assert_status "200" "delete workstation"

echo "  Listing workstations (should be empty)..."
api_get "/api/users/${USER_ID}/departments/${DEPARTMENT_ID}/workstations"
assert_status "200" "list workstations"
WORKSTATION_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$WORKSTATION_COUNT" "0" "should have 0 workstations after delete"

echo "  Delete workstation OK"
