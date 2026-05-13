#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# E2E tests for the Ollama auth proxy.
# Uses a mock Ollama backend — no real Ollama needed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOCK_PORT=19434
PROXY_PORT=19435
TOKEN="test-token-$(date +%s)"
PASS=0
FAIL=0
MOCK_PID=""
PROXY_PID=""

cleanup() {
  if [ -n "${MOCK_PID:-}" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
  if [ -n "${PROXY_PID:-}" ]; then
    kill "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

pass() {
  PASS=$((PASS + 1))
  echo "  ✓ $1"
}
fail() {
  FAIL=$((FAIL + 1))
  echo "  ✗ $1"
}

echo ""
echo "=== Ollama auth proxy E2E tests ==="
echo ""

# Start mock Ollama backend on localhost only
node -e "
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'mock:latest' }] }));
  });
  server.listen($MOCK_PORT, '127.0.0.1', () => {
    console.log('Mock Ollama on 127.0.0.1:$MOCK_PORT');
  });
" &
MOCK_PID=$!
sleep 1

# Start auth proxy
OLLAMA_PROXY_TOKEN="$TOKEN" \
  OLLAMA_PROXY_PORT="$PROXY_PORT" \
  OLLAMA_BACKEND_PORT="$MOCK_PORT" \
  node "$SCRIPT_DIR/scripts/ollama-auth-proxy.js" &
PROXY_PID=$!
sleep 1

# Test 1: Mock backend responds on localhost
if curl -sf --connect-timeout 2 "http://127.0.0.1:$MOCK_PORT/api/tags" >/dev/null 2>&1; then
  pass "Mock is responding on localhost:$MOCK_PORT"
else
  fail "Mock should be responding on localhost:$MOCK_PORT"
fi

# All STATUS=$(curl ... -w "%{http_code}") calls below trail `|| STATUS="000"`
# so a curl failure (e.g. proxy not listening) under `set -e` does not abort
# the script before fail/summary lines run. Mirrors the GPU e2e pattern.

# Test 2: Proxy is listening (any HTTP response counts as alive — auth
# enforcement on /api/tags is exercised in Test 6 below)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "http://127.0.0.1:$PROXY_PORT/api/tags") || STATUS="000"
if [[ "$STATUS" =~ ^[1-9][0-9]{2}$ ]]; then
  pass "Proxy responding on port $PROXY_PORT (HTTP $STATUS)"
else
  fail "Proxy not responding on port $PROXY_PORT"
fi

# Test 3: Unauthenticated POST rejected
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PROXY_PORT/api/generate" -d '{}') || STATUS="000"
if [ "$STATUS" = "401" ]; then
  pass "Unauthenticated POST rejected (401)"
else
  fail "Unauthenticated POST should be 401, got $STATUS"
fi

# Test 4: Wrong token rejected
WRONG_AUTH="Bearer wrong-token"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $WRONG_AUTH" -X POST "http://127.0.0.1:$PROXY_PORT/api/generate" -d '{}') || STATUS="000"
if [ "$STATUS" = "401" ]; then
  pass "Wrong token rejected (401)"
else
  fail "Wrong token should be 401, got $STATUS"
fi

# Test 5: Correct token proxied to backend on a protected endpoint
CORRECT_AUTH="Bearer $TOKEN"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $CORRECT_AUTH" -X POST "http://127.0.0.1:$PROXY_PORT/api/generate" -d '{}') || STATUS="000"
if [ "$STATUS" = "200" ]; then
  pass "Correct token proxied to backend (protected endpoint)"
else
  fail "Correct token should proxy to backend, got $STATUS"
fi

# Test 6: GET /api/tags without auth → 401 (no health-check bypass — #3338)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PROXY_PORT/api/tags") || STATUS="000"
if [ "$STATUS" = "401" ]; then
  pass "Unauthenticated GET /api/tags → 401"
else
  fail "Unauthenticated GET /api/tags should be 401, got $STATUS"
fi

# Test 7: POST /api/tags without auth → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PROXY_PORT/api/tags" -d '{}') || STATUS="000"
if [ "$STATUS" = "401" ]; then
  pass "Unauthenticated POST /api/tags → 401"
else
  fail "Unauthenticated POST /api/tags should be 401, got $STATUS"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

[ "$FAIL" -eq 0 ] || exit 1
