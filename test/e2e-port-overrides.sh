#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# E2E test for configurable port overrides.
# Verifies that NEMOCLAW_DASHBOARD_PORT, NEMOCLAW_VLLM_PORT, and
# NEMOCLAW_OLLAMA_PORT propagate through the runtime stack.
#
# Tests drive the real entrypoint (nemoclaw-start) and the real Node.js
# ports module — no reimplemented validation snippets.
#
# Requires: docker

set -euo pipefail

IMAGE="${NEMOCLAW_TEST_IMAGE:-nemoclaw-production}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
  echo -e "${GREEN}PASS${NC}: $1"
  PASSED=$((PASSED + 1))
}
fail() {
  echo -e "${RED}FAIL${NC}: $1"
  FAILED=$((FAILED + 1))
}
info() { echo -e "${YELLOW}TEST${NC}: $1"; }

PASSED=0
FAILED=0

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  fail "Image $IMAGE not found — load it before running this test"
  exit 1
fi

# Helper: run the real entrypoint with a given port override.
# Returns combined stdout+stderr. Caller checks $? or output.
run_entrypoint_with_port() {
  local port="$1"
  docker run --rm -e "NEMOCLAW_DASHBOARD_PORT=$port" "$IMAGE" true 2>&1 || return $?
}

# Helper: run the real entrypoint with default port (no override).
run_entrypoint_default() {
  docker run --rm "$IMAGE" true 2>&1 || return $?
}

# Helper: test a port via the Node.js ports module inside the container.
# Prints the parsed value or ERROR=<message>.
run_node_ports() {
  local env_args=()
  for arg in "$@"; do
    env_args+=(-e "$arg")
  done
  docker run --rm --entrypoint "" "${env_args[@]}" "$IMAGE" node -e '
    try {
      const p = require("/sandbox/.nemoclaw/node_modules/nemoclaw/bin/lib/ports.js");
      console.log("DASHBOARD=" + p.DASHBOARD_PORT);
      console.log("GATEWAY=" + p.GATEWAY_PORT);
      console.log("VLLM=" + p.VLLM_PORT);
      console.log("OLLAMA=" + p.OLLAMA_PORT);
    } catch(e) { console.log("ERROR=" + e.message); }
  ' 2>&1 || true
}

# ── Test 1: Default port works through real entrypoint ──────────

info "1. Default dashboard port (no override) accepted by entrypoint"
OUT=$(run_entrypoint_default || true)
if ! echo "$OUT" | grep -q "\[SECURITY\].*NEMOCLAW_DASHBOARD_PORT"; then
  pass "default dashboard port accepted by entrypoint"
else
  fail "default port rejected by entrypoint: $OUT"
fi

# ── Test 2: Valid port override accepted by real entrypoint ─────

info "2. NEMOCLAW_DASHBOARD_PORT=19000 accepted by entrypoint"
OUT=$(run_entrypoint_with_port 19000 || true)
if ! echo "$OUT" | grep -q "\[SECURITY\].*NEMOCLAW_DASHBOARD_PORT"; then
  pass "dashboard port 19000 accepted by entrypoint"
else
  fail "dashboard port 19000 rejected by entrypoint: $OUT"
fi

# ── Test 3: Non-numeric port rejected by real entrypoint ────────

info "3. Non-numeric NEMOCLAW_DASHBOARD_PORT rejected by entrypoint"
RC=0
OUT=$(run_entrypoint_with_port "abc") || RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "must be an integer between 1024 and 65535"; then
  pass "non-numeric port rejected by entrypoint (exit $RC)"
else
  fail "non-numeric port not properly rejected (exit $RC): $OUT"
fi

# ── Test 4: Privileged port rejected by real entrypoint ─────────

info "4. Privileged port 80 rejected by entrypoint"
RC=0
OUT=$(run_entrypoint_with_port 80) || RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "must be an integer between 1024 and 65535"; then
  pass "privileged port 80 rejected by entrypoint (exit $RC)"
else
  fail "privileged port 80 not properly rejected (exit $RC): $OUT"
fi

# ── Test 5: Port above 65535 rejected by real entrypoint ────────

info "5. Port 70000 rejected by entrypoint"
RC=0
OUT=$(run_entrypoint_with_port 70000) || RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "must be an integer between 1024 and 65535"; then
  pass "port 70000 rejected by entrypoint (exit $RC)"
else
  fail "port 70000 not properly rejected (exit $RC): $OUT"
fi

# ── Test 6: Pattern injection rejected by real entrypoint ───────

info "6. Pattern injection '.*' rejected by entrypoint"
RC=0
OUT=$(run_entrypoint_with_port ".*") || RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "must be an integer between 1024 and 65535"; then
  pass "pattern injection rejected by entrypoint (exit $RC)"
else
  fail "pattern injection not properly rejected (exit $RC): $OUT"
fi

# ── Test 7: Node.js ports module propagates all 4 overrides ────

info "7. Node.js ports module propagates all 4 port overrides"
OUT=$(run_node_ports \
  "NEMOCLAW_DASHBOARD_PORT=19500" \
  "NEMOCLAW_GATEWAY_PORT=9090" \
  "NEMOCLAW_VLLM_PORT=9000" \
  "NEMOCLAW_OLLAMA_PORT=12000")
if echo "$OUT" | grep -q "DASHBOARD=19500" \
  && echo "$OUT" | grep -q "GATEWAY=9090" \
  && echo "$OUT" | grep -q "VLLM=9000" \
  && echo "$OUT" | grep -q "OLLAMA=12000"; then
  pass "all 4 port overrides propagate through Node.js"
elif echo "$OUT" | grep -qi "cannot find module\|MODULE_NOT_FOUND"; then
  info "SKIP: ports.js not found in image (expected in dev builds)"
else
  fail "Node.js port override failed: $OUT"
fi

# ── Test 8: Node.js ports module rejects invalid port ───────────

info "8. Node.js ports module rejects invalid port"
OUT=$(run_node_ports "NEMOCLAW_DASHBOARD_PORT=notaport")
if echo "$OUT" | grep -q "ERROR=.*Invalid port"; then
  pass "Node.js rejects invalid port with clear error"
elif echo "$OUT" | grep -qi "cannot find module\|MODULE_NOT_FOUND"; then
  info "SKIP: ports.js not found in image"
else
  fail "Node.js did not reject invalid port: $OUT"
fi

# ── Test 9: Boundary port 1024 accepted by real entrypoint ──────

info "9. Lower boundary port 1024 accepted by entrypoint"
OUT=$(run_entrypoint_with_port 1024 || true)
if ! echo "$OUT" | grep -q "\[SECURITY\].*NEMOCLAW_DASHBOARD_PORT"; then
  pass "boundary port 1024 accepted by entrypoint"
else
  fail "boundary port 1024 rejected by entrypoint: $OUT"
fi

# ── Test 10: Boundary port 65535 accepted by real entrypoint ────

info "10. Upper boundary port 65535 accepted by entrypoint"
OUT=$(run_entrypoint_with_port 65535 || true)
if ! echo "$OUT" | grep -q "\[SECURITY\].*NEMOCLAW_DASHBOARD_PORT"; then
  pass "boundary port 65535 accepted by entrypoint"
else
  fail "boundary port 65535 rejected by entrypoint: $OUT"
fi

# ── Test 11: NIM maps host port to fixed internal 8000 ──────────

info "11. NIM docker run maps host port to container internal 8000"
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  NIM_FILE=$(find / -path "*/dist/lib/nim.js" -type f 2>/dev/null | head -1)
  [ -z "$NIM_FILE" ] && NIM_FILE=$(find / -path "*/lib/nim.ts" -type f 2>/dev/null | head -1)
  if [ -z "$NIM_FILE" ]; then echo "NIM_NOT_FOUND"
  elif grep -q ":8000" "$NIM_FILE" 2>/dev/null; then echo "INTERNAL_PORT_OK"
  else echo "INTERNAL_PORT_BAD"; fi
' || true)
if echo "$OUT" | grep -q "INTERNAL_PORT_OK"; then
  pass "NIM container maps to internal port 8000"
elif echo "$OUT" | grep -q "NIM_NOT_FOUND"; then
  info "SKIP: nim.js/nim.ts not found in image"
else
  fail "NIM container port mapping incorrect: $OUT"
fi

# ── Test 12: docker port queries container internal 8000 ────────

info "12. NIM status queries docker port on internal 8000"
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  NIM_FILE=$(find / -path "*/dist/lib/nim.js" -type f 2>/dev/null | head -1)
  [ -z "$NIM_FILE" ] && NIM_FILE=$(find / -path "*/lib/nim.ts" -type f 2>/dev/null | head -1)
  if [ -z "$NIM_FILE" ]; then echo "NIM_NOT_FOUND"
  elif grep -q "docker port.*8000" "$NIM_FILE" 2>/dev/null; then echo "DOCKER_PORT_QUERY_OK"
  else echo "DOCKER_PORT_QUERY_BAD"; fi
' || true)
if echo "$OUT" | grep -q "DOCKER_PORT_QUERY_OK"; then
  pass "NIM status queries docker port 8000 (container internal)"
elif echo "$OUT" | grep -q "NIM_NOT_FOUND"; then
  info "SKIP: nim.js/nim.ts not found in image"
else
  fail "NIM docker port query incorrect: $OUT"
fi

# ── Test 13: Entrypoint has fail-fast validation block ──────────

info "13. Entrypoint has fail-fast validation for dashboard port"
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  grep -q "must be an integer between 1024 and 65535" /usr/local/bin/nemoclaw-start && echo "VALIDATION_MSG_OK" || echo "VALIDATION_MSG_MISSING"
  grep -q "exit 1" /usr/local/bin/nemoclaw-start && echo "FAIL_FAST_OK" || echo "FAIL_FAST_MISSING"
')
if echo "$OUT" | grep -q "VALIDATION_MSG_OK" && echo "$OUT" | grep -q "FAIL_FAST_OK"; then
  pass "entrypoint has fail-fast validation with clear error message"
else
  fail "entrypoint validation block missing: $OUT"
fi

# ── Summary ─────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "  Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
echo -e "${GREEN}========================================${NC}"

[ "$FAILED" -eq 0 ] || exit 1
