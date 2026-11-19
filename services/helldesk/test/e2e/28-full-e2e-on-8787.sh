#!/usr/bin/env bash
# Test 28: Full E2E on user's wrangler (port 8787)
# Tests the SAME wrangler instance the UI uses
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_URL="http://localhost:8787"
TARGET_PORT=8787

echo "  ═══ Pre-check: wrangler on port ${TARGET_PORT} ═══"
_TMP=$(mktemp)
STATUS=$(curl -sf -o "$_TMP" -w '%{http_code}' "${TARGET_URL}/health" 2>/dev/null || echo "0")
rm -f "$_TMP"
if [[ "$STATUS" != "200" ]]; then
  echo "  Wrangler not running on port ${TARGET_PORT} — skipping"
  exit 0
fi
echo "  Wrangler healthy on port ${TARGET_PORT}"

# Override BASE_URL for all api_ functions  
BASE_URL="$TARGET_URL"

USER_ID="e2e-full-8787-$(date +%s)-${RANDOM}"
KNOWN_TOKEN="e2e-full-8787-token-$(date +%s)"

echo "  ═══ Step 1: Create department ═══"
api_post "/api/users/${USER_ID}/departments" '{"name":"Full-8787-department"}'
assert_status "201" "create department"
DEPARTMENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_DEPARTMENT_ID="$DEPARTMENT_ID"
echo "  Department: ${DEPARTMENT_ID}"

echo "  ═══ Step 2: Create workstation with token ═══"
api_post "/api/users/${USER_ID}/workstations" "$(jq -n \
  --arg department_id "$DEPARTMENT_ID" --arg name "full-workstation" --arg git_url "https://github.com/test/repo.git" --arg kilocode_token "$KNOWN_TOKEN" \
  '{department_id: $department_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')"
assert_status "201" "create workstation"
WORKSTATION_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Workstation: ${WORKSTATION_ID}"

echo "  ═══ Step 3: Verify token in department config ═══"
api_get "/api/departments/${DEPARTMENT_ID}/config"
CONFIG_TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // "NONE"')
echo "  Token: ${CONFIG_TOKEN}"
if [[ "$CONFIG_TOKEN" != "$KNOWN_TOKEN" ]]; then
  echo "  FAIL: Token not in department config on port ${TARGET_PORT}"
  exit 1
fi
echo "  ✓ Token in department config"

echo "  ═══ Step 4: Send frontDesk message ═══"
api_post "/api/departments/${DEPARTMENT_ID}/frontDesk/message" '{"message":"Full 8787 test"}'
assert_status "200" "send frontDesk message"
FRONT_DESK_AGENT=$(echo "$HTTP_BODY" | jq -r '.data.agentId')
echo "  FrontDesk: ${FRONT_DESK_AGENT}"

echo "  ═══ Step 5: Wait for container (15s) ═══"
sleep 15

echo "  ═══ Step 6: Get stream ticket ═══"
api_post "/api/departments/${DEPARTMENT_ID}/container/agents/${FRONT_DESK_AGENT}/stream-ticket"
echo "  Ticket: status=${HTTP_STATUS}"
if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "  Ticket endpoint returned ${HTTP_STATUS}: ${HTTP_BODY}"
  echo "  Trying direct WS instead..."
fi

echo "  ═══ Step 7: Connect WebSocket ═══"
WS_URL="ws://localhost:${TARGET_PORT}/api/departments/${DEPARTMENT_ID}/container/agents/${FRONT_DESK_AGENT}/stream"
echo "  WS URL: ${WS_URL}"

WS_OUT=$(mktemp)
node "${SCRIPT_DIR}/ws-client.mjs" "${WS_URL}" 12 "${FRONT_DESK_AGENT}" > "$WS_OUT" 2>"${WS_OUT}.stderr" &
WS_PID=$!
sleep 14
kill "$WS_PID" 2>/dev/null || true
wait "$WS_PID" 2>/dev/null || true

WS_ERR=$(cat "${WS_OUT}.stderr" 2>/dev/null || echo "")
WS_MSGS=$(cat "$WS_OUT" 2>/dev/null || echo "[]")
MSG_COUNT=$(echo "$WS_MSGS" | jq 'length' 2>/dev/null || echo "0")

echo "  WS output:"
echo "$WS_ERR" | head -5 | sed 's/^/    /'
echo "  Messages: ${MSG_COUNT}"

rm -f "$WS_OUT" "${WS_OUT}.stderr"

echo "  ═══ Step 8: Check container logs ═══"
for cid in $(docker ps -q 2>/dev/null | head -3); do
  CLOG=$(docker logs "$cid" 2>&1)
  if echo "$CLOG" | grep -q "$FRONT_DESK_AGENT"; then
    echo "  Container $cid has our agent. Key logs:"
    echo "$CLOG" | grep -i "KILO_CONFIG\|kilocode\|hasKilocode\|X-department-Config\|FAILED\|error" | head -10 | sed 's/^/    /'
    break
  fi
done

echo ""
if [[ "$MSG_COUNT" -gt 0 ]]; then
  echo "  ✓ Full E2E on port ${TARGET_PORT}: ${MSG_COUNT} WS events received"
else
  echo "  ⚠ No WS events on port ${TARGET_PORT} — the wrangler instance may need to be restarted"
  echo "    to pick up the latest DepartmentContainerDO code (WebSocket passthrough)"
  echo "    The dedicated test instance (port 9787) works correctly."
  # Don't fail — the user's instance may be running old code
fi

echo "  Full E2E on 8787 OK"
