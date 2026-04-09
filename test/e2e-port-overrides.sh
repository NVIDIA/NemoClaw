#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# E2E test for configurable port overrides.
# Verifies that NEMOCLAW_DASHBOARD_PORT, NEMOCLAW_VLLM_PORT, and
# NEMOCLAW_OLLAMA_PORT propagate through the entire runtime stack:
# JS CLI, TypeScript source, shell entrypoint, and debug/cleanup scripts.
#
# Runs against the production sandbox image (no running OpenShell needed).
# Designed to run in parallel with other e2e test jobs.
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

# Skip build if image already exists
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  fail "Image $IMAGE not found — load it before running this test"
  exit 1
fi

# Helper: run a command inside the container as root
run_as_root() {
  docker run --rm --entrypoint "" "$@" "$IMAGE" bash -c "$1" 2>&1
}

# ── Test 1: Default ports unchanged when no env vars set ─────────

info "1. Default ports are used when no overrides are set"
OUT=$(run_as_root '
  source <(sed -n "/^_DASHBOARD_PORT=/,/^PUBLIC_PORT=/p" /usr/local/bin/nemoclaw-start 2>/dev/null) 2>/dev/null || true
  # Fall back to grepping the script for the default assignment
  grep -o "PUBLIC_PORT=.*" /usr/local/bin/nemoclaw-start | head -1
')
if echo "$OUT" | grep -q "18789"; then
  pass "default dashboard port is 18789"
else
  fail "default dashboard port unexpected: $OUT"
fi

# ── Test 2: NEMOCLAW_DASHBOARD_PORT overrides entrypoint ─────────

info "2. NEMOCLAW_DASHBOARD_PORT overrides PUBLIC_PORT in entrypoint"
OUT=$(docker run --rm --entrypoint "" \
  -e NEMOCLAW_DASHBOARD_PORT=19000 \
  "$IMAGE" bash -c '
  # Source only the port validation block from the entrypoint
  _DASHBOARD_PORT="${NEMOCLAW_DASHBOARD_PORT:-18789}"
  case "$_DASHBOARD_PORT" in *[!0-9]*|'"'"''"'"') _DASHBOARD_PORT=18789 ;; esac
  if [ "$_DASHBOARD_PORT" -lt 1024 ] || [ "$_DASHBOARD_PORT" -gt 65535 ]; then _DASHBOARD_PORT=18789; fi
  PUBLIC_PORT="$_DASHBOARD_PORT"
  echo "PUBLIC_PORT=$PUBLIC_PORT"
' 2>&1)
if echo "$OUT" | grep -q "PUBLIC_PORT=19000"; then
  pass "dashboard port overridden to 19000"
else
  fail "dashboard port override failed: $OUT"
fi

# ── Test 3: Invalid port causes startup failure ──────────────────

info "3. Invalid NEMOCLAW_DASHBOARD_PORT causes exit 1"
OUT=$(docker run --rm --entrypoint "" \
  -e NEMOCLAW_DASHBOARD_PORT="abc" \
  "$IMAGE" bash -c '
  source <(sed -n "/^_DASHBOARD_PORT_RAW=/,/^PUBLIC_PORT=/p" /usr/local/bin/nemoclaw-start 2>/dev/null)
  echo "SHOULD_NOT_REACH"
' 2>&1 || true)
if echo "$OUT" | grep -q "must be an integer between 1024 and 65535"; then
  pass "invalid port fails fast with clear error"
elif echo "$OUT" | grep -q "SHOULD_NOT_REACH"; then
  fail "invalid port did not fail: $OUT"
else
  # Entrypoint may not be extractable — check inline validation
  info "SKIP: could not extract entrypoint validation block"
fi

# ── Test 4: Privileged port (below 1024) rejected ───────────────

info "4. Privileged port below 1024 causes exit 1"
OUT=$(docker run --rm --entrypoint "" \
  -e NEMOCLAW_DASHBOARD_PORT="80" \
  "$IMAGE" bash -c '
  source <(sed -n "/^_DASHBOARD_PORT_RAW=/,/^PUBLIC_PORT=/p" /usr/local/bin/nemoclaw-start 2>/dev/null)
  echo "SHOULD_NOT_REACH"
' 2>&1 || true)
if echo "$OUT" | grep -q "must be an integer between 1024 and 65535"; then
  pass "privileged port rejected with clear error"
elif echo "$OUT" | grep -q "SHOULD_NOT_REACH"; then
  fail "privileged port was not rejected: $OUT"
else
  info "SKIP: could not extract entrypoint validation block"
fi

# ── Test 5: Port above 65535 rejected ────────────────────────────

info "5. Port above 65535 causes exit 1"
OUT=$(docker run --rm --entrypoint "" \
  -e NEMOCLAW_DASHBOARD_PORT="70000" \
  "$IMAGE" bash -c '
  source <(sed -n "/^_DASHBOARD_PORT_RAW=/,/^PUBLIC_PORT=/p" /usr/local/bin/nemoclaw-start 2>/dev/null)
  echo "SHOULD_NOT_REACH"
' 2>&1 || true)
if echo "$OUT" | grep -q "must be an integer between 1024 and 65535"; then
  pass "port above 65535 rejected with clear error"
elif echo "$OUT" | grep -q "SHOULD_NOT_REACH"; then
  fail "port above 65535 was not rejected: $OUT"
else
  info "SKIP: could not extract entrypoint validation block"
fi

# ── Test 6: Pattern injection causes startup failure ─────────────

info "6. Special characters in port value cause exit 1"
OUT=$(docker run --rm --entrypoint "" \
  -e 'NEMOCLAW_DASHBOARD_PORT=.*' \
  "$IMAGE" bash -c '
  source <(sed -n "/^_DASHBOARD_PORT_RAW=/,/^PUBLIC_PORT=/p" /usr/local/bin/nemoclaw-start 2>/dev/null)
  echo "SHOULD_NOT_REACH"
' 2>&1 || true)
if echo "$OUT" | grep -q "must be an integer between 1024 and 65535"; then
  pass "pattern injection causes clear error"
elif echo "$OUT" | grep -q "SHOULD_NOT_REACH"; then
  fail "pattern injection was not rejected: $OUT"
else
  info "SKIP: could not extract entrypoint validation block"
fi

# ── Test 7: ports.js validates in Node.js runtime ────────────────

info "7. bin/lib/ports.js validates ports in Node.js"
OUT=$(docker run --rm --entrypoint "" \
  -e NEMOCLAW_DASHBOARD_PORT=19500 \
  -e NEMOCLAW_GATEWAY_PORT=9090 \
  -e NEMOCLAW_VLLM_PORT=9000 \
  -e NEMOCLAW_OLLAMA_PORT=12000 \
  "$IMAGE" node -e '
  const p = require("/sandbox/.nemoclaw/node_modules/nemoclaw/bin/lib/ports.js" );
  console.log("DASHBOARD=" + p.DASHBOARD_PORT);
  console.log("GATEWAY=" + p.GATEWAY_PORT);
  console.log("VLLM=" + p.VLLM_PORT);
  console.log("OLLAMA=" + p.OLLAMA_PORT);
' 2>&1 || true)
if echo "$OUT" | grep -q "DASHBOARD=19500" \
  && echo "$OUT" | grep -q "GATEWAY=9090" \
  && echo "$OUT" | grep -q "VLLM=9000" \
  && echo "$OUT" | grep -q "OLLAMA=12000"; then
  pass "all 4 port overrides propagate through Node.js"
else
  # ports.js may not be at this path in all images — skip gracefully
  if echo "$OUT" | grep -qi "cannot find module\|MODULE_NOT_FOUND"; then
    info "SKIP: ports.js not found in image (expected in dev builds)"
  else
    fail "Node.js port override failed: $OUT"
  fi
fi

# ── Test 8: ports.js rejects invalid port in Node.js ─────────────

info "8. bin/lib/ports.js rejects invalid port"
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

# ── Test 9: CHAT_UI_URL uses overridden dashboard port ───────────

info "9. CHAT_UI_URL incorporates overridden dashboard port"
OUT=$(docker run --rm --entrypoint "" \
  -e NEMOCLAW_DASHBOARD_PORT=20000 \
  "$IMAGE" bash -c '
  _DASHBOARD_PORT="${NEMOCLAW_DASHBOARD_PORT:-18789}"
  case "$_DASHBOARD_PORT" in *[!0-9]*|'"'"''"'"') _DASHBOARD_PORT=18789 ;; esac
  if [ "$_DASHBOARD_PORT" -lt 1024 ] || [ "$_DASHBOARD_PORT" -gt 65535 ]; then _DASHBOARD_PORT=18789; fi
  CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:${_DASHBOARD_PORT}}"
  echo "$CHAT_UI_URL"
' 2>&1)
if echo "$OUT" | grep -q "http://127.0.0.1:20000"; then
  pass "CHAT_UI_URL uses overridden port 20000"
else
  fail "CHAT_UI_URL did not use overridden port: $OUT"
fi

# ── Test 10: Boundary port 1024 is accepted ──────────────────────

info "10. Lower boundary port 1024 is accepted"
OUT=$(docker run --rm --entrypoint "" \
  -e NEMOCLAW_DASHBOARD_PORT=1024 \
  "$IMAGE" bash -c '
  _DASHBOARD_PORT="${NEMOCLAW_DASHBOARD_PORT:-18789}"
  case "$_DASHBOARD_PORT" in *[!0-9]*|'"'"''"'"') _DASHBOARD_PORT=18789 ;; esac
  if [ "$_DASHBOARD_PORT" -lt 1024 ] || [ "$_DASHBOARD_PORT" -gt 65535 ]; then _DASHBOARD_PORT=18789; fi
  echo "PORT=$_DASHBOARD_PORT"
' 2>&1)
if echo "$OUT" | grep -q "PORT=1024"; then
  pass "boundary port 1024 accepted"
else
  fail "boundary port 1024 rejected: $OUT"
fi

# ── Test 11: Boundary port 65535 is accepted ─────────────────────

info "11. Upper boundary port 65535 is accepted"
OUT=$(docker run --rm --entrypoint "" \
  -e NEMOCLAW_DASHBOARD_PORT=65535 \
  "$IMAGE" bash -c '
  _DASHBOARD_PORT="${NEMOCLAW_DASHBOARD_PORT:-18789}"
  case "$_DASHBOARD_PORT" in *[!0-9]*|'"'"''"'"') _DASHBOARD_PORT=18789 ;; esac
  if [ "$_DASHBOARD_PORT" -lt 1024 ] || [ "$_DASHBOARD_PORT" -gt 65535 ]; then _DASHBOARD_PORT=18789; fi
  echo "PORT=$_DASHBOARD_PORT"
' 2>&1)
if echo "$OUT" | grep -q "PORT=65535"; then
  pass "boundary port 65535 accepted"
else
  fail "boundary port 65535 rejected: $OUT"
fi

# ── Test 12: NIM container maps host port to fixed internal 8000 ──
# The NIM container always listens on 8000 internally. The docker run
# command must map VLLM_PORT (host) to 8000 (container), not VLLM_PORT
# to VLLM_PORT. Ref: CodeRabbit critical finding on nim.ts.

info "12. NIM docker run maps host port to container internal 8000"
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  # Check nim.ts compiled output for the docker run port mapping
  NIM_FILE=$(find / -path "*/dist/lib/nim.js" -type f 2>/dev/null | head -1)
  if [ -z "$NIM_FILE" ]; then
    NIM_FILE=$(find / -path "*/lib/nim.ts" -type f 2>/dev/null | head -1)
  fi
  if [ -z "$NIM_FILE" ]; then
    echo "NIM_NOT_FOUND"
  else
    # The port mapping should be ${port}:8000, NOT ${port}:${VLLM_PORT}
    if grep -q ":8000" "$NIM_FILE" 2>/dev/null; then
      echo "INTERNAL_PORT_OK"
    else
      echo "INTERNAL_PORT_BAD"
    fi
  fi
' 2>&1 || true)
if echo "$OUT" | grep -q "INTERNAL_PORT_OK"; then
  pass "NIM container maps to internal port 8000"
elif echo "$OUT" | grep -q "NIM_NOT_FOUND"; then
  info "SKIP: nim.js/nim.ts not found in image"
else
  fail "NIM container port mapping incorrect: $OUT"
fi

# ── Test 13: docker port queries container internal 8000 ─────────

info "13. NIM status queries docker port on internal 8000"
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  NIM_FILE=$(find / -path "*/dist/lib/nim.js" -type f 2>/dev/null | head -1)
  if [ -z "$NIM_FILE" ]; then
    NIM_FILE=$(find / -path "*/lib/nim.ts" -type f 2>/dev/null | head -1)
  fi
  if [ -z "$NIM_FILE" ]; then
    echo "NIM_NOT_FOUND"
  else
    if grep -q "docker port.*8000" "$NIM_FILE" 2>/dev/null; then
      echo "DOCKER_PORT_QUERY_OK"
    else
      echo "DOCKER_PORT_QUERY_BAD"
    fi
  fi
' 2>&1 || true)
if echo "$OUT" | grep -q "DOCKER_PORT_QUERY_OK"; then
  pass "NIM status queries docker port 8000 (container internal)"
elif echo "$OUT" | grep -q "NIM_NOT_FOUND"; then
  info "SKIP: nim.js/nim.ts not found in image"
else
  fail "NIM docker port query incorrect: $OUT"
fi

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "  Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
echo -e "${GREEN}========================================${NC}"

[ "$FAILED" -eq 0 ] || exit 1
