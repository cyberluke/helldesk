#!/usr/bin/env bash
# Test 17: Multiple departments per user are independent
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating two departments..."
api_post "/api/users/${USER_ID}/departments" '{"name":"department-Alpha"}'
assert_status "201" "create department alpha"
DEPARTMENT_A=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/users/${USER_ID}/departments" '{"name":"department-Beta"}'
assert_status "201" "create department beta"
DEPARTMENT_B=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Verifying both exist..."
api_get "/api/users/${USER_ID}/departments"
DEPARTMENT_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$DEPARTMENT_COUNT" "2" "should have 2 departments"

echo "  Deleting department alpha..."
api_call DELETE "/api/users/${USER_ID}/departments/${DEPARTMENT_A}"
assert_status "200" "delete department alpha"

echo "  Department beta should still exist..."
api_get "/api/users/${USER_ID}/departments/${DEPARTMENT_B}"
assert_status "200" "department beta still exists"
assert_json "$HTTP_BODY" ".data.name" "department-Beta" "department beta name"

api_get "/api/users/${USER_ID}/departments"
DEPARTMENT_COUNT2=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$DEPARTMENT_COUNT2" "1" "should have 1 department left"

echo "  Multiple departments OK"
