#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Long-running e2e regression for NVIDIA/NemoClaw#2478 — gateway crash-loop
# recovery when a sandboxed library throws on init.
#
#   STAYS_IN_PR_UNTIL_SHIP — delete this file before merging the fix once
#   the soak has produced a clean run on a real DGX Spark / Brev instance.
#   Tracking removal in the PR description, not here, so the file does not
#   silently outlive the issue it was written for.
#
# What this test exercises (the fix from #2478):
#
#   The sandbox ships a chain of NODE_OPTIONS=--require preloads (sandbox
#   safety-net, ciao networkInterfaces guard, slack guard, http-proxy fix,
#   ws-proxy fix, nemotron fix). They are emitted into
#   /tmp/nemoclaw-proxy-env.sh at sandbox-start and reach the gateway via
#   ~/.bashrc on the FIRST start. Before #2478 the gateway recovery path
#   (laptop sleep, health-monitor restart, manual `nemoclaw <name> connect`)
#   silently swallowed sourcing errors with `2>/dev/null` and never asserted
#   that NODE_OPTIONS actually contained the guards. A stale or missing
#   proxy-env.sh therefore left the respawned gateway naked, and any library
#   that threw during init (ciao mDNS being the trigger documented in the
#   issue) crashed the gateway in a loop forever.
#
# This test:
#
#   1. Onboards a sandbox normally.
#   2. Verifies the *initial* gateway has the safety-net + ciao guard active
#      (via /proc/<pid>/environ on the gateway PID).
#   3. Crash-recovery loop (NORMAL): kill the gateway 5x, each time triggers
#      `nemoclaw <name> connect --probe-only` (which calls
#      recoverSandboxProcesses), and checks the respawned gateway still has
#      guards in NODE_OPTIONS.
#   4. Negative case: removes /tmp/nemoclaw-proxy-env.sh, kills the gateway,
#      triggers recovery — expects the new "[gateway-recovery] WARNING"
#      line in gateway.log instead of silent guard loss.
#   5. Soak: leaves the sandbox idle for $NEMOCLAW_E2E_SOAK_SECONDS
#      (default 300) so the health-monitor restart cadence (~4 min in prod)
#      gets at least one chance to fire, then asserts the gateway has not
#      crash-looped in the meantime (PID stable OR exactly one clean
#      respawn, no churn).
#
# Prerequisites:
#   - Docker running
#   - python3 + curl for the local OpenAI-compatible mock endpoint
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NEMOCLAW_E2E_USE_COMPAT_MOCK           — use local mock provider (default: 1)
#   NEMOCLAW_COMPAT_MOCK_PORT              — local mock endpoint port (default: 18191)
#   NEMOCLAW_COMPAT_MODEL                  — local mock model id (default: test-model)
#   NEMOCLAW_COMPAT_MOCK_LOG               — local mock server log path
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-2478)
#   NEMOCLAW_E2E_INSTALL_LOG               — install log path for CI artifacts
#   NEMOCLAW_E2E_TIMEOUT_SECONDS           — overall timeout (default: 1500)
#   NEMOCLAW_E2E_CRASH_CYCLES              — crash-recover cycles (default: 5)
#   NEMOCLAW_E2E_SOAK_SECONDS              — idle soak window (default: 300)
#   NVIDIA_API_KEY                         — required only with NEMOCLAW_E2E_USE_COMPAT_MOCK=0
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 \
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     bash test/e2e/test-issue-2478-crash-loop-recovery.sh

# ShellCheck cannot see EXIT trap invocations of cleanup helpers in this E2E script.
# shellcheck disable=SC2317,SC2329
set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1500
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-2478}"
CRASH_CYCLES="${NEMOCLAW_E2E_CRASH_CYCLES:-5}"
SOAK_SECONDS="${NEMOCLAW_E2E_SOAK_SECONDS:-300}"
DASHBOARD_PORT="${NEMOCLAW_DASHBOARD_PORT:-18789}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
USE_COMPAT_MOCK="${NEMOCLAW_E2E_USE_COMPAT_MOCK:-1}"
COMPAT_MOCK_PORT="${NEMOCLAW_COMPAT_MOCK_PORT:-18191}"
COMPAT_MODEL="${NEMOCLAW_COMPAT_MODEL:-test-model}"
COMPATIBLE_KEY="${COMPATIBLE_API_KEY:-nemoclaw-e2e-compatible-key}"
COMPAT_MOCK_LOG="${NEMOCLAW_COMPAT_MOCK_LOG:-/tmp/nemoclaw-2478-compatible-endpoint.log}"
COMPAT_MOCK_PID=""

# ── Helpers ──────────────────────────────────────────────────────

host_ip_for_sandbox() {
  local ip_addr
  if command -v ip >/dev/null 2>&1; then
    ip_addr="$(ip route get 1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
    if [ -n "$ip_addr" ]; then
      echo "$ip_addr"
      return
    fi
  fi
  if command -v hostname >/dev/null 2>&1; then
    for ip_addr in $(hostname -I 2>/dev/null); do
      case "$ip_addr" in
        127.* | ::1) ;;
        *)
          echo "$ip_addr"
          return
          ;;
      esac
    done
  fi
  echo "127.0.0.1"
}

stop_compat_mock() {
  if [ -n "${COMPAT_MOCK_PID:-}" ] && kill -0 "$COMPAT_MOCK_PID" 2>/dev/null; then
    kill "$COMPAT_MOCK_PID" 2>/dev/null || true
    wait "$COMPAT_MOCK_PID" 2>/dev/null || true
  fi
  COMPAT_MOCK_PID=""
}
trap stop_compat_mock EXIT

start_compat_mock() {
  : >"$COMPAT_MOCK_LOG"
  python3 - "$COMPAT_MOCK_PORT" "$COMPAT_MODEL" "$COMPATIBLE_KEY" >"$COMPAT_MOCK_LOG" 2>&1 <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[1])
model = sys.argv[2]
api_key = sys.argv[3]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _path(self):
        return self.path.split("?", 1)[0]

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_chat_sse(self, content):
        chunk = json.dumps({
            "id": "chatcmpl-2478-mock",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}],
        })
        done_chunk = json.dumps({
            "id": "chatcmpl-2478-mock",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        })
        body = ("data: %s\n\ndata: %s\n\ndata: [DONE]\n\n" % (chunk, done_chunk)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        return self.headers.get("Authorization", "") == "Bearer " + api_key

    def do_GET(self):
        if self._path() in ("/v1/models", "/models"):
            print("GET %s" % self._path(), flush=True)
            self._send(200, {"object": "list", "data": [{"id": model, "object": "model"}]})
            return
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {}

        if self._path() in ("/v1/chat/completions", "/chat/completions"):
            print(
                "POST %s auth=%s model=%s stream=%s"
                % (self._path(), "ok" if self._auth_ok() else "missing", payload.get("model"), payload.get("stream")),
                flush=True,
            )
            if not self._auth_ok():
                self._send(401, {"error": {"message": "missing bearer credential"}})
                return
            if payload.get("stream"):
                self._send_chat_sse("PONG from issue-2478 mock")
                return
            self._send(200, {
                "id": "chatcmpl-2478-mock",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "PONG from issue-2478 mock"},
                    "finish_reason": "stop",
                }],
            })
            return

        if self._path() in ("/v1/responses", "/responses"):
            print(
                "POST %s auth=%s stream=%s"
                % (self._path(), "ok" if self._auth_ok() else "missing", payload.get("stream")),
                flush=True,
            )
            if not self._auth_ok():
                self._send(401, {"error": {"message": "missing bearer credential"}})
                return
            self._send(200, {
                "id": "resp-2478-mock",
                "object": "response",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "PONG from issue-2478 mock"}],
                }],
            })
            return

        self._send(404, {"error": {"message": "not found"}})


ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
PY
  COMPAT_MOCK_PID=$!

  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${COMPAT_MOCK_PORT}/v1/models" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Run a command inside the sandbox via openshell sandbox exec. Returns
# stdout; non-zero exit prints stderr but does not abort the test.
sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- "$@" 2>&1
}

# Get the current OpenClaw gateway PID inside the sandbox, or empty string.
# OpenClaw v0.0.44/2026.5.18 can show the long-running process as plain
# `openclaw` rather than the older `openclaw-gateway` argv. Match the process
# table directly so readiness does not depend on the legacy rename.
gateway_pid() {
  local out
  # shellcheck disable=SC2016 # Single-quoted body runs inside the sandbox shell.
  out="$(sandbox_exec sh -c 'pid="$(ps -eo pid=,comm=,args= 2>/dev/null | awk '\''($2 == "openclaw" && $0 ~ /gateway/) || $0 ~ /openclaw[ -]gateway/ { print $1 }'\'' | sort -n | head -n 1)"; if [ -z "$pid" ]; then pid="$(ps -eo pid=,comm=,args= 2>/dev/null | awk '\''$2 == "openclaw" { print $1 }'\'' | sort -n | head -n 1)"; fi; printf "%s\n" "$pid"')"
  printf '%s\n' "$out" | awk '/^[0-9]+$/ { print; exit }'
}

# Read /tmp/nemoclaw-proxy-env.sh — the single source of truth for the
# NODE_OPTIONS guard chain that the recovery script sources before
# launching the gateway. Owned root:root 444, readable by sandbox user.
proxy_env_contents() {
  sandbox_exec sh -c "cat /tmp/nemoclaw-proxy-env.sh 2>/dev/null"
}

gateway_log_line_count() {
  sandbox_exec sh -c "wc -l < /tmp/gateway.log 2>/dev/null || printf '0\n'" \
    | awk '/^[0-9]+$/ { print; found=1; exit } END { if (!found) print 0 }'
}

gateway_log_marker() {
  local label="$1"
  local marker
  marker="NEMOCLAW_E2E_LOG_MARKER_${label}_$(date +%s)_$$"
  if sandbox_exec sh -c "printf '%s\n' '$marker' >> /tmp/gateway.log 2>/dev/null && grep -Fq '$marker' /tmp/gateway.log 2>/dev/null" >/dev/null; then
    printf '%s\n' "$marker"
    return
  fi
  gateway_log_line_count
}

gateway_log_after_boundary() {
  local boundary="${1:-0}"
  if [[ "$boundary" =~ ^[0-9]+$ ]]; then
    local current_lines
    current_lines="$(gateway_log_line_count)"
    if [ "$current_lines" -lt "$boundary" ]; then
      boundary=0
    fi
    sandbox_exec sh -c "cat /tmp/gateway.log 2>/dev/null" | tail -n +"$((boundary + 1))"
    return
  fi

  local out status
  out="$(sandbox_exec sh -c "awk -v marker='$boundary' 'found { print } index(\$0, marker) { found=1; next } END { if (!found) exit 42 }' /tmp/gateway.log 2>/dev/null")"
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '%s\n' "$out"
    return
  fi

  # If the gateway rewrote or rotated /tmp/gateway.log, the marker is gone and
  # the whole current file is fresh relative to the boundary.
  sandbox_exec sh -c "cat /tmp/gateway.log 2>/dev/null"
}

# Returns 0 if the gateway has the library guard chain active, 1 otherwise.
# /proc/<pid>/environ is unreadable across non-ancestor process trees due
# to kernel.yama.ptrace_scope=1, so we verify the guards by their effects:
#   1. proxy-env.sh contains the safety-net + ciao preload exports (the
#      recovery script will pick these up on the next respawn).
#   2. gateway.log contains deterministic gateway-process preload markers
#      from the safety-net and ciao guards. Older builds also emitted
#      `[guard] os.networkInterfaces() failed:` when ciao happened to touch
#      os.networkInterfaces(), but that library call is not a stable
#      post-respawn oracle.
#   3. The gateway PID is alive after the guard activations (proves the
#      guard prevented a crash, which is the whole point).
# Waits up to $2 seconds (default 30) for log signatures to accrue.
gateway_guards_active() {
  local pid="$1"
  local timeout="${2:-30}"
  local log_boundary="${3:-0}"
  local elapsed=0

  if [ -z "$pid" ]; then
    return 1
  fi

  local env_contents
  env_contents="$(proxy_env_contents)"
  if ! echo "$env_contents" | grep -q 'nemoclaw-sandbox-safety-net'; then
    echo "  [guards] proxy-env.sh missing safety-net export"
    return 1
  fi
  if ! echo "$env_contents" | grep -q 'nemoclaw-ciao-network-guard'; then
    echo "  [guards] proxy-env.sh missing ciao-network-guard export"
    return 1
  fi

  while [ "$elapsed" -lt "$timeout" ]; do
    if gateway_log_after_boundary "$log_boundary" | grep -Eq '\[sandbox-safety-net\] loaded \((openclaw-gateway|launcher)\)' \
      && gateway_log_after_boundary "$log_boundary" | grep -Eq '\[guard\] ciao-network-guard loaded \((openclaw-gateway|launcher)\)'; then
      # Confirm gateway is still alive after guard activations.
      if [ -n "$(gateway_pid)" ]; then
        return 0
      fi
      echo "  [guards] guard fired but gateway no longer running"
      return 1
    fi
    # Backward-compatible proof for older images: this line is emitted by
    # the ciao preload only when ciao calls os.networkInterfaces().
    if gateway_log_after_boundary "$log_boundary" | grep -Fq '[guard] os.networkInterfaces() failed:'; then
      if [ -n "$(gateway_pid)" ]; then
        return 0
      fi
      echo "  [guards] guard fired but gateway no longer running"
      return 1
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done

  echo "  [guards] no fresh gateway-process guard activation signatures in gateway.log within ${timeout}s"
  return 1
}

# Tail gateway.log from inside the sandbox (last N lines).
gateway_log_tail() {
  sandbox_exec sh -c "tail -n ${1:-50} /tmp/gateway.log 2>/dev/null"
}

# Verify the gateway is actually serving its inference API, not just alive
# as a process. A NemoClaw user reported on #2478 that pre-fix the ciao
# crash left `https://inference.local/v1/models` returning empty — i.e.
# their deployed model "disappeared" from the user's perspective. This
# helper closes that loop so we prove the recovery preserves the
# user-visible service surface, not just the OS process. Polls up to $1
# seconds (default 30) since the new gateway needs ~1-3s to bind after
# launch.
gateway_serves_inference() {
  local timeout="${1:-30}"
  local elapsed=0
  local out=""
  while [ "$elapsed" -lt "$timeout" ]; do
    out="$(sandbox_exec sh -c 'curl -sf --max-time 5 https://inference.local/v1/models 2>/dev/null')"
    # OpenAI-compatible /v1/models response — top-level "data" array, plus
    # entries with "object" or "id". Match any of the three to be tolerant
    # of provider-specific shapes (NVIDIA Endpoints vs. local Ollama).
    case "$out" in
      *'"data"'* | *'"object"'* | *'"id"'*) return 0 ;;
    esac
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "  [inference] /v1/models did not return a usable response within ${timeout}s"
  echo "  [inference] last response: ${out:0:200}"
  return 1
}

# Dump diagnostic snapshot for triage when an environ read or guard
# assertion fails. Helps distinguish wrong-PID matching, gateway-not-running,
# and cross-namespace /proc visibility issues.
gateway_diagnostics() {
  local pid="${1:-}"
  echo "  --- gateway diagnostics ---"
  echo "  [exec context: whoami / hostname / pwd / pid namespace]"
  # shellcheck disable=SC2016  # intentional: expand inside sandbox, not host
  sandbox_exec sh -c 'echo "user=$(whoami) host=$(hostname) pwd=$(pwd) pid_ns=$(readlink /proc/self/ns/pid 2>/dev/null)"' | sed 's/^/    /'
  echo "  [pgrep -af '[o]penclaw' (any openclaw process)]"
  sandbox_exec sh -c "pgrep -af '[o]penclaw' || echo '(no matches)'" | sed 's/^/    /'
  echo "  [ps auxf (full tree, top 40 lines)]"
  sandbox_exec sh -c "ps auxf 2>/dev/null | head -40 || ps -ef 2>/dev/null | head -40" | sed 's/^/    /'
  echo "  [ls /tmp (gateway.log presence + size)]"
  sandbox_exec sh -c "ls -la /tmp/gateway.log /tmp/auto-pair.log /tmp/openclaw-* 2>&1 | head -20" | sed 's/^/    /'
  echo "  [tail /tmp/gateway.log -n 60]"
  sandbox_exec sh -c "tail -n 60 /tmp/gateway.log 2>&1 || echo '(no gateway.log)'" | sed 's/^/    /'
  echo "  [nemoclaw status]"
  nemoclaw "$SANDBOX_NAME" status 2>&1 | head -30 | sed 's/^/    /'
  echo "  [openshell sandbox list]"
  openshell sandbox list 2>&1 | head -20 | sed 's/^/    /' || true
  if [ -n "$pid" ]; then
    echo "  [reported pid: $pid]"
    echo "  [/proc/${pid} listing]"
    sandbox_exec sh -c "ls -la /proc/${pid}/ 2>&1 | head -8 || echo '(cannot list)'" | sed 's/^/    /'
    echo "  [/proc/${pid}/cmdline]"
    sandbox_exec sh -c "cat /proc/${pid}/cmdline 2>&1 | tr '\\0' ' '; echo" | sed 's/^/    /'
    echo "  [/proc/${pid}/status (uid/state)]"
    sandbox_exec sh -c "grep -E '^(Name|State|Uid|Pid|PPid):' /proc/${pid}/status 2>&1" | sed 's/^/    /'
  fi
  echo "  ---------------------------"
}

run_probe_only_or_fail() {
  local context="$1"
  local probe_out
  probe_out="$(mktemp)"
  if ! timeout 60 nemoclaw "$SANDBOX_NAME" connect --probe-only >"$probe_out" 2>&1; then
    fail "${context}: connect --probe-only exited nonzero"
    sed 's/^/    /' "$probe_out"
    rm -f "$probe_out"
    gateway_diagnostics ""
    exit 1
  fi
  rm -f "$probe_out"
}

# Returns 0 when the current OpenClaw runtime has crossed the same readiness
# surface used by newer gateway E2Es: ready log, local /health, or healthy host
# status. This avoids failing on the old PID-name-only probe when OpenClaw is
# already serving.
gateway_runtime_ready() {
  if sandbox_exec sh -c "grep -Fq '[gateway] ready' /tmp/gateway.log 2>/dev/null"; then
    return 0
  fi
  local health_code
  health_code="$(sandbox_exec sh -c "curl -so /dev/null -w '%{http_code}' --max-time 3 http://localhost:${DASHBOARD_PORT}/health 2>/dev/null" | tr -d '[:space:]')" || true
  if [ "$health_code" = "200" ]; then
    return 0
  fi
  local status_output
  status_output="$(timeout 20 nemoclaw "$SANDBOX_NAME" status 2>&1)" || true
  if echo "$status_output" | grep -Eiq '\b(healthy|ready)\b'; then
    return 0
  fi
  if echo "$status_output" | grep -Eiq '\brunning\b' \
    && ! echo "$status_output" | grep -Eiq '\bnot[[:space:]]+running\b'; then
    return 0
  fi
  return 1
}

# Wait until gateway PID is non-empty and runtime-ready (or timeout). Echoes
# pid, returns 0/1.
wait_for_gateway_up() {
  local timeout="${1:-30}"
  local elapsed=0 pid=""
  while [ "$elapsed" -lt "$timeout" ]; do
    pid="$(gateway_pid)"
    if [ -n "$pid" ] && gateway_runtime_ready; then
      echo "$pid"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo ""
  return 1
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Preflight
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Preflight"

if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  exit 1
fi
pass "Docker running"

if [ "$USE_COMPAT_MOCK" = "1" ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 is required for the compatible endpoint mock"
    exit 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    fail "curl is required for the compatible endpoint mock readiness probe"
    exit 1
  fi
  pass "Compatible endpoint mock prerequisites available"
else
  if [ -z "${NVIDIA_API_KEY:-}" ] || [[ "${NVIDIA_API_KEY}" != nvapi-* ]]; then
    fail "NVIDIA_API_KEY not set or invalid"
    exit 1
  fi
  pass "NVIDIA_API_KEY set"
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ] || [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 and NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 are required"
  exit 1
fi
pass "Required env vars set"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Pre-cleanup + onboard
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Pre-cleanup + onboard"

if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
fi

cd "$REPO_ROOT" || {
  fail "cd $REPO_ROOT"
  exit 1
}

install_env=(
  env
  NEMOCLAW_NON_INTERACTIVE=1
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
  NEMOCLAW_RECREATE_SANDBOX=1
)

if [ "$USE_COMPAT_MOCK" = "1" ]; then
  COMPAT_HOST="$(host_ip_for_sandbox)"
  COMPAT_ENDPOINT_URL="http://${COMPAT_HOST}:${COMPAT_MOCK_PORT}/v1"
  if start_compat_mock; then
    pass "Compatible endpoint mock listening at ${COMPAT_ENDPOINT_URL}"
  else
    fail "Compatible endpoint mock did not become ready; see ${COMPAT_MOCK_LOG}"
    cat "$COMPAT_MOCK_LOG"
    exit 1
  fi
  install_env+=(
    COMPATIBLE_API_KEY="$COMPATIBLE_KEY"
    NEMOCLAW_PROVIDER=custom
    NEMOCLAW_ENDPOINT_URL="$COMPAT_ENDPOINT_URL"
    NEMOCLAW_MODEL="$COMPAT_MODEL"
  )
fi

INSTALL_LOG="${NEMOCLAW_E2E_INSTALL_LOG:-/tmp/nemoclaw-e2e-install.log}"
: >"$INSTALL_LOG" || {
  fail "Cannot write install log at $INSTALL_LOG"
  exit 1
}
"${install_env[@]}" bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1

install_exit=$?
if [ $install_exit -ne 0 ]; then
  fail "install.sh failed (exit $install_exit). Last 30 lines:"
  tail -30 "$INSTALL_LOG"
  info "Full install log retained at $INSTALL_LOG"
  exit 1
fi
pass "install.sh + onboard completed"

# Pick up PATH changes
[ -f "$HOME/.bashrc" ] && { source "$HOME/.bashrc" 2>/dev/null || true; }
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "nemoclaw not on PATH after install"
  exit 1
fi
pass "nemoclaw on PATH"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Verify initial gateway has the guard chain
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Initial gateway has guard chain"

INIT_PID="$(wait_for_gateway_up 60)"
if [ -z "$INIT_PID" ]; then
  fail "Gateway never came up after onboard"
  gateway_diagnostics ""
  exit 1
fi
pass "Gateway up (pid=$INIT_PID)"

if gateway_guards_active "$INIT_PID" 30; then
  pass "Initial gateway has guard chain active (proxy-env exports + gateway preloads loaded)"
else
  fail "Initial gateway missing library guard chain — fix is not deployed?"
  gateway_diagnostics "$INIT_PID"
  exit 1
fi

if gateway_serves_inference 30; then
  pass "Initial gateway serves inference API (https://inference.local/v1/models responds)"
else
  fail "Initial gateway alive but not serving inference — recovery is incomplete from user POV"
  gateway_diagnostics "$INIT_PID"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Crash-recovery loop ($CRASH_CYCLES cycles)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Crash-recovery loop ($CRASH_CYCLES cycles)"

prev_pid="$INIT_PID"
for cycle in $(seq 1 "$CRASH_CYCLES"); do
  info "Cycle $cycle/$CRASH_CYCLES — killing gateway pid=$prev_pid"
  guard_log_start="$(gateway_log_marker "cycle_${cycle}")"
  sandbox_exec sh -c "kill -9 $prev_pid 2>/dev/null; sleep 1" >/dev/null

  # Trigger recovery via the actual operator probe path:
  # `nemoclaw <name> connect --probe-only` calls
  # checkAndRecoverSandboxProcesses() -> recoverSandboxProcesses() without
  # opening an interactive SSH session. Bound it with `timeout` so a hang in
  # CLI internals cannot eat the whole 30-min job budget.
  run_probe_only_or_fail "Cycle $cycle after gateway kill"

  if ! sandbox_exec sh -c 'test -s /tmp/gateway.log'; then
    fail "Cycle $cycle: connect --probe-only did not leave /tmp/gateway.log evidence"
    gateway_diagnostics ""
    exit 1
  fi

  new_pid="$(wait_for_gateway_up 45)"
  if [ -z "$new_pid" ]; then
    fail "Cycle $cycle: gateway did not respawn within 45s"
    gateway_log_tail 60
    exit 1
  fi
  if [ "$new_pid" = "$prev_pid" ]; then
    fail "Cycle $cycle: PID unchanged ($new_pid) — kill did not land"
    exit 1
  fi
  pass "Cycle $cycle: gateway respawned (pid $prev_pid → $new_pid)"

  if gateway_guards_active "$new_pid" 30 "$guard_log_start"; then
    pass "Cycle $cycle: respawned gateway retains guard chain (proxy-env + gateway preloads loaded)"
  else
    fail "Cycle $cycle: respawned gateway LOST guard chain — recovery hardening regressed"
    gateway_diagnostics "$new_pid"
    gateway_log_tail 80
    exit 1
  fi

  if gateway_serves_inference 30; then
    pass "Cycle $cycle: respawned gateway serves inference API"
  else
    fail "Cycle $cycle: gateway up + guards active but inference API not serving"
    gateway_diagnostics "$new_pid"
    gateway_log_tail 80
    exit 1
  fi

  prev_pid="$new_pid"
done

# ══════════════════════════════════════════════════════════════════
# Phase 4: Negative case — env file missing → warning logged
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Negative case — proxy-env.sh missing surfaces a warning"

# Snapshot proxy-env.sh contents so we can restore after the test.
# Capture as base64 from inside the sandbox so the round-trip is byte-
# faithful — `$(cat ...)` would strip trailing newlines and break the
# eventual size verification by ~2 bytes. We also pull the original size
# separately so the post-restore wc -c can be compared exactly.
SNAPSHOT_B64="$(sandbox_exec sh -c 'base64 < /tmp/nemoclaw-proxy-env.sh' | tr -d '[:space:]')"
SNAPSHOT_SIZE="$(sandbox_exec sh -c 'wc -c < /tmp/nemoclaw-proxy-env.sh' | tr -d '[:space:]')"
if [ -z "$SNAPSHOT_B64" ] || [ -z "$SNAPSHOT_SIZE" ] || [ "$SNAPSHOT_SIZE" -eq 0 ]; then
  fail "proxy-env.sh is empty/missing already — cannot run negative case"
  exit 1
fi
info "Snapshotted proxy-env.sh ($SNAPSHOT_SIZE bytes, ${#SNAPSHOT_B64}-char base64)"

# Remove proxy-env.sh, kill the entire openclaw process tree, trigger
# recovery, expect WARNING. We must kill the launcher AND the gateway —
# pkill -9 -f '[o]penclaw' takes them all out so the launcher's watchdog
# can't silently respawn the gateway before nemoclaw status runs the
# recovery script (which is the only path that emits the warning).
negative_guard_log_start="$(gateway_log_marker "negative")"
sandbox_exec sh -c 'rm -f /tmp/nemoclaw-proxy-env.sh' >/dev/null
sandbox_exec sh -c "pkill -9 -f '[o]penclaw' 2>/dev/null; sleep 2; pgrep -af '[o]penclaw' || echo ALL_DEAD" >/dev/null
run_probe_only_or_fail "Negative case after proxy-env removal"

# The new gateway.log should contain the [gateway-recovery] WARNING line and
# recovery should have attempted a real gateway respawn.
warn_seen=false
for _ in 1 2 3 4 5; do
  if gateway_log_tail 100 | grep -q '\[gateway-recovery\] WARNING'; then
    warn_seen=true
    break
  fi
  sleep 3
done
if $warn_seen; then
  pass "Recovery emitted [gateway-recovery] WARNING when proxy-env.sh missing"
else
  fail "Recovery silently launched without warning (regression of #2478 fix)"
  gateway_log_tail 100
fi
NEGATIVE_PID="$(wait_for_gateway_up 45)"
if [ -z "$NEGATIVE_PID" ]; then
  fail "Recovery warning was logged, but gateway did not respawn within 45s"
  gateway_diagnostics ""
  exit 1
fi
info "Negative-case recovery respawned gateway pid=$NEGATIVE_PID"

# ── #2701 contract assertion ─────────────────────────────────────────
# After recovery, the guard chain MUST be restored. Today this fails on
# `main`: recovery emits the WARNING above and then launches the gateway
# naked, leaving /tmp/nemoclaw-proxy-env.sh absent. On aarch64 / DGX Spark
# this triggers the @homebridge/ciao crash loop documented in #2701; on
# x86 the gateway boots fine but the guard chain is still missing, which
# is the failure shape this assertion catches.
#
# Once the #2701 fix lands, recovery re-emits the chain before launching
# and this assertion flips green. Will fail on origin/main as of 2026-06-09.
if gateway_guards_active "$NEGATIVE_PID" 30 "$negative_guard_log_start"; then
  pass "#2701: recovery restored guard chain (proxy-env.sh + safety-net + ciao)"
else
  fail "#2701: recovery did NOT restore guard chain — gateway respawned naked (DGX Spark crash-loop scenario)"
  gateway_diagnostics "$NEGATIVE_PID"
  # Do not exit 1 yet — we still want Phase 4's restore + Phase 5 soak to
  # run so the artifact bundle is comparable to historical runs. Defer the
  # failure decision to the test-level fail counter at the end of the file.
fi

# Restore proxy-env.sh by base64-injecting the snapshot via argv. `openshell
# sandbox exec` does not pipe stdin from the caller through to the subshell,
# so a `printf | sandbox_exec sh -c 'cat > file'` would leave an empty file.
# Encoding into the command argv sidesteps the stdin gap entirely.
#
# After the #2701 fix, recovery may already have restored a minimal hardened
# proxy-env from trusted preload sources. In that case the sandbox user cannot
# necessarily overwrite the root-owned 0444 file with the original snapshot;
# accept the recovered file if it still proves the guard chain is active. This
# keeps the test focused on the user-visible contract instead of byte-identical
# cleanup of an implementation detail.
sandbox_exec sh -c "echo '$SNAPSHOT_B64' | base64 -d > /tmp/nemoclaw-proxy-env.sh && chmod 444 /tmp/nemoclaw-proxy-env.sh" >/dev/null

restored_size="$(sandbox_exec sh -c 'wc -c < /tmp/nemoclaw-proxy-env.sh' | tr -d '[:space:]')"
if [ "$restored_size" = "$SNAPSHOT_SIZE" ]; then
  info "proxy-env.sh restored from snapshot (${restored_size} bytes verified)"
elif gateway_guards_active "$NEGATIVE_PID" 5 "$negative_guard_log_start"; then
  info "proxy-env.sh retained recovered guard env (${restored_size} bytes; original snapshot was ${SNAPSHOT_SIZE} bytes)"
else
  fail "proxy-env.sh restore failed and recovered guard env is not active: expected $SNAPSHOT_SIZE bytes, got '${restored_size}'"
  exit 1
fi

# Kill the current negative-case gateway, then trigger recovery to bring the
# gateway back with guards intact from either the snapshot or recovered env file.
restore_guard_log_start="$(gateway_log_marker "restore")"
sandbox_exec sh -c "pkill -9 -f '[o]penclaw' 2>/dev/null; sleep 2; pgrep -af '[o]penclaw' || echo ALL_DEAD" >/dev/null
run_probe_only_or_fail "Guard restore recovery"
SOAK_START_PID="$(wait_for_gateway_up 30)"
if [ -z "$SOAK_START_PID" ]; then
  fail "Gateway not up entering soak phase"
  gateway_diagnostics ""
  exit 1
fi
# Confirm the restored gateway has guards back in place — otherwise the
# soak measures a crash-looping gateway, not steady-state recovery.
if ! gateway_guards_active "$SOAK_START_PID" 30 "$restore_guard_log_start"; then
  fail "Gateway up but guards not active entering soak — restore did not take"
  gateway_diagnostics "$SOAK_START_PID"
  exit 1
fi
if ! gateway_serves_inference 30; then
  fail "Gateway alive + guards active but inference API not serving entering soak"
  gateway_diagnostics "$SOAK_START_PID"
  exit 1
fi
pass "Gateway healthy with guards active and inference API serving (pid=$SOAK_START_PID)"

# ══════════════════════════════════════════════════════════════════
# Phase 5: Soak — verify no crash-loop over $SOAK_SECONDS
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Soak ($SOAK_SECONDS s) — detect crash-loop regression"

info "Sleeping ${SOAK_SECONDS}s while observing gateway. Health-monitor restart"
info "cadence is ~240s in prod, so a $SOAK_SECONDS s window catches at least one cycle."

# Sample PID every 15s + probe the inference endpoint every 60s. Count
# distinct PIDs, empty PID samples (gateway down), and inference-endpoint
# failures. The endpoint probe is the user-facing signal — pre-fix the
# ciao crash made `inference.local/v1/models` go silent for the user
# even though the underlying OS process state was variously alive/dead.
declare -a SAMPLES=()
empty_samples=0
inference_probes=0
inference_failures=0
elapsed=0
INTERVAL=15
while [ "$elapsed" -lt "$SOAK_SECONDS" ]; do
  cur="$(gateway_pid)"
  SAMPLES+=("$cur")
  [ -z "$cur" ] && empty_samples=$((empty_samples + 1))
  if [ $((elapsed % 60)) -eq 0 ]; then
    inference_probes=$((inference_probes + 1))
    if ! gateway_serves_inference 5; then
      inference_failures=$((inference_failures + 1))
    fi
  fi
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

# Distinct non-empty PIDs.
distinct=$(printf '%s\n' "${SAMPLES[@]}" | grep -v '^$' | sort -u | wc -l | tr -d ' ')
total_samples=${#SAMPLES[@]}

info "Soak summary: ${total_samples} samples, ${distinct} distinct PID(s), ${empty_samples} empty observations, ${inference_failures}/${inference_probes} inference probes failed"

# Crash-loop signature: many distinct PIDs (>2 over 5min = bad). One respawn
# (distinct=2) is acceptable if health-monitor fires once. Empty samples >1
# indicate the gateway was actually down for >15s, which is also bad.
if [ "$distinct" -le 2 ] && [ "$empty_samples" -le 1 ]; then
  pass "No crash-loop detected during soak ($distinct distinct PIDs, $empty_samples empty samples)"
else
  fail "Crash-loop signature: $distinct distinct PIDs and $empty_samples empty samples in ${SOAK_SECONDS}s"
  printf '  PID samples: %s\n' "${SAMPLES[*]}"
  gateway_log_tail 120
fi

# Inference-API availability: this is the user-facing failure surface from
# the #2478 comment ("deployed model not available because curl returns
# nothing"). Zero failures across the soak proves recovery preserves the
# user-visible service, not just the OS process.
if [ "$inference_failures" -eq 0 ]; then
  pass "Inference API available throughout soak ($inference_probes/$inference_probes probes succeeded)"
else
  fail "Inference API unavailable during soak ($inference_failures/$inference_probes probes failed)"
  gateway_log_tail 120
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Cleanup"

[[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Issue #2478 crash-loop recovery e2e:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  PASS — gateway recovery preserves library guards under repeated kill-respawn and idle soak.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
