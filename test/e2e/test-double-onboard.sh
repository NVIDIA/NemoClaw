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

# ShellCheck cannot see EXIT trap invocations of cleanup helpers in this E2E script.
# shellcheck disable=SC2317
set -uo pipefail

# Three sequential sandbox creations (~5-7 min each) plus cleanup phases need
# well over the default 900s.  80 min leaves a 10 min buffer under the 90-min
# CI job timeout.
export NEMOCLAW_E2E_DEFAULT_TIMEOUT=4800
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

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

# TODO(#2562): replace shell timeout with structured timeout once unified abstraction lands

# Per-phase timeout in seconds (20 min per onboard phase, generous for CI)
PHASE_TIMEOUT="${NEMOCLAW_E2E_PHASE_TIMEOUT:-1200}"

# Elapsed-time helpers
phase_start_time() { date +%s; }
phase_elapsed() {
  local start="$1"
  local now
  now="$(date +%s)"
  echo $((now - start))
}

# Diagnostic dump — called on phase timeout or failure to aid debugging
dump_diagnostics() {
  local phase_label="${1:-unknown}"
  info "=== Diagnostics for ${phase_label} ==="
  info "openshell status:"
  openshell status 2>&1 | sed 's/^/    /' || true
  info "openshell sandbox list:"
  openshell sandbox list 2>&1 | sed 's/^/    /' || true
  info "docker ps:"
  docker ps 2>&1 | sed 's/^/    /' || true
  info "=== End diagnostics ==="
}

registry_has() {
  local sandbox_name="$1"
  [ -f "$REGISTRY" ] && grep -q "$sandbox_name" "$REGISTRY"
}

wait_openshell_sandbox_absent() {
  local sandbox_name="$1"
  local timeout="${2:-60}"
  local deadline=$((SECONDS + timeout))
  local output status

  while [ "$SECONDS" -le "$deadline" ]; do
    output="$(openshell sandbox get "$sandbox_name" 2>&1)"
    status=$?
    if [ "$status" -ne 0 ] && grep -qiE 'NotFound|Not Found|sandbox not found' <<<"$output"; then
      return 0
    fi
    sleep 1
  done

  info "OpenShell still reports sandbox '$sandbox_name' after ${timeout}s:"
  printf '%s\n' "$output" | sed 's/^/    /'
  return 1
}

docker_driver_gateway_pid_file() {
  printf '%s/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.pid\n' "$HOME"
}

gateway_runtime_id() {
  local pid_file pid cid
  pid_file="$(docker_driver_gateway_pid_file)"
  if [ -f "$pid_file" ]; then
    pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      printf 'pid:%s\n' "$pid"
      return 0
    fi
  fi

  cid="$(docker ps -qf "name=openshell-cluster-nemoclaw" 2>/dev/null | head -1)"
  if [ -n "$cid" ]; then
    printf 'container:%s\n' "$cid"
    return 0
  fi

  return 1
}

gateway_alias_endpoint() {
  local scheme="https"
  if [ "$(uname -s)" = "Linux" ]; then
    scheme="http"
  fi
  printf '%s://127.0.0.1:%s\n' "$scheme" "${NEMOCLAW_GATEWAY_PORT:-8080}"
}

stop_gateway_runtime() {
  local pid_file pid cid
  openshell forward stop 18789 2>/dev/null || true
  openshell gateway stop -g nemoclaw 2>/dev/null || true

  pid_file="$(docker_driver_gateway_pid_file)"
  if [ -f "$pid_file" ]; then
    pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
  fi

  cid="$(docker ps -qf "name=openshell-cluster-nemoclaw" 2>/dev/null | head -1)"
  if [ -n "$cid" ]; then
    docker stop "$cid" >/dev/null 2>&1 || true
  fi
}

SANDBOX_A="e2e-double-a"
SANDBOX_B="e2e-double-b"
INSTALL_SANDBOX_NAME="${NEMOCLAW_E2E_INSTALL_SANDBOX_NAME:-}"
ALT_GATEWAY_NAME="e2e-double-alt"
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

# TODO(#2562): replace shell timeout with structured timeout once unified abstraction lands
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
    "NEMOCLAW_DASHBOARD_PORT="
    "CHAT_UI_URL="
  )
  if [ "$recreate" = "1" ]; then
    env_args+=("NEMOCLAW_RECREATE_SANDBOX=1")
  fi

  run_with_timeout "$PHASE_TIMEOUT" env "${env_args[@]}" "${NEMOCLAW_CMD[@]}" onboard --non-interactive >"$log_file" 2>&1
  RUN_ONBOARD_EXIT=$?
  RUN_ONBOARD_OUTPUT="$(cat "$log_file")"
  rm -f "$log_file"
}

run_nemoclaw() {
  "${NEMOCLAW_CMD[@]}" "$@"
}

stop_forward_if_set() {
  local port="${1:-}"
  if [ -n "$port" ]; then
    openshell forward stop "$port" 2>/dev/null || true
  fi
}

dashboard_port_from_list() {
  local sandbox_name="$1"

  LIST_OUTPUT="$list_output" python3 - "$sandbox_name" <<'PY'
import os
import re
import sys

target = sys.argv[1]
current = None

for line in os.environ.get("LIST_OUTPUT", "").splitlines():
    if line.startswith("    ") and not line.startswith("      "):
        stripped = line.strip()
        current = stripped.split()[0] if stripped else None
        continue

    if current == target:
        match = re.search(r"dashboard:\s+http://127\.0\.0\.1:(\d+)/?", line)
        if match:
            print(match.group(1))
            sys.exit(0)

sys.exit(1)
PY
}

gateway_name_from_output() {
  local output="$1"

  GATEWAY_OUTPUT="$output" python3 <<'PY'
import os
import re
import sys

clean = re.sub(r"\x1b\[[0-9;]*m", "", os.environ.get("GATEWAY_OUTPUT", ""))
match = re.search(r"^\s*Gateway:\s+([^\s]+)", clean, re.MULTILINE)
if match:
    print(match.group(1))
    sys.exit(0)
sys.exit(1)
PY
}

forward_owner_for_port() {
  local port="$1"

  FORWARD_OUTPUT="$forward_output" python3 - "$port" <<'PY'
import os
import re
import sys

target = sys.argv[1]
clean = re.sub(r"\x1b\[[0-9;]*m", "", os.environ.get("FORWARD_OUTPUT", ""))

for line in clean.splitlines():
    parts = line.strip().split()
    if len(parts) < 5 or parts[0].lower() == "sandbox":
        continue
    status = " ".join(parts[4:]).lower()
    if parts[2] == target and "running" in status:
        print(parts[0])
        sys.exit(0)

sys.exit(1)
PY
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Pre-cleanup"
info "Destroying any leftover test sandboxes/gateway from previous runs..."
if [ -x "$REPO_ROOT/bin/nemoclaw.js" ] || command -v nemoclaw >/dev/null 2>&1; then
  if [ -n "$INSTALL_SANDBOX_NAME" ]; then
    run_nemoclaw "$INSTALL_SANDBOX_NAME" destroy --yes 2>/dev/null || true
  fi
  run_nemoclaw "$SANDBOX_A" destroy --yes 2>/dev/null || true
  run_nemoclaw "$SANDBOX_B" destroy --yes 2>/dev/null || true
fi
if [ -n "$INSTALL_SANDBOX_NAME" ]; then
  openshell sandbox delete "$INSTALL_SANDBOX_NAME" 2>/dev/null || true
fi
openshell sandbox delete "$SANDBOX_A" 2>/dev/null || true
openshell sandbox delete "$SANDBOX_B" 2>/dev/null || true
stop_gateway_runtime
openshell gateway destroy -g nemoclaw 2>/dev/null || true
openshell gateway destroy -g "$ALT_GATEWAY_NAME" 2>/dev/null || true
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

PHASE2_START="$(phase_start_time)"
run_onboard "$SANDBOX_A"
output1="$RUN_ONBOARD_OUTPUT"
exit1="$RUN_ONBOARD_EXIT"
info "Phase 2 elapsed: $(phase_elapsed "$PHASE2_START")s"

if [ "$exit1" -eq 0 ]; then
  pass "First onboard completed successfully"
elif [ "$exit1" -eq 124 ]; then
  fail "First onboard timed out after ${PHASE_TIMEOUT}s (exit 124)"
  dump_diagnostics "Phase 2"
else
  fail "First onboard exited $exit1 (expected 0)"
  dump_diagnostics "Phase 2"
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

GATEWAY_ID_BEFORE=$(gateway_runtime_id || true)
PHASE3_START="$(phase_start_time)"
run_onboard "$SANDBOX_A" "1"
output2="$RUN_ONBOARD_OUTPUT"
exit2="$RUN_ONBOARD_EXIT"
info "Phase 3 elapsed: $(phase_elapsed "$PHASE3_START")s"

if [ "$exit2" -eq 0 ]; then
  pass "Second onboard completed successfully"
elif [ "$exit2" -eq 124 ]; then
  fail "Second onboard timed out after ${PHASE_TIMEOUT}s (exit 124)"
  dump_diagnostics "Phase 3"
else
  fail "Second onboard exited $exit2 (expected 0)"
  dump_diagnostics "Phase 3"
fi

GATEWAY_ID_AFTER=$(gateway_runtime_id || true)
if [ -n "$GATEWAY_ID_BEFORE" ] && [ "$GATEWAY_ID_BEFORE" = "$GATEWAY_ID_AFTER" ]; then
  pass "Healthy gateway runtime reused on second onboard ($GATEWAY_ID_BEFORE)"
else
  fail "Gateway runtime changed on second onboard (before=$GATEWAY_ID_BEFORE after=$GATEWAY_ID_AFTER)"
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

ALT_GATEWAY_ENDPOINT="$(gateway_alias_endpoint)"
alt_gateway_add_output="$(openshell gateway add --local --name "$ALT_GATEWAY_NAME" "$ALT_GATEWAY_ENDPOINT" 2>&1 || true)"
if openshell gateway select "$ALT_GATEWAY_NAME" >/dev/null 2>&1; then
  selected_gateway_output="$(
    openshell status 2>&1 || true
    openshell gateway info 2>&1 || true
  )"
  selected_gateway="$(gateway_name_from_output "$selected_gateway_output" 2>/dev/null || true)"
  if [ "$selected_gateway" = "$ALT_GATEWAY_NAME" ]; then
    pass "Alternate gateway alias selected before third onboard"
  else
    fail "Alternate gateway alias was not selected before third onboard (selected=${selected_gateway:-unknown})"
  fi
else
  fail "Could not select alternate gateway alias before third onboard (add output=${alt_gateway_add_output:-empty})"
fi

GATEWAY_ID_BEFORE3=$(gateway_runtime_id || true)
PHASE4_START="$(phase_start_time)"
run_onboard "$SANDBOX_B"
output3="$RUN_ONBOARD_OUTPUT"
exit3="$RUN_ONBOARD_EXIT"
info "Phase 4 elapsed: $(phase_elapsed "$PHASE4_START")s"

if [ "$exit3" -eq 0 ]; then
  pass "Third onboard completed successfully"
elif [ "$exit3" -eq 124 ]; then
  fail "Third onboard timed out after ${PHASE_TIMEOUT}s (exit 124)"
  dump_diagnostics "Phase 4"
else
  fail "Third onboard exited $exit3 (expected 0)"
  dump_diagnostics "Phase 4"
fi

GATEWAY_ID_AFTER3=$(gateway_runtime_id || true)
if [ -n "$GATEWAY_ID_BEFORE3" ] && [ "$GATEWAY_ID_BEFORE3" = "$GATEWAY_ID_AFTER3" ]; then
  pass "Healthy gateway runtime reused on third onboard ($GATEWAY_ID_BEFORE3)"
else
  fail "Gateway runtime changed on third onboard (before=$GATEWAY_ID_BEFORE3 after=$GATEWAY_ID_AFTER3)"
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

selected_gateway_output="$(
  openshell status 2>&1 || true
  openshell gateway info 2>&1 || true
)"
selected_gateway="$(gateway_name_from_output "$selected_gateway_output" 2>/dev/null || true)"
if [ "$selected_gateway" = "nemoclaw" ]; then
  pass "Named gateway reselected during third onboard"
else
  fail "Named gateway was not reselected during third onboard (selected=${selected_gateway:-unknown})"
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

# #2174 regression: B must auto-allocate to a different dashboard port,
# surface it in nemoclaw list, and not collide with A's dashboard.
if grep -q "is taken. Using port" <<<"$output3"; then
  info "Second-sandbox onboard logged port auto-allocation (#2174)"
else
  info "Second-sandbox onboard did not emit the optional auto-allocation warning; verifying assigned ports directly."
fi

LIST_LOG="$(mktemp)"
run_nemoclaw list >"$LIST_LOG" 2>&1 || true
list_output="$(cat "$LIST_LOG")"
rm -f "$LIST_LOG"

port_a="$(dashboard_port_from_list "$SANDBOX_A" 2>/dev/null || true)"
port_b="$(dashboard_port_from_list "$SANDBOX_B" 2>/dev/null || true)"

if [ -n "$port_a" ] && [ -n "$port_b" ]; then
  pass "nemoclaw list shows dashboard ports for both test sandboxes (#2174)"
else
  fail "nemoclaw list did not show dashboard ports for both test sandboxes (a=${port_a:-missing} b=${port_b:-missing})"
  info "Observed nemoclaw list output:"
  printf '%s\n' "$list_output" | sed 's/^/    /'
fi

if [ -n "$port_a" ] && [ -n "$port_b" ] && [ "$port_a" != "$port_b" ]; then
  pass "nemoclaw list shows distinct dashboard ports for test sandboxes (#2174)"
else
  fail "test sandboxes did not have distinct dashboard ports (#2174): ${SANDBOX_A}=${port_a:-missing} ${SANDBOX_B}=${port_b:-missing}"
fi

if [ -n "$port_a" ] && [ -n "$port_b" ] && [ "$port_a" != "$port_b" ]; then
  info "Stopping '$SANDBOX_B' dashboard forward to verify stored-port recovery..."
  openshell forward stop "$port_b" 2>/dev/null || true

  PROBE_LOG="$(mktemp)"
  run_nemoclaw "$SANDBOX_B" connect --probe-only >"$PROBE_LOG" 2>&1
  probe_exit=$?
  probe_output="$(cat "$PROBE_LOG")"
  rm -f "$PROBE_LOG"

  if [ "$probe_exit" -eq 0 ]; then
    pass "Probe-only connect recovered '$SANDBOX_B' dashboard forward"
  else
    fail "Probe-only connect exited $probe_exit after stopping '$SANDBOX_B' dashboard forward"
    info "Observed probe output:"
    printf '%s\n' "$probe_output" | sed 's/^/    /'
  fi

  forward_output="$(openshell forward list 2>&1 || true)"
  owner_a="$(forward_owner_for_port "$port_a" 2>/dev/null || true)"
  owner_b="$(forward_owner_for_port "$port_b" 2>/dev/null || true)"

  if [ "$owner_b" = "$SANDBOX_B" ]; then
    pass "Second sandbox dashboard forward restored on its recorded port"
  else
    fail "Second sandbox dashboard forward owner mismatch on port $port_b (owner=${owner_b:-missing})"
    info "Observed forward list:"
    printf '%s\n' "$forward_output" | sed 's/^/    /'
  fi

  if [ "$owner_a" = "$SANDBOX_A" ]; then
    pass "First sandbox dashboard forward kept its recorded port"
  else
    fail "First sandbox dashboard forward owner mismatch on port $port_a (owner=${owner_a:-missing})"
    info "Observed forward list:"
    printf '%s\n' "$forward_output" | sed 's/^/    /'
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Stale registry reconciliation
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Stale registry reconciliation"
info "Deleting '$SANDBOX_A' directly in OpenShell to leave a stale NemoClaw registry entry..."

openshell sandbox delete "$SANDBOX_A" 2>/dev/null || true
if wait_openshell_sandbox_absent "$SANDBOX_A" 60; then
  pass "OpenShell reports '$SANDBOX_A' absent after direct deletion"
else
  fail "OpenShell still reports '$SANDBOX_A' after direct deletion"
fi

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

if [ "$status_exit" -eq 1 ]; then
  pass "Stale sandbox status exited 1"
else
  fail "Stale sandbox status exited $status_exit (expected 1)"
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
stop_gateway_runtime

GATEWAY_LOG="$(mktemp)"
run_nemoclaw "$SANDBOX_B" status >"$GATEWAY_LOG" 2>&1
gateway_status_exit=$?
gateway_status_output="$(cat "$GATEWAY_LOG")"
rm -f "$GATEWAY_LOG"

if [ "$gateway_status_exit" -eq 0 ] || [ "$gateway_status_exit" -eq 1 ]; then
  pass "Post-stop status exited $gateway_status_exit"
else
  fail "Post-stop status exited $gateway_status_exit (expected 0 or 1)"
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
if [ -n "$INSTALL_SANDBOX_NAME" ]; then
  run_nemoclaw "$INSTALL_SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
openshell sandbox delete "$SANDBOX_A" 2>/dev/null || true
openshell sandbox delete "$SANDBOX_B" 2>/dev/null || true
if [ -n "$INSTALL_SANDBOX_NAME" ]; then
  openshell sandbox delete "$INSTALL_SANDBOX_NAME" 2>/dev/null || true
fi
stop_forward_if_set "${port_a:-}"
stop_forward_if_set "${port_b:-}"
openshell forward stop 18789 2>/dev/null || true
stop_gateway_runtime
openshell gateway destroy -g nemoclaw 2>/dev/null || true
openshell gateway destroy -g "$ALT_GATEWAY_NAME" 2>/dev/null || true

# Force registry reconciliation: when the gateway is in a degraded state
# (stopped in Phase 6), `nemoclaw destroy` may delete the sandbox from
# OpenShell but fail to clean its own registry entry. Running `status` for
# each sandbox triggers the stale-entry reconciliation path.
run_nemoclaw "$SANDBOX_A" status 2>/dev/null || true
run_nemoclaw "$SANDBOX_B" status 2>/dev/null || true

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
