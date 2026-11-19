#!/usr/bin/env bash
# Test 5: Verify sending multiple messages to the same department doesn't spawn extra containers
# (Each department gets exactly one DepartmentContainerDO, so repeated messages should reuse it)
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-kilo-token-$(date +%s)"

echo "  Creating department and workstation..."
api_post "/api/users/${USER_ID}/departments" '{"name":"Single-Container-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/users/${USER_ID}/workstations" "$(jq -n \
  --arg department_id "$DEPARTMENT_ID" \
  --arg name "single-workstation" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg kilocode_token "$FAKE_TOKEN" \
  '{department_id: $department_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')"
assert_status "201" "create workstation"

# Snapshot container count before first message
BEFORE_COUNT=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')

# Send first frontDesk message to trigger container start
echo "  Sending first frontDesk message..."
api_post "/api/departments/${DEPARTMENT_ID}/frontDesk/message" '{"message":"Test single container"}'
assert_status "200" "first message"

# Wait for container to start
sleep 10

AFTER_FIRST=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
FIRST_DELTA=$((AFTER_FIRST - BEFORE_COUNT))
echo "  Containers after first message: ${AFTER_FIRST} (delta: +${FIRST_DELTA})"

# Send a second message to the same department — should NOT spawn additional containers
echo "  Sending second frontDesk message to same department..."
api_post "/api/departments/${DEPARTMENT_ID}/frontDesk/message" '{"message":"Second message"}'
assert_status "200" "second message"
sleep 5

AFTER_SECOND=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
SECOND_DELTA=$((AFTER_SECOND - AFTER_FIRST))
echo "  Containers after second message: ${AFTER_SECOND} (delta from first: +${SECOND_DELTA})"

if [[ "$SECOND_DELTA" -gt 0 ]]; then
  echo "  FAIL: Second message to the same department spawned ${SECOND_DELTA} additional container(s)!"
  docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"
  exit 1
fi

echo "  Same-department container reuse verified OK"
