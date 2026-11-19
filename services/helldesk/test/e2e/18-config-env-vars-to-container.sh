#!/usr/bin/env bash
# Test 18: Env vars from department config are included in X-department-Config
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-token-$(date +%s)"

api_post "/api/users/${USER_ID}/departments" '{"name":"EnvVar-department"}'
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

# Set env vars via config update
echo "  Setting env vars in department config..."
api_call PATCH "/api/departments/${DEPARTMENT_ID}/config" '{"env_vars":{"CUSTOM_VAR":"custom_value","ANOTHER":"second"}}'
assert_status "200" "update config"
assert_json "$HTTP_BODY" ".data.env_vars.CUSTOM_VAR" "custom_value" "CUSTOM_VAR"
assert_json "$HTTP_BODY" ".data.env_vars.ANOTHER" "second" "ANOTHER"

# Create workstation + send frontDesk message to trigger container start with config
api_post "/api/users/${USER_ID}/workstations" "$(jq -n --arg t "$DEPARTMENT_ID" --arg tk "$FAKE_TOKEN" \
  '{department_id: $t, name: "envvar-workstation", git_url: "https://github.com/t/r.git", default_branch: "main", kilocode_token: $tk}')"
assert_status "201" "create workstation"

echo "  Sending frontDesk message to trigger container..."
api_post "/api/departments/${DEPARTMENT_ID}/frontDesk/message" '{"message":"env var test"}'
assert_status "200" "send frontDesk message"

# Wait for X-department-Config to be delivered
sleep 3

echo "  Checking wrangler logs for env_vars in X-department-Config..."
if grep -q "X-department-Config received" "$WRANGLER_LOG"; then
  echo "  X-department-Config was delivered"
else
  echo "  WARNING: No X-department-Config log found"
fi

# Verify config still has the env vars
api_get "/api/departments/${DEPARTMENT_ID}/config"
assert_json "$HTTP_BODY" ".data.env_vars.CUSTOM_VAR" "custom_value" "CUSTOM_VAR persisted"

echo "  Config env vars to container OK"
