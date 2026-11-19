#!/usr/bin/env bash
# Test 7: List workstations for a department
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating department..."
api_post "/api/users/${USER_ID}/departments" '{"name":"List-workstations-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Listing workstations (should be empty)..."
api_get "/api/users/${USER_ID}/departments/${DEPARTMENT_ID}/workstations"
assert_status "200" "list workstations"
WORKSTATION_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$WORKSTATION_COUNT" "0" "should have 0 workstations initially"

echo "  Creating two workstations..."
api_post "/api/users/${USER_ID}/workstations" "$(jq -n \
  --arg department_id "$DEPARTMENT_ID" '{department_id: $department_id, name: "workstation-a", git_url: "https://github.com/a/a.git", default_branch: "main"}')"
assert_status "201" "create workstation a"

api_post "/api/users/${USER_ID}/workstations" "$(jq -n \
  --arg department_id "$DEPARTMENT_ID" '{department_id: $department_id, name: "workstation-b", git_url: "https://github.com/b/b.git", default_branch: "main"}')"
assert_status "201" "create workstation b"

echo "  Listing workstations (should have 2)..."
api_get "/api/users/${USER_ID}/departments/${DEPARTMENT_ID}/workstations"
assert_status "200" "list workstations after creation"
WORKSTATION_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$WORKSTATION_COUNT" "2" "should have 2 workstations"

echo "  List workstations OK"
