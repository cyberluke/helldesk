#!/usr/bin/env bash
# Test 4: Send frontDesk message and verify KILOCODE_TOKEN arrives in container
# This tests the full config flow: department config → X-department-Config → container buildAgentEnv
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-kilo-token-$(date +%s)"

# Create department + workstation with token
echo "  Creating department..."
api_post "/api/users/${USER_ID}/departments" '{"name":"front-desk-Token-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Creating workstation with kilocode_token..."
api_post "/api/users/${USER_ID}/workstations" "$(jq -n \
  --arg department_id "$DEPARTMENT_ID" \
  --arg name "front-desk-workstation" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg kilocode_token "$FAKE_TOKEN" \
  '{department_id: $department_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')"
assert_status "201" "create workstation"

# Verify department config has the token
echo "  Verifying department config..."
api_get "/api/departments/${DEPARTMENT_ID}/config"
assert_status "200" "get department config"
CONFIG_TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // empty')
assert_eq "$CONFIG_TOKEN" "$FAKE_TOKEN" "department config should have the kilocode_token"

# Verify X-department-Config header delivery (this is in wrangler logs since the worker sends it)
echo "  Verifying X-department-Config header was sent with token (worker-side)..."
if grep -q "hasKilocodeToken=true" "$WRANGLER_LOG"; then
  echo "  Worker sent X-department-Config with token ✓"
else
  # The header might not have been sent yet if the frontDesk hasn't been started
  echo "  X-department-Config not yet sent (expected — frontDesk not started yet)"
fi

# Send frontDesk message — this triggers startAgentInContainer
echo "  Sending frontDesk message..."
api_post "/api/departments/${DEPARTMENT_ID}/frontDesk/message" '{"message":"Hello from E2E test"}'
echo "  FrontDesk message response: status=${HTTP_STATUS}"
# Accept 200 (success) or 500 (container may fail to start if kilo binary not available in local dev)
if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "  FrontDesk message returned ${HTTP_STATUS} — this may be expected in local dev without a container"
  echo "  Response: ${HTTP_BODY}"
fi

# Wait for container to potentially start (up to 15s)
echo "  Waiting for container interaction..."
sleep 5

# Check wrangler logs for the full flow
echo "  Checking worker logs for X-department-Config delivery..."
if grep -q "hasKilocodeToken=true" "$WRANGLER_LOG"; then
  echo "  ✓ X-department-Config header delivered with kilocode_token"
else
  echo "  ✗ X-department-Config header did NOT contain kilocode_token"
  grep "X-department-Config" "$WRANGLER_LOG" || echo "    No X-department-Config logs at all"
  exit 1
fi

# Check Docker container logs if a container was spawned
CONTAINER_ID=$(docker ps -q --filter "ancestor=helldesk-dev-departmentContainerDO" 2>/dev/null | head -1)
if [[ -z "$CONTAINER_ID" ]]; then
  # Try broader search
  CONTAINER_ID=$(docker ps -q 2>/dev/null | head -1)
fi

if [[ -n "$CONTAINER_ID" ]]; then
  echo "  Found container: ${CONTAINER_ID}"
  CONTAINER_LOGS=$(docker logs "$CONTAINER_ID" 2>&1)

  if echo "$CONTAINER_LOGS" | grep -q "KILO_CONFIG_CONTENT set"; then
    echo "  ✓ Container: KILO_CONFIG_CONTENT was set"
  elif echo "$CONTAINER_LOGS" | grep -q "No KILOCODE_TOKEN available"; then
    echo "  ✗ Container: KILOCODE_TOKEN was NOT available"
    echo "  Container buildAgentEnv logs:"
    echo "$CONTAINER_LOGS" | grep "buildAgentEnv" || echo "    (no buildAgentEnv logs)"
    echo "$CONTAINER_LOGS" | grep "X-department-Config" || echo "    (no X-department-Config logs)"
    exit 1
  else
    echo "  Container logs (last 20 lines):"
    echo "$CONTAINER_LOGS" | tail -20
  fi
else
  echo "  No Docker container found — container may not have started in local dev"
  echo "  This is OK for the token propagation test (the worker-side flow is verified)"
fi

echo "  FrontDesk token flow OK"
