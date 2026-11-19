#!/usr/bin/env bash
# Test 2: Create a department and verify it's returned correctly
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating department for user=${USER_ID}..."
api_post "/api/users/${USER_ID}/departments" '{"name":"E2E-department"}'
assert_status "201" "POST /api/users/:userId/departments should return 201"
assert_json "$HTTP_BODY" ".success" "true" "response should have success=true"
assert_json_exists "$HTTP_BODY" ".data.id" "department should have an id"
assert_json "$HTTP_BODY" ".data.name" "E2E-department" "department name should match"
assert_json "$HTTP_BODY" ".data.owner_user_id" "$USER_ID" "owner should match"

DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Created department: ${DEPARTMENT_ID}"

echo "  Listing departments for user..."
api_get "/api/users/${USER_ID}/departments"
assert_status "200" "GET /api/users/:userId/departments should return 200"
assert_json "$HTTP_BODY" ".success" "true" "list response should have success=true"

DEPARTMENT_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$DEPARTMENT_COUNT" "1" "should have 1 department"

echo "  Getting department by ID..."
api_get "/api/users/${USER_ID}/departments/${DEPARTMENT_ID}"
assert_status "200" "GET /api/users/:userId/departments/:departmentId should return 200"
assert_json "$HTTP_BODY" ".data.id" "$DEPARTMENT_ID" "fetched department id should match"

echo "  Department CRUD OK"
