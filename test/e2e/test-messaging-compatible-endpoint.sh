#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Telegram + OpenAI-compatible endpoint regression E2E (#2766)
#
# Hermetic path:
#   - starts a local OpenAI-compatible mock endpoint
#   - onboards with NEMOCLAW_PROVIDER=custom and Telegram enabled
#   - verifies OpenClaw keeps the managed inference.local provider shape
#   - verifies a sandbox-side chat completion reaches the mock with auth
#
# Prerequisites:
#   - Docker running
#   - NemoClaw installed or a source checkout that install.sh can install
#
# Environment:
#   NEMOCLAW_SANDBOX_NAME        — sandbox name (default: e2e-msg-compat)
#   NEMOCLAW_COMPAT_MOCK_PORT   — mock endpoint port (default: 18089)
#   NEMOCLAW_COMPAT_MODEL       — model id for the compatible endpoint mock
#   NEMOCLAW_COMPAT_MOCK_API_KEY — optional; defaults to a fake hermetic key
#   TELEGRAM_BOT_TOKEN          — optional; defaults to a fake Telegram token
#   TELEGRAM_ALLOWED_IDS        — optional; defaults to a fake allowlist
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     bash test/e2e/test-messaging-compatible-endpoint.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1800
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
. "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

PASS=0
FAIL=0
SKIP=0
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
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

summary() {
  echo ""
  echo "============================================================"
  echo "  Messaging Compatible Endpoint E2E Results"
  echo "============================================================"
  echo "  PASS: $PASS"
  echo "  FAIL: $FAIL"
  echo "  SKIP: $SKIP"
  echo "  TOTAL: $TOTAL"
  echo "============================================================"
  if [ "$FAIL" -gt 0 ]; then
    exit 1
  fi
}

host_ip_for_sandbox() {
  local ip_addr
  ip_addr="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
  if [ -n "$ip_addr" ]; then
    echo "$ip_addr"
    return
  fi
  ip_addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$ip_addr" ]; then
    echo "$ip_addr"
    return
  fi
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    for iface in en0 en1 bridge100; do
      ip_addr="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      if [ -n "$ip_addr" ]; then
        echo "$ip_addr"
        return
      fi
    done
    ip_addr="$(ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\./ {print $2; exit}')"
    if [ -n "$ip_addr" ]; then
      echo "$ip_addr"
      return
    fi
  fi
  echo "127.0.0.1"
}

quote_for_remote_sh() {
  local value="${1:-}"
  printf "'%s'" "$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
}

sandbox_exec_sh_script() {
  local script="$1"
  shift
  local encoded remote_cmd arg
  encoded="$(printf '%s' "$script" | base64 | tr -d '\n')"
  remote_cmd="tmp=\$(mktemp); trap 'rm -f \"\$tmp\"' EXIT; printf %s $(quote_for_remote_sh "$encoded") | base64 -d > \"\$tmp\"; sh \"\$tmp\""
  for arg in "$@"; do
    remote_cmd+=" $(quote_for_remote_sh "$arg")"
  done
  openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$remote_cmd"
}

stop_compat_mock() {
  if [ -n "${COMPAT_MOCK_PID:-}" ] && kill -0 "$COMPAT_MOCK_PID" 2>/dev/null; then
    kill "$COMPAT_MOCK_PID" 2>/dev/null || true
    wait "$COMPAT_MOCK_PID" 2>/dev/null || true
  fi
  COMPAT_MOCK_PID=""
}

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

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_sse(self):
        body = (
            "event: response.output_text.delta\n"
            "data: {\"delta\":\"OK\"}\n\n"
            "event: response.completed\n"
            "data: {}\n\n"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        return self.headers.get("Authorization", "") == "Bearer " + api_key

    def do_GET(self):
        if self.path == "/v1/models":
            print("GET /v1/models", flush=True)
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

        if self.path == "/v1/responses":
            print("POST /v1/responses auth=%s stream=%s" % ("ok" if self._auth_ok() else "missing", payload.get("stream")), flush=True)
            if not self._auth_ok():
                self._send(401, {"error": {"message": "missing bearer credential"}})
                return
            if payload.get("stream"):
                self._send_sse()
                return
            self._send(200, {
                "id": "resp-mock",
                "object": "response",
                "output": [{
                    "type": "function_call",
                    "name": "emit_ok",
                    "arguments": "{\"value\":\"OK\"}"
                }],
            })
            return

        if self.path == "/v1/chat/completions":
            print("POST /v1/chat/completions auth=%s model=%s" % ("ok" if self._auth_ok() else "missing", payload.get("model")), flush=True)
            if not self._auth_ok():
                self._send(401, {"error": {"message": "missing bearer credential"}})
                return
            self._send(200, {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "PONG from compatible endpoint mock"
                    },
                    "finish_reason": "stop"
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

load_shell_path() {
  local local_bin
  if [ -f "$HOME/.bashrc" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.bashrc" 2>/dev/null || true
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi
  local_bin="$HOME/.local/bin"
  if [ -d "$local_bin" ]; then
    PATH=":${PATH}:"
    PATH="${PATH//:${local_bin}:/:}"
    PATH="${PATH#:}"
    PATH="${PATH%:}"
    export PATH="$local_bin:$PATH"
  fi
}

cli_command_available_from_source() {
  [ -f "$REPO/dist/nemoclaw.js" ] && command -v node >/dev/null 2>&1 && command -v openshell >/dev/null 2>&1
}

run_cli() {
  if cli_command_available_from_source; then
    node "$REPO/bin/nemoclaw.js" "$@"
  else
    nemoclaw "$@"
  fi
}

destroy_sandbox_best_effort() {
  if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]; then
    return 0
  fi
  set +e
  if cli_command_available_from_source; then
    run_with_timeout 120 node "$REPO/bin/nemoclaw.js" "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1
  elif command -v nemoclaw >/dev/null 2>&1; then
    run_with_timeout 120 nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1
  fi
  if command -v openshell >/dev/null 2>&1; then
    run_with_timeout 60 openshell sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1
  fi
  set -uo pipefail
}

run_compatible_onboard() {
  local onboard_exit=0
  local onboard_cmd_desc
  export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
  export NEMOCLAW_RECREATE_SANDBOX=1
  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
  export NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1
  export NEMOCLAW_PROVIDER=custom
  export NEMOCLAW_ENDPOINT_URL="$COMPAT_ENDPOINT_URL"
  export NEMOCLAW_MODEL="$COMPAT_MODEL"
  export NEMOCLAW_PREFERRED_API=openai-completions
  export NEMOCLAW_POLICY_MODE=custom
  export NEMOCLAW_POLICY_PRESETS=telegram
  export COMPATIBLE_API_KEY="$COMPATIBLE_KEY"
  export TELEGRAM_BOT_TOKEN="$TELEGRAM_TOKEN"
  export TELEGRAM_ALLOWED_IDS="$TELEGRAM_IDS"
  unset DISCORD_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN

  if cli_command_available_from_source; then
    onboard_cmd_desc="source CLI onboard"
    info "Using source-built CLI at $REPO/bin/nemoclaw.js"
    destroy_sandbox_best_effort
    run_with_timeout 1200 node "$REPO/bin/nemoclaw.js" onboard --fresh --non-interactive --yes-i-accept-third-party-software \
      >"$ONBOARD_LOG" 2>&1 || onboard_exit=$?
  else
    onboard_cmd_desc="install.sh"
    info "Source CLI is not built yet; running install.sh from this checkout."
    bash "$REPO/install.sh" --non-interactive --yes-i-accept-third-party-software --fresh \
      >"$ONBOARD_LOG" 2>&1 || onboard_exit=$?
    load_shell_path
  fi

  if [ "$onboard_exit" -eq 0 ]; then
    pass "C1: ${onboard_cmd_desc} completed for compatible endpoint + Telegram"
  else
    fail "C1: ${onboard_cmd_desc} failed (exit $onboard_exit)"
    info "Last 80 lines of onboard log:"
    tail -80 "$ONBOARD_LOG" 2>/dev/null || true
    summary
  fi
}

check_openclaw_config() {
  local output rc=0 script
  script=$(
    cat <<'SH'
python3 - "$1" <<'PY'
import json
import sys

model = sys.argv[1]
cfg = json.load(open("/sandbox/.openclaw/openclaw.json", encoding="utf-8"))
providers = cfg.get("models", {}).get("providers", {})
errors = []
if "deepinfra" in providers:
    errors.append("direct deepinfra provider is present")
if sorted(providers.keys()) != ["inference"]:
    errors.append("provider keys are %r" % sorted(providers.keys()))
inference = providers.get("inference") if isinstance(providers, dict) else None
if not isinstance(inference, dict):
    errors.append("models.providers.inference is missing")
else:
    if inference.get("baseUrl") != "https://inference.local/v1":
        errors.append("inference baseUrl is %r" % inference.get("baseUrl"))
    if inference.get("apiKey") != "unused":
        errors.append("inference apiKey is not the non-secret placeholder")
primary = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary")
if primary != "inference/" + model:
    errors.append("primary model is %r" % primary)
if not cfg.get("channels", {}).get("telegram"):
    errors.append("telegram channel config missing")
print(json.dumps({
    "provider_keys": sorted(providers.keys()) if isinstance(providers, dict) else [],
    "inference_base": inference.get("baseUrl") if isinstance(inference, dict) else None,
    "inference_api_key": inference.get("apiKey") if isinstance(inference, dict) else None,
    "primary": primary,
    "telegram_present": bool(cfg.get("channels", {}).get("telegram")),
    "errors": errors,
}))
sys.exit(1 if errors else 0)
PY
SH
  )
  output=$(sandbox_exec_sh_script "$script" "$COMPAT_MODEL" 2>&1) || rc=$?
  info "OpenClaw config summary: ${output:0:500}"
  if [ "$rc" -eq 0 ]; then
    pass "C3: openclaw.json uses managed inference.local provider and Telegram config"
  else
    fail "C3: openclaw.json compatible endpoint shape is wrong"
  fi
}

check_gateway_ready() {
  local result script
  script=$(
    cat <<'SH'
node <<'NODE'
const net = require("net");
const sock = net.connect(18789, "127.0.0.1");
sock.on("connect", () => { console.log("OPEN"); sock.end(); });
sock.on("error", (err) => console.log("ERROR " + err.message));
setTimeout(() => { console.log("TIMEOUT"); sock.destroy(); }, 5000);
NODE
SH
  )
  result=$(sandbox_exec_sh_script "$script" 2>&1 || true)
  if echo "$result" | grep -q "OPEN"; then
    pass "C4: Gateway stayed up after Telegram provider initialization"
  else
    fail "C4: Gateway is not serving after Telegram-compatible onboard (${result:0:200})"
    info "Gateway log tail:"
    openshell sandbox exec --name "$SANDBOX_NAME" -- cat /tmp/gateway.log 2>/dev/null | tail -60 || true
  fi
}

check_sandbox_inference() {
  local payload payload_arg response rc=0 content
  payload=$(COMPAT_MODEL="$COMPAT_MODEL" python3 -c '
import json
import os
print(json.dumps({
    "model": os.environ["COMPAT_MODEL"],
    "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
    "max_tokens": 32,
}))
')
  payload_arg="$(printf '%q' "$payload")"
  response=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "curl -sS --max-time 60 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d $payload_arg" 2>&1) || rc=$?
  content=$(printf '%s' "$response" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["choices"][0]["message"]["content"])' 2>/dev/null) || true
  if [ "$rc" -eq 0 ] && echo "$content" | grep -q "PONG"; then
    pass "C5: Sandbox inference.local chat completion returned mock content"
  else
    fail "C5: Sandbox inference.local chat completion failed (${response:0:400})"
  fi
}

cleanup() {
  stop_compat_mock
  rm -f "$COMPAT_MOCK_LOG" 2>/dev/null || true
  destroy_sandbox_best_effort
}

# ── Repo root ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "${SCRIPT_DIR}/../../install.sh" ]; then
  REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"
elif [ -f "./install.sh" ]; then
  REPO="$(pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-msg-compat}"
COMPAT_MOCK_PORT="${NEMOCLAW_COMPAT_MOCK_PORT:-18089}"
COMPAT_MODEL="${NEMOCLAW_COMPAT_MODEL:-mock/deepseek-compatible}"
COMPATIBLE_KEY="${NEMOCLAW_COMPAT_MOCK_API_KEY:-fake-compatible-key-e2e}"
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-test-fake-telegram-token-e2e}"
TELEGRAM_IDS="${TELEGRAM_ALLOWED_IDS:-123456789}"
COMPAT_MOCK_LOG="$(mktemp)"
COMPAT_MOCK_PID=""
ONBOARD_LOG="/tmp/nemoclaw-e2e-messaging-compatible-endpoint-install.log"

trap cleanup EXIT

echo ""
echo "============================================================"
echo "  Telegram + Compatible Endpoint E2E (#2766)"
echo "  $(date)"
echo "============================================================"
echo ""

section "Phase 0: Prerequisites"
if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  summary
fi
pass "Docker is running"

if ! command -v python3 >/dev/null 2>&1; then
  fail "python3 not found"
  summary
fi
pass "python3 is available"

load_shell_path
info "Repo: $REPO"
info "Sandbox: $SANDBOX_NAME"
info "Model: $COMPAT_MODEL"

section "Phase 1: Local compatible endpoint mock"
COMPAT_HOST="$(host_ip_for_sandbox)"
COMPAT_ENDPOINT_URL="http://${COMPAT_HOST}:${COMPAT_MOCK_PORT}/v1"
info "Starting mock endpoint at ${COMPAT_ENDPOINT_URL}"
if start_compat_mock; then
  pass "C0: Compatible endpoint mock started"
else
  fail "C0: Compatible endpoint mock failed to start"
  info "Mock log:"
  sed 's/^/    /' "$COMPAT_MOCK_LOG" || true
  summary
fi

if curl -sf "${COMPAT_ENDPOINT_URL}/models" >/dev/null 2>&1; then
  pass "C0b: Compatible endpoint mock is reachable through host address"
else
  fail "C0b: Compatible endpoint mock is not reachable at ${COMPAT_ENDPOINT_URL}"
  summary
fi

section "Phase 2: Onboard custom provider with Telegram"
run_compatible_onboard

if grep -q "Compatible endpoint responds through inference.local" "$ONBOARD_LOG" 2>/dev/null; then
  pass "C2: Onboard ran the compatible endpoint sandbox smoke check"
else
  fail "C2: Onboard log does not show the compatible endpoint sandbox smoke check"
fi

section "Phase 3: Runtime assertions"
if openshell provider get compatible-endpoint >/dev/null 2>&1; then
  pass "C2b: Gateway has the compatible-endpoint provider"
else
  fail "C2b: Gateway is missing the compatible-endpoint provider"
fi

check_openclaw_config
check_gateway_ready
check_sandbox_inference

if grep -q "POST /v1/chat/completions auth=ok" "$COMPAT_MOCK_LOG" 2>/dev/null; then
  pass "C6: Compatible mock received authenticated chat traffic"
else
  fail "C6: Compatible mock did not record authenticated chat traffic"
  info "Mock log:"
  sed 's/^/    /' "$COMPAT_MOCK_LOG" || true
fi

if [ -n "${TELEGRAM_BOT_TOKEN_REAL:-}" ] \
  && [ -n "${TELEGRAM_CHAT_ID_E2E:-}" ] \
  && [ -n "${COMPATIBLE_API_KEY:-}" ] \
  && [ -n "${NEMOCLAW_ENDPOINT_URL:-}" ] \
  && [ -n "${NEMOCLAW_COMPAT_MODEL:-}" ]; then
  skip "C7: Live Telegram reply requires an inbound user-message driver; hermetic route passed"
else
  skip "C7: Live Telegram-compatible round trip secrets not fully set"
fi

trap - EXIT
cleanup
summary
