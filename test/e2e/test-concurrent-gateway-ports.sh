#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Concurrent gateway ports — exercises multiple NemoClaw-managed sandboxes on a
# single host with fully segregated gateways, dashboards, and registries. A
# second onboard with NEMOCLAW_GATEWAY_PORT set to a non-default port must not
# touch the first sandbox's gateway process, dashboard SSH forward, or sandbox
# container.
#
# Scenario shape:
#   1. Onboard sandbox A on the default gateway port (8080) + default dashboard
#      port (18789).
#   2. Onboard sandbox B with NEMOCLAW_GATEWAY_PORT set to a non-default port
#      that drives the per-port binding path. The dashboard port should
#      auto-allocate from the 18789-18799 range without colliding with A.
#   3. Verify both sandboxes coexist: distinct gateways, distinct dashboards,
#      distinct sandbox containers, no SIGKILL of A during B's onboard, and
#      nemoclaw list reports two entries with two distinct dashboard URLs.
#   4. Destroy B and verify A remains healthy.
#
# This script intentionally uses a local fake OpenAI-compatible endpoint so it
# does not depend on real NVIDIA endpoints, matching the pattern in
# test-double-onboard.sh.

# ShellCheck cannot see EXIT trap invocations of cleanup helpers in this E2E script.
# shellcheck disable=SC2317
set -uo pipefail

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

PHASE_TIMEOUT="${NEMOCLAW_E2E_PHASE_TIMEOUT:-1200}"

SANDBOX_A="e2e-cgp-a"
SANDBOX_B="e2e-cgp-b"
GATEWAY_PORT_A=8080
GATEWAY_PORT_B="${NEMOCLAW_E2E_GATEWAY_PORT_B:-18080}"
DASHBOARD_PORT_A=18789

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FAKE_HOST="127.0.0.1"
FAKE_PORT="${NEMOCLAW_E2E_FAKE_PORT:-18180}"
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
      info "Fake OpenAI server up on ${FAKE_BASE_URL} (pid ${FAKE_PID})"
      return 0
    fi
    sleep 1
  done

  fail "Fake OpenAI server did not become ready on ${FAKE_BASE_URL}; see ${FAKE_LOG}"
  cat "$FAKE_LOG"
  exit 1
}

dashboard_port_from_list() {
  local sandbox="$1"
  "${NEMOCLAW_CMD[@]}" list 2>/dev/null \
    | awk -v want="${sandbox}" '
        /^[[:space:]]+[A-Za-z0-9_-]+( \*)?[[:space:]]*$/ {
          name=$1
          inblock=(name == want) ? 1 : 0
          next
        }
        inblock && /dashboard:[[:space:]]*http:\/\/[0-9.]+:[0-9]+/ {
          match($0, /:[0-9]+/)
          print substr($0, RSTART+1, RLENGTH-1)
          exit
        }
      '
}

dump_diagnostics() {
  local label="${1:-unknown}"
  info "=== Diagnostics for ${label} ==="
  info "nemoclaw list:"
  "${NEMOCLAW_CMD[@]}" list 2>&1 | sed 's/^/    /' || true
  info "openshell sandbox list:"
  openshell sandbox list 2>&1 | sed 's/^/    /' || true
  info "openshell forward list:"
  openshell forward list 2>&1 | sed 's/^/    /' || true
  info "docker ps -a:"
  docker ps -a --format 'table {{.Names}}\t{{.Status}}' 2>&1 | sed 's/^/    /' || true
  info "ss -ltn (gateway/dashboard ports):"
  ss -ltn 2>&1 | grep -E ":(${GATEWAY_PORT_A}|${GATEWAY_PORT_B}|1878[0-9]|1879[0-9])" | sed 's/^/    /' || true
}

onboard_sandbox() {
  local name="$1"
  local gateway_port="$2"
  local label="onboard-${name}"
  local start_time
  start_time="$(date +%s)"
  info "Starting onboard of '${name}' with NEMOCLAW_GATEWAY_PORT=${gateway_port}"
  if COMPATIBLE_API_KEY=dummy \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_PROVIDER=custom \
    NEMOCLAW_ENDPOINT_URL="${FAKE_BASE_URL}" \
    NEMOCLAW_MODEL=test-model \
    NEMOCLAW_POLICY_MODE=skip \
    NEMOCLAW_DASHBOARD_PORT='' \
    CHAT_UI_URL='' \
    NEMOCLAW_GATEWAY_PORT="${gateway_port}" \
    NEMOCLAW_SANDBOX_NAME="${name}" \
    timeout "${PHASE_TIMEOUT}" "${NEMOCLAW_CMD[@]}" onboard --non-interactive \
    >"/tmp/${name}-onboard.log" 2>&1; then
    local elapsed
    elapsed=$(($(date +%s) - start_time))
    pass "${label} completed in ${elapsed}s"
    return 0
  fi
  fail "${label} did not complete within ${PHASE_TIMEOUT}s"
  dump_diagnostics "${label}"
  tail -200 "/tmp/${name}-onboard.log" | sed 's/^/    /'
  return 1
}

destroy_default_install_sandbox() {
  local default_name
  default_name="$("${NEMOCLAW_CMD[@]}" list 2>/dev/null \
    | grep -E '^[[:space:]]+[a-zA-Z0-9_-]+ \*' \
    | awk '{print $1}' \
    | head -1 || true)"
  if [ -z "${default_name}" ]; then
    info "no pre-existing default sandbox to destroy"
    return 0
  fi
  if [ "${default_name}" = "${SANDBOX_A}" ] || [ "${default_name}" = "${SANDBOX_B}" ]; then
    info "default sandbox is one under test (${default_name}); skipping pre-destroy"
    return 0
  fi
  info "destroying pre-existing default sandbox '${default_name}' (created by install.sh)"
  if NEMOCLAW_NON_INTERACTIVE=1 timeout 300 "${NEMOCLAW_CMD[@]}" "${default_name}" destroy --yes \
    >"/tmp/${default_name}-predestroy.log" 2>&1; then
    pass "pre-existing default sandbox '${default_name}' destroyed"
  else
    fail "could not destroy pre-existing default sandbox '${default_name}'"
    tail -100 "/tmp/${default_name}-predestroy.log" | sed 's/^/    /'
    return 1
  fi
}

gateway_name_for_port() {
  local port="$1"
  if [ "${port}" = "8080" ]; then
    echo "nemoclaw"
  else
    echo "nemoclaw-${port}"
  fi
}

sandbox_phase() {
  local name="$1"
  local gateway="${2:-}"
  local args=("sandbox" "list")
  if [ -n "${gateway}" ]; then
    args+=("-g" "${gateway}")
  fi
  openshell "${args[@]}" 2>/dev/null \
    | sed 's/\x1b\[[0-9;]*m//g' \
    | awk -v want="${name}" '$1 == want { print $NF; exit }'
}

verify_sandbox_alive() {
  local name="$1"
  local label="${2:-${name} alive}"
  local gateway="${3:-}"
  local retries="${4:-12}"
  local phase=""
  for _ in $(seq 1 "${retries}"); do
    phase="$(sandbox_phase "${name}" "${gateway}")"
    case "${phase}" in
      Ready | Running)
        pass "${label} (phase=${phase})"
        return 0
        ;;
      Error | Failed | CrashLoopBackOff)
        fail "${label} terminal (phase='${phase}')"
        return 1
        ;;
    esac
    sleep 5
  done
  fail "${label} did not reach Ready/Running within ${retries} polls (last phase='${phase:-missing}')"
  return 1
}

# === Scenario ===

section "Stage 0: prepare fake inference endpoint"
start_fake_openai

section "Stage 0.5: destroy default sandbox created by install.sh (if any)"
destroy_default_install_sandbox || exit 1

section "Stage 1: onboard sandbox A on default gateway port (${GATEWAY_PORT_A})"
GATEWAY_A_NAME="$(gateway_name_for_port "${GATEWAY_PORT_A}")"
GATEWAY_B_NAME="$(gateway_name_for_port "${GATEWAY_PORT_B}")"
onboard_sandbox "${SANDBOX_A}" "${GATEWAY_PORT_A}" || exit 1
verify_sandbox_alive "${SANDBOX_A}" "Sandbox A reaches Ready/Running on default port" "${GATEWAY_A_NAME}"

DASHBOARD_A="$(dashboard_port_from_list "${SANDBOX_A}")"
if [ -n "${DASHBOARD_A}" ] && [ "${DASHBOARD_A}" = "${DASHBOARD_PORT_A}" ]; then
  pass "Sandbox A holds default dashboard port ${DASHBOARD_PORT_A}"
else
  fail "Sandbox A dashboard port is '${DASHBOARD_A:-missing}', expected ${DASHBOARD_PORT_A}"
fi

section "Stage 2: onboard sandbox B with NEMOCLAW_GATEWAY_PORT=${GATEWAY_PORT_B}"
onboard_sandbox "${SANDBOX_B}" "${GATEWAY_PORT_B}" || {
  info "B onboard failed; capturing pre-fail state of A for diagnostics"
  dump_diagnostics "stage-2-onboard-B"
  exit 1
}

section "Stage 3: assert both sandboxes coexist"
verify_sandbox_alive "${SANDBOX_A}" "Sandbox A still alive after B's onboard" "${GATEWAY_A_NAME}"
verify_sandbox_alive "${SANDBOX_B}" "Sandbox B reaches Ready/Running on per-port gateway" "${GATEWAY_B_NAME}"

DASHBOARD_B="$(dashboard_port_from_list "${SANDBOX_B}")"
if [ -n "${DASHBOARD_B}" ] && [ "${DASHBOARD_B}" != "${DASHBOARD_A:-${DASHBOARD_PORT_A}}" ]; then
  pass "Sandbox B got a distinct dashboard port (A=${DASHBOARD_A:-missing} B=${DASHBOARD_B})"
else
  fail "Sandbox B dashboard port collides with A: A=${DASHBOARD_A:-missing} B=${DASHBOARD_B:-missing}"
  dump_diagnostics "dashboard-port-collision"
fi

if ss -ltn 2>/dev/null | grep -qE ":${GATEWAY_PORT_A}\\b"; then
  pass "Sandbox A gateway port ${GATEWAY_PORT_A} still listening"
else
  fail "Sandbox A gateway port ${GATEWAY_PORT_A} no longer listening — recreate destroyed first gateway"
  dump_diagnostics "gateway-port-A-missing"
fi

if ss -ltn 2>/dev/null | grep -qE ":${GATEWAY_PORT_B}\\b"; then
  pass "Sandbox B gateway port ${GATEWAY_PORT_B} listening"
else
  fail "Sandbox B gateway port ${GATEWAY_PORT_B} not listening"
  dump_diagnostics "gateway-port-B-missing"
fi

LIST_OUTPUT="$("${NEMOCLAW_CMD[@]}" list 2>&1 || true)"
if echo "${LIST_OUTPUT}" | grep -qE "^[[:space:]]+${SANDBOX_A}( \*)?[[:space:]]*$" \
  && echo "${LIST_OUTPUT}" | grep -qE "^[[:space:]]+${SANDBOX_B}( \*)?[[:space:]]*$"; then
  pass "nemoclaw list shows both sandbox A and B"
else
  fail "nemoclaw list missing one of A/B"
  # shellcheck disable=SC2001
  echo "${LIST_OUTPUT}" | sed 's/^/    /'
fi

section "Stage 4: destroy sandbox B; assert sandbox A still healthy"
if NEMOCLAW_NON_INTERACTIVE=1 timeout 300 "${NEMOCLAW_CMD[@]}" "${SANDBOX_B}" destroy --yes \
  >"/tmp/${SANDBOX_B}-destroy.log" 2>&1; then
  pass "Sandbox B destroyed"
else
  fail "Sandbox B destroy timed out or failed"
  tail -100 "/tmp/${SANDBOX_B}-destroy.log" | sed 's/^/    /'
fi
verify_sandbox_alive "${SANDBOX_A}" "Sandbox A still alive after B's destroy" "${GATEWAY_A_NAME}"

section "Summary: PASS=${PASS} FAIL=${FAIL} TOTAL=${TOTAL}"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
exit 0
