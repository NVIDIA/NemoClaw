#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Double onboard / lifecycle recovery:
#   - prove repeat onboard reuses the healthy shared NemoClaw gateway
#   - prove onboarding a second sandbox does not destroy the first sandbox
#   - prove stale registry entries are reconciled against live OpenShell state
#   - prove gateway rebuilds surface the expected lifecycle guidance
#
# This script intentionally uses a local fake OpenAI-compatible endpoint so it
# matches the current onboarding flow. Older versions of this test relied on a
# missing/invalid NVIDIA_API_KEY causing a late failure after sandbox creation;
# that no longer reflects current non-interactive onboarding behavior.

set -uo pipefail

if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-900}"
  exec timeout -s TERM "$TIMEOUT_SECONDS" "$0" "$@"
fi

PASS=0
FAIL=0
TOTAL=0

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
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

registry_has() {
  local sandbox_name="$1"
  [ -f "$REGISTRY" ] && grep -q "$sandbox_name" "$REGISTRY"
}

SANDBOX_A="e2e-double-a"
SANDBOX_B="e2e-double-b"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FAKE_HOST="127.0.0.1"
FAKE_PORT="${NEMOCLAW_FAKE_PORT:-18080}"
FAKE_BASE_URL="http://${FAKE_HOST}:${FAKE_PORT}/v1"
FAKE_LOG="$(mktemp)"
FAKE_PID=""

if command -v node >/dev/null 2>&1 && [ -f "$REPO_ROOT/bin/nemoclaw.js" ]; then
  NEMOCLAW_CMD=(node "$REPO_ROOT/bin/nemoclaw.js")
else
  NEMOCLAW_CMD=(nemoclaw)
fi

# shellcheck disable=SC2329
cleanup() {
  if [ -n "$FAKE_PID" ] && kill -0 "$FAKE_PID" 2>/dev/null; then
    kill "$FAKE_PID" 2>/dev/null || true
    wait "$FAKE_PID" 2>/dev/null || true
  fi
  rm -f "$FAKE_LOG"
}
trap cleanup EXIT

start_fake_openai() {
  python3 - "$FAKE_HOST" "$FAKE_PORT" >"$FAKE_LOG" 2>&1 <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = sys.argv[1]
PORT = int(sys.argv[2])


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return

    def do_GET(self):
        if self.path in ("/v1/models", "/models"):
            self._send(200, {"data": [{"id": "test-model", "object": "model"}]})
            return
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length:
            self.rfile.read(length)
        if self.path in ("/v1/chat/completions", "/chat/completions"):
            self._send(
                200,
                {
                    "id": "chatcmpl-test",
                    "object": "chat.completion",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                },
            )
            return
        if self.path in ("/v1/responses", "/responses"):
            self._send(
                200,
                {
                    "id": "resp-test",
                    "object": "response",
                    "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}],
                },
            )
            return
        self._send(404, {"error": {"message": "not found"}})


HTTPServer((HOST, PORT), Handler).serve_forever()
PY
  FAKE_PID=$!

  for _ in $(seq 1 20); do
    if curl -sf "${FAKE_BASE_URL}/models" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  return 1
}

run_onboard() {
  local sandbox_name="$1"
  local recreate="${2:-0}"
  local log_file
  log_file="$(mktemp)"

  local -a env_args=(
    "COMPATIBLE_API_KEY=dummy"
    "NEMOCLAW_NON_INTERACTIVE=1"
    "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1"
    "NEMOCLAW_PROVIDER=custom"
    "NEMOCLAW_ENDPOINT_URL=${FAKE_BASE_URL}"
    "NEMOCLAW_MODEL=test-model"
    "NEMOCLAW_SANDBOX_NAME=${sandbox_name}"
    "NEMOCLAW_POLICY_MODE=skip"
  )
  if [ "$recreate" = "1" ]; then
    env_args+=("NEMOCLAW_RECREATE_SANDBOX=1")
  fi

  env "${env_args[@]}" "${NEMOCLAW_CMD[@]}" onboard --non-interactive >"$log_file" 2>&1
  RUN_ONBOARD_EXIT=$?
  RUN_ONBOARD_OUTPUT="$(cat "$log_file")"
  rm -f "$log_file"
}

run_nemoclaw() {
  "${NEMOCLAW_CMD[@]}" "$@"
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Pre-cleanup"
info "Destroying any leftover test sandboxes/gateway from previous runs..."
if [ -x "$REPO_ROOT/bin/nemoclaw.js" ] || command -v nemoclaw >/dev/null 2>&1; then
  run_nemoclaw "$SANDBOX_A" destroy --yes 2>/dev/null || true
  run_nemoclaw "$SANDBOX_B" destroy --yes 2>/dev/null || true
fi
openshell sandbox delete "$SANDBOX_A" 2>/dev/null || true
openshell sandbox delete "$SANDBOX_B" 2>/dev/null || true
openshell forward stop 18789 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Prerequisites + fake endpoint
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell CLI installed"
else
  fail "openshell CLI not found — cannot continue"
  exit 1
fi

if [ -x "$REPO_ROOT/bin/nemoclaw.js" ] || command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw CLI available"
else
  fail "nemoclaw CLI not found — cannot continue"
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  pass "python3 installed"
else
  fail "python3 not found — cannot continue"
  exit 1
fi

if start_fake_openai; then
  pass "Fake OpenAI-compatible endpoint started at ${FAKE_BASE_URL}"
else
  fail "Failed to start fake OpenAI-compatible endpoint"
  info "Fake server log:"
  sed 's/^/    /' "$FAKE_LOG"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: First onboard (e2e-double-a)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: First onboard ($SANDBOX_A)"
info "Running successful non-interactive onboard against local compatible endpoint..."

run_onboard "$SANDBOX_A"
output1="$RUN_ONBOARD_OUTPUT"
exit1="$RUN_ONBOARD_EXIT"

if [ "$exit1" -eq 0 ]; then
  pass "First onboard completed successfully"
else
  fail "First onboard exited $exit1 (expected 0)"
fi

if grep -q "Sandbox '${SANDBOX_A}' created" <<<"$output1"; then
  pass "Sandbox '$SANDBOX_A' created"
else
  fail "Sandbox '$SANDBOX_A' creation not confirmed in output"
fi

if openshell gateway info -g nemoclaw 2>/dev/null | grep -q "nemoclaw"; then
  pass "Gateway is running after first onboard"
else
  fail "Gateway is not running after first onboard"
fi

if openshell sandbox get "$SANDBOX_A" >/dev/null 2>&1; then
  pass "Sandbox '$SANDBOX_A' exists in openshell"
else
  fail "Sandbox '$SANDBOX_A' not found in openshell"
fi

if registry_has "$SANDBOX_A"; then
  pass "Registry contains '$SANDBOX_A'"
else
  fail "Registry does not contain '$SANDBOX_A'"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Second onboard — SAME name (recreate)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Second onboard ($SANDBOX_A — same name, recreate)"
info "Running nemoclaw onboard with NEMOCLAW_RECREATE_SANDBOX=1..."

run_onboard "$SANDBOX_A" "1"
output2="$RUN_ONBOARD_OUTPUT"
exit2="$RUN_ONBOARD_EXIT"

if [ "$exit2" -eq 0 ]; then
  pass "Second onboard completed successfully"
else
  fail "Second onboard exited $exit2 (expected 0)"
fi

if grep -q "Reusing existing NemoClaw gateway" <<<"$output2"; then
  pass "Healthy gateway reused on second onboard"
else
  fail "Healthy gateway was not reused on second onboard"
fi

if grep -q "Port 8080 is not available" <<<"$output2"; then
  fail "Port 8080 conflict detected (regression)"
else
  pass "No port 8080 conflict on second onboard"
fi

if grep -q "Port 18789 is not available" <<<"$output2"; then
  fail "Port 18789 conflict detected on second onboard"
else
  pass "No port 18789 conflict on second onboard"
fi

if openshell sandbox get "$SANDBOX_A" >/dev/null 2>&1; then
  pass "Sandbox '$SANDBOX_A' still exists after recreate"
else
  fail "Sandbox '$SANDBOX_A' missing after recreate"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Third onboard — DIFFERENT name
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Third onboard ($SANDBOX_B — different name)"
info "Running nemoclaw onboard with new sandbox name..."

run_onboard "$SANDBOX_B"
output3="$RUN_ONBOARD_OUTPUT"
exit3="$RUN_ONBOARD_EXIT"

if [ "$exit3" -eq 0 ]; then
  pass "Third onboard completed successfully"
else
  fail "Third onboard exited $exit3 (expected 0)"
fi

if grep -q "Reusing existing NemoClaw gateway" <<<"$output3"; then
  pass "Healthy gateway reused on third onboard"
else
  fail "Healthy gateway was not reused on third onboard"
fi

if grep -q "Port 8080 is not available" <<<"$output3"; then
  fail "Port 8080 conflict on third onboard"
else
  pass "No port 8080 conflict on third onboard"
fi

if grep -q "Port 18789 is not available" <<<"$output3"; then
  fail "Port 18789 conflict on third onboard"
else
  pass "No port 18789 conflict on third onboard"
fi

if openshell sandbox get "$SANDBOX_B" >/dev/null 2>&1; then
  pass "Sandbox '$SANDBOX_B' created"
else
  fail "Sandbox '$SANDBOX_B' was not created"
fi

if openshell sandbox get "$SANDBOX_A" >/dev/null 2>&1; then
  pass "First sandbox '$SANDBOX_A' still exists after creating '$SANDBOX_B'"
else
  fail "First sandbox '$SANDBOX_A' disappeared after creating '$SANDBOX_B' (regression: #849)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Stale registry reconciliation
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Stale registry reconciliation"
info "Deleting '$SANDBOX_A' directly in OpenShell to leave a stale NemoClaw registry entry..."

openshell sandbox delete "$SANDBOX_A" 2>/dev/null || true

if registry_has "$SANDBOX_A"; then
  pass "Registry still contains stale '$SANDBOX_A' entry"
else
  fail "Registry was unexpectedly cleaned before status reconciliation"
fi

STATUS_LOG="$(mktemp)"
run_nemoclaw "$SANDBOX_A" status >"$STATUS_LOG" 2>&1
status_exit=$?
status_output="$(cat "$STATUS_LOG")"
rm -f "$STATUS_LOG"

if [ "$status_exit" -eq 0 ]; then
  pass "Stale sandbox status exited 0"
else
  fail "Stale sandbox status exited $status_exit (expected 0)"
fi

if grep -q "Removed stale local registry entry" <<<"$status_output"; then
  pass "Stale registry entry was reconciled during status"
else
  fail "Stale registry reconciliation message missing"
fi

if registry_has "$SANDBOX_A"; then
  fail "Registry still contains '$SANDBOX_A' after status reconciliation"
else
  pass "Registry entry for '$SANDBOX_A' removed after status reconciliation"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Gateway lifecycle response
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Gateway lifecycle response"
info "Stopping the NemoClaw gateway runtime to verify current lifecycle behavior..."

openshell forward stop 18789 2>/dev/null || true
openshell gateway stop -g nemoclaw 2>/dev/null || true

GATEWAY_LOG="$(mktemp)"
run_nemoclaw "$SANDBOX_B" status >"$GATEWAY_LOG" 2>&1
gateway_status_exit=$?
gateway_status_output="$(cat "$GATEWAY_LOG")"
rm -f "$GATEWAY_LOG"

if [ "$gateway_status_exit" -eq 0 ]; then
  pass "Post-stop status exited 0"
else
  fail "Post-stop status exited $gateway_status_exit (expected 0)"
fi

if grep -qE \
  "Recovered NemoClaw gateway runtime|gateway is no longer configured after restart/rebuild|gateway is still refusing connections after restart|gateway trust material rotated after restart" \
  <<<"$gateway_status_output"; then
  pass "Gateway lifecycle response was explicit after gateway stop"
else
  fail "Gateway lifecycle response was not explicit after gateway stop"
  info "Observed status output:"
  printf '%s\n' "$gateway_status_output" | sed 's/^/    /'
fi

if registry_has "$SANDBOX_B"; then
  pass "Registry still contains '$SANDBOX_B' after gateway stop"
else
  fail "Registry is missing '$SANDBOX_B' after gateway stop"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: Final cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 7: Final cleanup"

run_nemoclaw "$SANDBOX_A" destroy --yes 2>/dev/null || true
run_nemoclaw "$SANDBOX_B" destroy --yes 2>/dev/null || true
openshell sandbox delete "$SANDBOX_A" 2>/dev/null || true
openshell sandbox delete "$SANDBOX_B" 2>/dev/null || true
openshell forward stop 18789 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

if openshell sandbox get "$SANDBOX_A" >/dev/null 2>&1; then
  fail "Sandbox '$SANDBOX_A' still exists after cleanup"
else
  pass "Sandbox '$SANDBOX_A' cleaned up"
fi

if openshell sandbox get "$SANDBOX_B" >/dev/null 2>&1; then
  fail "Sandbox '$SANDBOX_B' still exists after cleanup"
else
  pass "Sandbox '$SANDBOX_B' cleaned up"
fi

if [ -f "$REGISTRY" ] && grep -q "$SANDBOX_A\|$SANDBOX_B" "$REGISTRY"; then
  fail "Registry still contains test sandbox entries"
else
  pass "Registry cleaned up"
fi

pass "Final cleanup complete"

echo ""
echo "========================================"
echo "  Double Onboard E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Double onboard and lifecycle recovery PASSED.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
