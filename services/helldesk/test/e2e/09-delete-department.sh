#!/usr/bin/env bash
# Test 9: Delete a department
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating department..."
api_post "/api/users/${USER_ID}/departments" '{"name":"Delete-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Deleting department..."
api_call DELETE "/api/users/${USER_ID}/departments/${DEPARTMENT_ID}"
assert_status "200" "delete department"

echo "  Verifying department is gone..."
api_get "/api/users/${USER_ID}/departments/${DEPARTMENT_ID}"
assert_status "404" "deleted department should return 404"

echo "  Listing departments (should be empty)..."
api_get "/api/users/${USER_ID}/departments"
assert_status "200" "list departments after delete"
DEPARTMENT_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$DEPARTMENT_COUNT" "0" "should have 0 departments after delete"

echo "  Delete department OK"
