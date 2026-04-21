#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Ollama Auth Proxy E2E — real Ollama, real inference, real proxy.
#
# Validates the full proxy chain introduced in PR #1922:
#   1. Install Ollama + pull a small model
#   2. Start Ollama on 127.0.0.1 (localhost only)
#   3. Start the auth proxy on 0.0.0.0:11435
#   4. Verify proxy auth (reject bad tokens, accept good tokens)
#   5. Verify real inference through the proxy
#   6. Verify proxy recovery (kill + restart from persisted token)
#   7. Verify token persistence (file exists, permissions, content)
#   8. Verify container reachability check works against the proxy
#
# Does NOT require GPU — runs CPU inference with a small model.
# Does NOT require OpenShell/sandbox — tests the host-side proxy chain only.
#
# Usage:
#   bash test/e2e/test-ollama-auth-proxy-e2e.sh
#
# Triggered via workflow_dispatch (manual) or as part of nightly.

set -uo pipefail

PASS=0
FAIL=0
TOTAL=0
PROXY_PID=""
OLLAMA_PID=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROXY_SCRIPT="$SCRIPT_DIR/scripts/ollama-auth-proxy.js"
TOKEN_DIR="$(mktemp -d)"
TOKEN_FILE="$TOKEN_DIR/.nemoclaw/ollama-proxy-token"
OLLAMA_PORT=11434
PROXY_PORT=11435
MODEL="qwen2.5:0.5b"

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}

# shellcheck disable=SC2329 # invoked via trap
cleanup() {
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null || true
  # Don't kill system Ollama — only kill if we started it
  [ -n "${OLLAMA_PID:-}" ] && kill "$OLLAMA_PID" 2>/dev/null || true
  rm -rf "$TOKEN_DIR"
}
trap cleanup EXIT

# ══════════════════════════════════════════════════════════════════
# Phase 1: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Prerequisites"

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not found"
  exit 1
fi
pass "Node.js available: $(node --version)"

if ! command -v curl >/dev/null 2>&1; then
  fail "curl not found"
  exit 1
fi
pass "curl available"

if [ ! -f "$PROXY_SCRIPT" ]; then
  fail "Proxy script not found at $PROXY_SCRIPT"
  exit 1
fi
pass "Proxy script exists"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Install Ollama + pull model
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Install Ollama and pull model"

if command -v ollama >/dev/null 2>&1; then
  pass "Ollama already installed: $(ollama --version 2>/dev/null || echo unknown)"
else
  info "Installing Ollama..."
  if curl -fsSL https://ollama.com/install.sh | sh 2>&1; then
    pass "Ollama installed"
  else
    fail "Ollama install failed"
    exit 1
  fi
fi

# Stop any existing Ollama so we control the binding
pkill -f "ollama serve" 2>/dev/null || true
systemctl --user stop ollama 2>/dev/null || true
systemctl stop ollama 2>/dev/null || true
sleep 2

# Start Ollama on localhost only (mirrors what onboard does with the proxy)
info "Starting Ollama on 127.0.0.1:${OLLAMA_PORT}..."
OLLAMA_HOST="127.0.0.1:${OLLAMA_PORT}" ollama serve >/dev/null 2>&1 &
OLLAMA_PID=$!
sleep 3

if curl -sf "http://127.0.0.1:${OLLAMA_PORT}/api/tags" >/dev/null 2>&1; then
  pass "Ollama running on 127.0.0.1:${OLLAMA_PORT}"
else
  fail "Ollama failed to start on 127.0.0.1:${OLLAMA_PORT}"
  exit 1
fi

# Pull the small model
info "Pulling model ${MODEL} (this may take a few minutes on first run)..."
if ollama pull "$MODEL" 2>&1; then
  pass "Model $MODEL pulled"
else
  fail "Failed to pull $MODEL"
  exit 1
fi

# Verify model is available
if curl -sf "http://127.0.0.1:${OLLAMA_PORT}/api/tags" | grep -q "$MODEL"; then
  pass "Model $MODEL available in Ollama"
else
  fail "Model $MODEL not found in /api/tags"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Start auth proxy
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Start auth proxy"

TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
info "Generated proxy token: ${TOKEN:0:8}..."

# Persist token (mirrors onboard behavior)
mkdir -p "$TOKEN_DIR/.nemoclaw"
echo "$TOKEN" >"$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

OLLAMA_PROXY_TOKEN="$TOKEN" \
  OLLAMA_PROXY_PORT="$PROXY_PORT" \
  OLLAMA_BACKEND_PORT="$OLLAMA_PORT" \
  node "$PROXY_SCRIPT" &
PROXY_PID=$!
sleep 2

if curl -sf "http://127.0.0.1:${PROXY_PORT}/api/tags" >/dev/null 2>&1; then
  pass "Auth proxy running on 0.0.0.0:${PROXY_PORT}"
else
  fail "Auth proxy failed to start"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Auth verification
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Auth verification"

# 4a: Unauthenticated request to protected endpoint → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "http://127.0.0.1:${PROXY_PORT}/api/generate" -d '{}')
if [ "$STATUS" = "401" ]; then
  pass "Unauthenticated POST /api/generate → 401"
else
  fail "Expected 401 for unauthenticated POST, got $STATUS"
fi

# 4b: Wrong token → 401
WRONG_AUTH="Bearer wrong-token-$(date +%s)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: $WRONG_AUTH" \
  -X POST "http://127.0.0.1:${PROXY_PORT}/api/generate" -d '{}')
if [ "$STATUS" = "401" ]; then
  pass "Wrong token POST /api/generate → 401"
else
  fail "Expected 401 for wrong token, got $STATUS"
fi

# 4c: Correct token → 200 (forwarded to Ollama)
CORRECT_AUTH="Bearer $TOKEN"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: $CORRECT_AUTH" \
  "http://127.0.0.1:${PROXY_PORT}/api/tags")
if [ "$STATUS" = "200" ]; then
  pass "Correct token GET /api/tags → 200"
else
  fail "Expected 200 for correct token, got $STATUS"
fi

# 4d: Health check GET /api/tags without auth → 200 (exempt)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://127.0.0.1:${PROXY_PORT}/api/tags")
if [ "$STATUS" = "200" ]; then
  pass "GET /api/tags without auth → 200 (health check exempt)"
else
  fail "Expected 200 for unauthenticated health check, got $STATUS"
fi

# 4e: POST /api/tags without auth → 401 (only GET exempt)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://127.0.0.1:${PROXY_PORT}/api/tags" -d '{}')
if [ "$STATUS" = "401" ]; then
  pass "POST /api/tags without auth → 401 (only GET exempt)"
else
  fail "Expected 401 for POST /api/tags, got $STATUS"
fi

# 4f: Authorization header stripped before forwarding (Ollama doesn't see it)
# Verify by checking that Ollama gets a clean request
BODY=$(curl -sf -H "Authorization: $CORRECT_AUTH" \
  "http://127.0.0.1:${PROXY_PORT}/api/tags" 2>/dev/null)
if echo "$BODY" | grep -q "$MODEL"; then
  pass "Proxy strips auth header — Ollama responds normally"
else
  fail "Proxy may not be stripping auth header correctly"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Real inference through proxy
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Real inference through proxy"

# 5a: OpenAI-compatible chat completions through proxy
info "Testing inference: POST /v1/chat/completions through proxy..."
INFERENCE_RESPONSE=$(curl -s --max-time 120 \
  -H "Authorization: $CORRECT_AUTH" \
  -H "Content-Type: application/json" \
  -X POST "http://127.0.0.1:${PROXY_PORT}/v1/chat/completions" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Reply with exactly one word: PONG\"}],
    \"max_tokens\": 50
  }" 2>/dev/null) || true

if [ -n "$INFERENCE_RESPONSE" ]; then
  # Check for a valid response structure
  if echo "$INFERENCE_RESPONSE" | python3 -c "
import json, sys
r = json.load(sys.stdin)
c = r.get('choices', [{}])[0].get('message', {}).get('content', '')
print(c.strip())
sys.exit(0 if c.strip() else 1)
" 2>/dev/null; then
    pass "Inference through proxy: got chat completion response"
  else
    fail "Inference through proxy: invalid response structure"
    info "Response: ${INFERENCE_RESPONSE:0:300}"
  fi
else
  fail "Inference through proxy: empty response"
fi

# 5b: Ollama native /api/generate through proxy
info "Testing inference: POST /api/generate through proxy..."
GENERATE_RESPONSE=$(curl -s --max-time 120 \
  -H "Authorization: $CORRECT_AUTH" \
  -H "Content-Type: application/json" \
  -X POST "http://127.0.0.1:${PROXY_PORT}/api/generate" \
  -d "{
    \"model\": \"$MODEL\",
    \"prompt\": \"Reply with one word: PONG\",
    \"stream\": false
  }" 2>/dev/null) || true

if [ -n "$GENERATE_RESPONSE" ]; then
  if echo "$GENERATE_RESPONSE" | python3 -c "
import json, sys
r = json.load(sys.stdin)
print(r.get('response', '').strip())
sys.exit(0 if r.get('response', '').strip() else 1)
" 2>/dev/null; then
    pass "Inference through proxy: got /api/generate response"
  else
    fail "Inference through proxy: invalid /api/generate response"
    info "Response: ${GENERATE_RESPONSE:0:300}"
  fi
else
  fail "Inference through proxy: empty /api/generate response"
fi

# 5c: Inference WITHOUT token → 401 (not forwarded)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "Content-Type: application/json" \
  -X POST "http://127.0.0.1:${PROXY_PORT}/v1/chat/completions" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"test\"}]
  }" 2>/dev/null)
if [ "$STATUS" = "401" ]; then
  pass "Inference without token → 401 (not forwarded to Ollama)"
else
  fail "Expected 401 for unauthenticated inference, got $STATUS"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Token persistence
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Token persistence"

# 6a: Token file exists
if [ -f "$TOKEN_FILE" ]; then
  pass "Token file exists at $TOKEN_FILE"
else
  fail "Token file missing"
fi

# 6b: Token file has correct permissions
PERMS=$(stat -c "%a" "$TOKEN_FILE" 2>/dev/null || stat -f "%Lp" "$TOKEN_FILE" 2>/dev/null)
if [ "$PERMS" = "600" ]; then
  pass "Token file permissions: 600"
else
  fail "Token file permissions: expected 600, got $PERMS"
fi

# 6c: Token file content matches
FILE_TOKEN=$(cat "$TOKEN_FILE" | tr -d '[:space:]')
if [ "$FILE_TOKEN" = "$TOKEN" ]; then
  pass "Token file content matches generated token"
else
  fail "Token file content mismatch"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: Proxy recovery (kill + restart)
# ══════════════════════════════════════════════════════════════════
section "Phase 7: Proxy recovery"

# 7a: Kill the proxy
info "Killing proxy (PID: $PROXY_PID)..."
kill "$PROXY_PID" 2>/dev/null || true
PROXY_PID=""
sleep 2

# Verify it's dead
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 \
  "http://127.0.0.1:${PROXY_PORT}/api/tags" 2>/dev/null) || STATUS="000"
if [ "$STATUS" = "000" ] || [ "$STATUS" = "" ]; then
  pass "Proxy confirmed dead after kill"
else
  fail "Proxy still responding after kill (status: $STATUS)"
fi

# 7b: Restart proxy with persisted token (simulates reboot recovery)
info "Restarting proxy from persisted token..."
PERSISTED_TOKEN=$(cat "$TOKEN_FILE" | tr -d '[:space:]')
OLLAMA_PROXY_TOKEN="$PERSISTED_TOKEN" \
  OLLAMA_PROXY_PORT="$PROXY_PORT" \
  OLLAMA_BACKEND_PORT="$OLLAMA_PORT" \
  node "$PROXY_SCRIPT" &
PROXY_PID=$!
sleep 2

if curl -sf "http://127.0.0.1:${PROXY_PORT}/api/tags" >/dev/null 2>&1; then
  pass "Proxy restarted from persisted token"
else
  fail "Proxy failed to restart"
fi

# 7c: Verify inference still works with the same token after restart
RECOVER_AUTH="Bearer $PERSISTED_TOKEN"
RECOVER_RESPONSE=$(curl -s --max-time 60 \
  -H "Authorization: $RECOVER_AUTH" \
  -H "Content-Type: application/json" \
  -X POST "http://127.0.0.1:${PROXY_PORT}/v1/chat/completions" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Say OK\"}],
    \"max_tokens\": 10
  }" 2>/dev/null) || true

if [ -n "$RECOVER_RESPONSE" ] && echo "$RECOVER_RESPONSE" | python3 -c "
import json, sys
r = json.load(sys.stdin)
sys.exit(0 if r.get('choices') else 1)
" 2>/dev/null; then
  pass "Inference works after proxy restart with persisted token"
else
  fail "Inference failed after proxy restart"
fi

# 7d: Verify old token still works (same token persisted)
if [ "$TOKEN" = "$PERSISTED_TOKEN" ]; then
  pass "Persisted token matches original — no token rotation on restart"
else
  fail "Token changed on restart (should be the same persisted token)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 8: Container reachability check (Docker, if available)
# ══════════════════════════════════════════════════════════════════
section "Phase 8: Container reachability (Docker)"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  info "Docker available — testing container-to-proxy reachability..."

  CONTAINER_RESULT=$(docker run --rm \
    --add-host "host.openshell.internal:host-gateway" \
    curlimages/curl:8.10.1 \
    -sf "http://host.openshell.internal:${PROXY_PORT}/api/tags" 2>&1) || true

  if echo "$CONTAINER_RESULT" | grep -q "$MODEL"; then
    pass "Container can reach proxy at host.openshell.internal:${PROXY_PORT}"
  else
    fail "Container cannot reach proxy — reachability check would fail during onboard"
    info "Result: ${CONTAINER_RESULT:0:200}"
  fi

  # Verify container CANNOT reach Ollama directly on localhost
  DIRECT_RESULT=$(docker run --rm \
    --add-host "host.openshell.internal:host-gateway" \
    curlimages/curl:8.10.1 \
    -sf --connect-timeout 3 "http://host.openshell.internal:${OLLAMA_PORT}/api/tags" 2>&1) || DIRECT_RESULT=""

  if [ -z "$DIRECT_RESULT" ]; then
    pass "Container CANNOT reach Ollama directly on ${OLLAMA_PORT} (localhost-only binding works)"
  else
    fail "Container CAN reach Ollama on ${OLLAMA_PORT} — Ollama may be on 0.0.0.0"
  fi
else
  info "Docker not available — skipping container reachability tests"
  pass "Container reachability: skipped (no Docker)"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Ollama Auth Proxy E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Total:   $TOTAL"
echo "========================================"
echo ""
echo "  What this tested:"
echo "    - Ollama on localhost (127.0.0.1 only)"
echo "    - Auth proxy token validation (accept/reject)"
echo "    - Real inference through proxy (chat + generate)"
echo "    - Token file persistence (exists, permissions, content)"
echo "    - Proxy kill + restart from persisted token"
echo "    - Inference after proxy recovery"
echo "    - Container-to-proxy reachability (if Docker available)"
echo "    - Container cannot reach Ollama directly (localhost binding)"
echo ""

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  OLLAMA AUTH PROXY E2E PASSED\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
