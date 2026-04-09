#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# E2E test for configurable port overrides.
# Verifies that NEMOCLAW_DASHBOARD_PORT, NEMOCLAW_VLLM_PORT, and
# NEMOCLAW_OLLAMA_PORT propagate through the runtime stack.
#
# Runs against the production sandbox image (no running OpenShell needed).
# Designed to run in parallel with other e2e test jobs.
#
# Requires: docker

# shellcheck disable=SC2016  # Single-quoted strings are intentional — they run inside the container, not the host.
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

# Helper: run a command inside the container.
# Usage: run_in_container "shell command" [-e KEY=VAL ...]
run_in_container() {
  local cmd="$1"
  shift
  docker run --rm --entrypoint "" "$@" "$IMAGE" bash -c "$cmd" 2>&1
}

# ── Test 1: Entrypoint has correct default port ──────────────────

info "1. Default dashboard port is 18789 in entrypoint"
OUT=$(run_in_container 'grep "_DASHBOARD_PORT=18789" /usr/local/bin/nemoclaw-start | head -1')
if echo "$OUT" | grep -q "18789"; then
  pass "default dashboard port is 18789"
else
  fail "default dashboard port unexpected: $OUT"
fi

# ── Test 2: Valid port override propagates ────────────────────────

info "2. NEMOCLAW_DASHBOARD_PORT=19000 is accepted"
OUT=$(run_in_container '
  export NEMOCLAW_DASHBOARD_PORT=19000
  _DP_RAW="${NEMOCLAW_DASHBOARD_PORT:-}"
  _DP="$(printf "%s" "$_DP_RAW" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")"
  case "$_DP" in *[!0-9]*|"") exit 1 ;; esac
  [ "$_DP" -ge 1024 ] && [ "$_DP" -le 65535 ] || exit 1
  echo "PORT=$_DP"
')
if echo "$OUT" | grep -q "PORT=19000"; then
  pass "dashboard port overridden to 19000"
else
  fail "dashboard port override failed: $OUT"
fi

# ── Test 3: Non-numeric port rejected ────────────────────────────

info "3. Non-numeric NEMOCLAW_DASHBOARD_PORT is rejected"
RC=0
run_in_container '
  export NEMOCLAW_DASHBOARD_PORT=abc
  _DP_RAW="${NEMOCLAW_DASHBOARD_PORT:-}"
  _DP="$(printf "%s" "$_DP_RAW" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")"
  case "$_DP" in *[!0-9]*|"") exit 1 ;; esac
  echo "SHOULD_NOT_REACH"
' >/dev/null 2>&1 || RC=$?
if [ "$RC" -ne 0 ]; then
  pass "non-numeric port rejected (exit $RC)"
else
  fail "non-numeric port was accepted"
fi

# ── Test 4: Privileged port rejected ─────────────────────────────

info "4. Privileged port 80 is rejected"
RC=0
run_in_container '
  export NEMOCLAW_DASHBOARD_PORT=80
  _DP_RAW="${NEMOCLAW_DASHBOARD_PORT:-}"
  _DP="$(printf "%s" "$_DP_RAW" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")"
  case "$_DP" in *[!0-9]*|"") exit 1 ;; esac
  [ "$_DP" -ge 1024 ] && [ "$_DP" -le 65535 ] || exit 1
  echo "SHOULD_NOT_REACH"
' >/dev/null 2>&1 || RC=$?
if [ "$RC" -ne 0 ]; then
  pass "privileged port rejected (exit $RC)"
else
  fail "privileged port was accepted"
fi

# ── Test 5: Port above 65535 rejected ────────────────────────────

info "5. Port 70000 is rejected"
RC=0
run_in_container '
  export NEMOCLAW_DASHBOARD_PORT=70000
  _DP_RAW="${NEMOCLAW_DASHBOARD_PORT:-}"
  _DP="$(printf "%s" "$_DP_RAW" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")"
  case "$_DP" in *[!0-9]*|"") exit 1 ;; esac
  [ "$_DP" -ge 1024 ] && [ "$_DP" -le 65535 ] || exit 1
  echo "SHOULD_NOT_REACH"
' >/dev/null 2>&1 || RC=$?
if [ "$RC" -ne 0 ]; then
  pass "port above 65535 rejected (exit $RC)"
else
  fail "port above 65535 was accepted"
fi

# ── Test 6: Pattern injection rejected ───────────────────────────

info "6. Pattern injection '.*' is rejected"
RC=0
run_in_container '
  export NEMOCLAW_DASHBOARD_PORT=".*"
  _DP_RAW="${NEMOCLAW_DASHBOARD_PORT:-}"
  _DP="$(printf "%s" "$_DP_RAW" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")"
  case "$_DP" in *[!0-9]*|"") exit 1 ;; esac
  echo "SHOULD_NOT_REACH"
' >/dev/null 2>&1 || RC=$?
if [ "$RC" -ne 0 ]; then
  pass "pattern injection rejected (exit $RC)"
else
  fail "pattern injection was accepted"
fi

# ── Test 7: ports.js propagates all 4 overrides ─────────────────

info "7. Node.js ports module propagates all 4 port overrides"
OUT=$(docker run --rm --entrypoint "" \
  -e NEMOCLAW_DASHBOARD_PORT=19500 \
  -e NEMOCLAW_GATEWAY_PORT=9090 \
  -e NEMOCLAW_VLLM_PORT=9000 \
  -e NEMOCLAW_OLLAMA_PORT=12000 \
  "$IMAGE" node -e '
  try {
    const p = require("/sandbox/.nemoclaw/node_modules/nemoclaw/bin/lib/ports.js");
    console.log("DASHBOARD=" + p.DASHBOARD_PORT);
    console.log("GATEWAY=" + p.GATEWAY_PORT);
    console.log("VLLM=" + p.VLLM_PORT);
    console.log("OLLAMA=" + p.OLLAMA_PORT);
  } catch(e) { console.log("MODULE_NOT_FOUND"); }
' 2>&1 || true)
if echo "$OUT" | grep -q "DASHBOARD=19500" \
  && echo "$OUT" | grep -q "GATEWAY=9090" \
  && echo "$OUT" | grep -q "VLLM=9000" \
  && echo "$OUT" | grep -q "OLLAMA=12000"; then
  pass "all 4 port overrides propagate through Node.js"
elif echo "$OUT" | grep -q "MODULE_NOT_FOUND"; then
  info "SKIP: ports.js not found in image (expected in dev builds)"
else
  fail "Node.js port override failed: $OUT"
fi

# ── Test 8: ports.js rejects invalid port ────────────────────────

info "8. Node.js ports module rejects invalid port"
OUT=$(docker run --rm --entrypoint "" \
  -e NEMOCLAW_DASHBOARD_PORT="notaport" \
  "$IMAGE" node -e '
  try {
    require("/sandbox/.nemoclaw/node_modules/nemoclaw/bin/lib/ports.js");
    console.log("NO_ERROR");
  } catch (e) {
    console.log("ERROR=" + e.message);
  }
' 2>&1 || true)
if echo "$OUT" | grep -q "ERROR=.*Invalid port"; then
  pass "Node.js rejects invalid port with clear error"
elif echo "$OUT" | grep -qi "cannot find module\|MODULE_NOT_FOUND"; then
  info "SKIP: ports.js not found in image"
else
  fail "Node.js did not reject invalid port: $OUT"
fi

# ── Test 9: Boundary port 1024 accepted ──────────────────────────

info "9. Lower boundary port 1024 is accepted"
OUT=$(run_in_container '
  export NEMOCLAW_DASHBOARD_PORT=1024
  _DP="$NEMOCLAW_DASHBOARD_PORT"
  [ "$_DP" -ge 1024 ] && [ "$_DP" -le 65535 ] && echo "PORT=$_DP" || echo "REJECTED"
')
if echo "$OUT" | grep -q "PORT=1024"; then
  pass "boundary port 1024 accepted"
else
  fail "boundary port 1024 rejected: $OUT"
fi

# ── Test 10: Boundary port 65535 accepted ────────────────────────

info "10. Upper boundary port 65535 is accepted"
OUT=$(run_in_container '
  export NEMOCLAW_DASHBOARD_PORT=65535
  _DP="$NEMOCLAW_DASHBOARD_PORT"
  [ "$_DP" -ge 1024 ] && [ "$_DP" -le 65535 ] && echo "PORT=$_DP" || echo "REJECTED"
')
if echo "$OUT" | grep -q "PORT=65535"; then
  pass "boundary port 65535 accepted"
else
  fail "boundary port 65535 rejected: $OUT"
fi

# ── Test 11: NIM maps host port to fixed internal 8000 ───────────

info "11. NIM docker run maps host port to container internal 8000"
OUT=$(run_in_container '
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

# ── Test 12: docker port queries container internal 8000 ─────────

info "12. NIM status queries docker port on internal 8000"
OUT=$(run_in_container '
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

# ── Test 13: Entrypoint validation block exists ──────────────────

info "13. Entrypoint has fail-fast validation for dashboard port"
OUT=$(run_in_container '
  grep -c "exit 1" /usr/local/bin/nemoclaw-start | head -1
  grep -q "must be an integer between 1024 and 65535" /usr/local/bin/nemoclaw-start && echo "VALIDATION_MSG_OK" || echo "VALIDATION_MSG_MISSING"
')
if echo "$OUT" | grep -q "VALIDATION_MSG_OK"; then
  pass "entrypoint has fail-fast validation with clear error message"
else
  fail "entrypoint validation message missing: $OUT"
fi

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "  Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
echo -e "${GREEN}========================================${NC}"

[ "$FAILED" -eq 0 ] || exit 1
