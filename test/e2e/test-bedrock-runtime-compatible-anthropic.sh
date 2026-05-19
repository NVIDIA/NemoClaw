#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Bedrock Runtime compatible Anthropic endpoint E2E (#3767).
#
# Hermetic path:
#   - starts a local HTTP/2 fake Bedrock Runtime endpoint
#   - maps bedrock-runtime.us-east-1.amazonaws.com to localhost
#   - onboards with NEMOCLAW_PROVIDER=anthropicCompatible and a fake pasted key
#   - proves OpenShell owns the hidden Bedrock adapter token while the sandbox
#     only sees https://inference.local/v1
#   - exercises OpenClaw and Hermes agent-specific runtime paths via the same
#     nightly matrix script
#
# Environment:
#   NEMOCLAW_AGENT                         openclaw or hermes
#   NEMOCLAW_SANDBOX_NAME                  sandbox name
#   NEMOCLAW_BEDROCK_RUNTIME_MOCK_PORT     fake Bedrock endpoint port
#   NEMOCLAW_E2E_KEEP_SANDBOX=1            keep sandbox for debugging

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=2700
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

info() {
  printf '\033[1;34m  [info]\033[0m %s\n' "$1"
}

summary() {
  echo ""
  echo "============================================================"
  echo "  Bedrock Runtime Compatible Anthropic E2E Results"
  echo "============================================================"
  echo "  Agent: $AGENT"
  echo "  PASS:  $PASS"
  echo "  FAIL:  $FAIL"
  echo "  SKIP:  $SKIP"
  echo "  TOTAL: $TOTAL"
  echo "============================================================"
  if [ "$FAIL" -gt 0 ]; then
    exit 1
  fi
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

parse_chat_content() {
  python3 -c '
import json
import sys

try:
    response = json.load(sys.stdin)
    message = response["choices"][0]["message"]
    print((message.get("content") or message.get("reasoning_content") or "").strip())
except Exception as exc:
    print(f"PARSE_ERROR: {exc}", file=sys.stderr)
    sys.exit(1)
'
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

prepare_source_cli() {
  local rc=0
  : >"$BUILD_LOG"
  load_shell_path

  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not available on PATH" >>"$BUILD_LOG"
    return 127
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "node is not available on PATH" >>"$BUILD_LOG"
    return 127
  fi

  info "Installing npm dependencies and building source CLI"
  (
    cd "$REPO" \
      && npm ci --ignore-scripts \
      && npm run build:cli
  ) >>"$BUILD_LOG" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi

  if ! command -v openshell >/dev/null 2>&1; then
    info "Installing OpenShell CLI"
    bash "$REPO/scripts/install-openshell.sh" >>"$BUILD_LOG" 2>&1 || rc=$?
    load_shell_path
    if [ "$rc" -ne 0 ]; then
      return "$rc"
    fi
  fi

  if ! command -v openshell >/dev/null 2>&1; then
    echo "openshell is not available on PATH after installation" >>"$BUILD_LOG"
    return 127
  fi
}

stop_bedrock_mock() {
  if [ -n "${BEDROCK_MOCK_PID:-}" ] && kill -0 "$BEDROCK_MOCK_PID" 2>/dev/null; then
    kill "$BEDROCK_MOCK_PID" 2>/dev/null || true
    wait "$BEDROCK_MOCK_PID" 2>/dev/null || true
  fi
  BEDROCK_MOCK_PID=""
}

restore_hosts_file() {
  if [ -n "${HOSTS_BACKUP:-}" ] && [ -f "$HOSTS_BACKUP" ]; then
    sudo cp "$HOSTS_BACKUP" /etc/hosts 2>/dev/null || true
    rm -f "$HOSTS_BACKUP" 2>/dev/null || true
    HOSTS_BACKUP=""
  fi
}

stop_bedrock_adapter_best_effort() {
  local state_file pid_file token_file pid endpoint
  state_file="$HOME/.nemoclaw/bedrock-runtime-adapter.json"
  pid_file="$HOME/.nemoclaw/bedrock-runtime-adapter.pid"
  token_file="$HOME/.nemoclaw/bedrock-runtime-adapter-token"
  if [ -f "$state_file" ]; then
    endpoint=$(
      python3 - "$state_file" <<'PY' 2>/dev/null || true
import json
import sys

try:
    print((json.load(open(sys.argv[1], encoding="utf-8")).get("endpointUrl") or "").strip())
except Exception:
    pass
PY
    )
    if [ "$endpoint" != "$BEDROCK_ENDPOINT_URL" ]; then
      return 0
    fi
  fi
  if [ -f "$pid_file" ]; then
    pid="$(tr -d '\n' <"$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ] && ps -p "$pid" -o args= 2>/dev/null | grep -q "bedrock-runtime-adapter.js"; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pid_file" "$token_file" "$state_file" 2>/dev/null || true
}

destroy_sandbox_best_effort() {
  if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]; then
    return 0
  fi
  set +e
  if cli_command_available_from_source; then
    NEMOCLAW_AGENT="$AGENT" run_with_timeout 180 node "$REPO/bin/nemoclaw.js" "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1
  elif command -v nemoclaw >/dev/null 2>&1; then
    NEMOCLAW_AGENT="$AGENT" run_with_timeout 180 nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1
  fi
  if command -v openshell >/dev/null 2>&1; then
    run_with_timeout 60 openshell sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1
    run_with_timeout 60 openshell gateway destroy -g nemoclaw >/dev/null 2>&1
  fi
  set -uo pipefail
}

cleanup() {
  stop_bedrock_mock
  stop_bedrock_adapter_best_effort
  restore_hosts_file
  destroy_sandbox_best_effort
}

map_bedrock_host_to_loopback() {
  if ! command -v sudo >/dev/null 2>&1; then
    fail "B0: sudo is required to edit /etc/hosts for Bedrock hostname mapping"
    summary
  fi
  if ! sudo -n true >/dev/null 2>&1; then
    fail "B0: passwordless sudo is required to edit /etc/hosts for Bedrock hostname mapping"
    summary
  fi

  HOSTS_BACKUP="$(mktemp)"
  sudo cp /etc/hosts "$HOSTS_BACKUP"
  printf '\n127.0.0.1 %s\n' "$BEDROCK_HOSTNAME" | sudo tee -a /etc/hosts >/dev/null

  if BEDROCK_HOSTNAME="$BEDROCK_HOSTNAME" python3 - <<'PY'; then
import os
import socket

raise SystemExit(0 if socket.gethostbyname(os.environ["BEDROCK_HOSTNAME"]) == "127.0.0.1" else 1)
PY
    pass "B0: Bedrock Runtime hostname maps to localhost"
  else
    fail "B0: Bedrock Runtime hostname did not resolve to localhost after hosts edit"
    summary
  fi
}

start_bedrock_mock() {
  : >"$BEDROCK_MOCK_LOG"
  BEDROCK_FAKE_EXPECTED_BEARER="$COMPATIBLE_KEY" node - "$BEDROCK_MOCK_PORT" "$BEDROCK_MODEL" >"$BEDROCK_MOCK_LOG" 2>&1 <<'NODE' &
const http2 = require("node:http2");
const { EventStreamCodec } = require("@smithy/core/event-streams");
const { fromUtf8, toUtf8 } = require("@smithy/util-utf8");

const port = Number(process.argv[2]);
const expectedModel = process.argv[3];
const expectedBearer = process.env.BEDROCK_FAKE_EXPECTED_BEARER || "";
const codec = new EventStreamCodec(toUtf8, fromUtf8);

function eventMessage(eventType, payload) {
  return Buffer.from(codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: eventType },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: fromUtf8(JSON.stringify(payload)),
  }));
}

function sendJson(stream, status, payload) {
  stream.respond({
    [http2.constants.HTTP2_HEADER_STATUS]: status,
    [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: "application/json",
  });
  stream.end(JSON.stringify(payload));
}

function conversePayload() {
  return {
    output: {
      message: {
        role: "assistant",
        content: [{ text: "PONG" }],
      },
    },
    stopReason: "end_turn",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
    metrics: {
      latencyMs: 1,
    },
  };
}

function sendConverseStream(stream) {
  stream.respond({
    [http2.constants.HTTP2_HEADER_STATUS]: 200,
    [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: "application/vnd.amazon.eventstream",
  });
  stream.write(eventMessage("messageStart", { role: "assistant" }));
  stream.write(eventMessage("contentBlockDelta", {
    contentBlockIndex: 0,
    delta: { text: "PONG" },
  }));
  stream.write(eventMessage("messageStop", { stopReason: "end_turn" }));
  stream.write(eventMessage("metadata", {
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 1 },
  }));
  stream.end();
}

function parseModelPath(pathname) {
  const match = pathname.match(/^\/model\/(.+)\/(converse|converse-stream)$/);
  if (!match) return null;
  return { model: decodeURIComponent(match[1]), operation: match[2] };
}

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  const method = headers[http2.constants.HTTP2_HEADER_METHOD] || "";
  const pathname = headers[http2.constants.HTTP2_HEADER_PATH] || "";
  const auth = headers[http2.constants.HTTP2_HEADER_AUTHORIZATION] || "";
  const chunks = [];

  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  stream.on("end", () => {
    const parsed = parseModelPath(String(pathname));
    if (method !== "POST" || !parsed) {
      sendJson(stream, 404, { message: "not found" });
      return;
    }

    const opLabel = parsed.operation === "converse-stream" ? "converse-stream" : "converse";
    if (auth !== `Bearer ${expectedBearer}`) {
      console.log(`POST /model/${opLabel} auth=missing`);
      sendJson(stream, 401, { message: "missing bearer credential" });
      return;
    }

    console.log(`POST /model/${opLabel} auth=ok`);
    if (parsed.model !== expectedModel) {
      sendJson(stream, 400, { message: "unexpected model id" });
      return;
    }

    if (parsed.operation === "converse-stream") {
      sendConverseStream(stream);
      return;
    }
    sendJson(stream, 200, conversePayload());
  });
});

server.on("sessionError", (err) => {
  console.log(`session_error=${err && err.code ? err.code : "unknown"}`);
});

server.listen(port, "127.0.0.1", () => {
  console.log("fake_bedrock_runtime_ready");
});
NODE
  BEDROCK_MOCK_PID=$!

  for _ in $(seq 1 30); do
    if node - "$BEDROCK_MOCK_PORT" <<'NODE' >/dev/null 2>&1; then
const net = require("node:net");
const port = Number(process.argv[2]);
const socket = net.connect(port, "127.0.0.1");
let done = false;
function finish(ok) {
  if (done) return;
  done = true;
  socket.destroy();
  process.exit(ok ? 0 : 1);
}
socket.on("connect", () => finish(true));
socket.on("error", () => finish(false));
socket.setTimeout(500, () => finish(false));
NODE
      return 0
    fi
    sleep 1
  done
  return 1
}

run_bedrock_onboard() {
  local onboard_exit=0
  export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
  export NEMOCLAW_AGENT="$AGENT"
  export NEMOCLAW_RECREATE_SANDBOX=1
  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
  export NEMOCLAW_YES=1
  export NEMOCLAW_PROVIDER=anthropicCompatible
  export NEMOCLAW_ENDPOINT_URL="$BEDROCK_ENDPOINT_URL"
  export NEMOCLAW_MODEL="$BEDROCK_MODEL"
  export NEMOCLAW_PREFERRED_API=openai-completions
  export NEMOCLAW_POLICY_MODE=skip
  export COMPATIBLE_ANTHROPIC_API_KEY="$COMPATIBLE_KEY"

  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
  unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  unset AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_BEARER_TOKEN_BEDROCK
  unset AWS_REGION AWS_DEFAULT_REGION
  unset NVIDIA_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY COMPATIBLE_API_KEY
  unset TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN

  destroy_sandbox_best_effort
  info "Using source-built CLI at $REPO/bin/nemoclaw.js for agent=$AGENT"
  run_with_timeout 1800 node "$REPO/bin/nemoclaw.js" onboard --fresh --non-interactive --yes-i-accept-third-party-software \
    >"$ONBOARD_LOG" 2>&1 || onboard_exit=$?

  if [ "$onboard_exit" -eq 0 ]; then
    pass "B1: onboard completed for Bedrock Runtime compatible Anthropic endpoint"
  else
    fail "B1: onboard failed for Bedrock Runtime compatible Anthropic endpoint"
    info "Last 120 lines of onboard log:"
    tail -120 "$ONBOARD_LOG" 2>/dev/null || true
    summary
  fi
}

assert_onboard_identity() {
  local probe rc=0
  probe=$(
    SANDBOX_NAME="$SANDBOX_NAME" AGENT="$AGENT" BEDROCK_MODEL="$BEDROCK_MODEL" python3 - <<'PY'
import json
import os
from pathlib import Path

home = Path.home()
name = os.environ["SANDBOX_NAME"]
agent = os.environ["AGENT"]
model = os.environ["BEDROCK_MODEL"]
expected_provider = "compatible-anthropic-endpoint"
errors = []

session_path = home / ".nemoclaw" / "onboard-session.json"
registry_path = home / ".nemoclaw" / "sandboxes.json"

try:
    session = json.loads(session_path.read_text(encoding="utf-8"))
except Exception as exc:
    session = None
    errors.append(f"session read failed: {exc}")

if isinstance(session, dict):
    if session.get("sandboxName") != name:
        errors.append(f"session sandboxName={session.get('sandboxName')!r}")
    if session.get("agent") not in (None, agent):
        errors.append(f"session agent={session.get('agent')!r}")
    if session.get("provider") != expected_provider:
        errors.append(f"session provider={session.get('provider')!r}")
    if session.get("model") != model:
        errors.append(f"session model={session.get('model')!r}")

try:
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    sandbox = (registry.get("sandboxes") or {}).get(name)
except Exception as exc:
    sandbox = None
    errors.append(f"registry read failed: {exc}")

if not isinstance(sandbox, dict):
    errors.append(f"registry sandbox {name!r} missing")
else:
    if sandbox.get("agent") not in (None, agent):
        errors.append(f"registry agent={sandbox.get('agent')!r}")
    if sandbox.get("provider") != expected_provider:
        errors.append(f"registry provider={sandbox.get('provider')!r}")
    if sandbox.get("model") != model:
        errors.append(f"registry model={sandbox.get('model')!r}")

if errors:
    print("; ".join(errors))
    raise SystemExit(1)
print("OK")
PY
  ) || rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "B2: onboard state keeps provider identity as compatible-anthropic-endpoint"
  else
    fail "B2: onboard state did not preserve compatible-anthropic-endpoint identity: ${probe:0:500}"
  fi
}

assert_adapter_health() {
  local health rc=0
  health=$(curl -sf --max-time 5 "http://127.0.0.1:${BEDROCK_ADAPTER_PORT}/health" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "B3: Bedrock Runtime adapter health endpoint failed"
    return
  fi

  if HEALTH_JSON="$health" BEDROCK_ENDPOINT_URL="$BEDROCK_ENDPOINT_URL" python3 - <<'PY'; then
import json
import os

health = json.loads(os.environ["HEALTH_JSON"])
errors = []
if health.get("ok") is not True:
    errors.append(f"ok={health.get('ok')!r}")
if health.get("endpointUrl") != os.environ["BEDROCK_ENDPOINT_URL"]:
    errors.append("endpointUrl mismatch")
if health.get("region") != "us-east-1":
    errors.append(f"region={health.get('region')!r}")
if not health.get("tokenHash"):
    errors.append("tokenHash missing")
if errors:
    print("; ".join(errors))
    raise SystemExit(1)
PY
    pass "B3: Bedrock Runtime adapter health reports fake endpoint and us-east-1"
  else
    fail "B3: Bedrock Runtime adapter health payload was not the expected fake endpoint"
  fi
}

assert_openshell_provider_route() {
  local route provider_output plain_route
  route=$(openshell inference get -g nemoclaw 2>&1 || openshell inference get 2>&1) || {
    fail "B4: openshell inference get failed: ${route:0:300}"
    return
  }
  plain_route=$(printf '%s' "$route" | python3 -c 'import re,sys; sys.stdout.write(re.sub(r"\x1b\[[0-9;]*m", "", sys.stdin.read()))')
  if grep -Fq "Provider: compatible-anthropic-endpoint" <<<"$plain_route" \
    && grep -Fq "Model: ${BEDROCK_MODEL}" <<<"$plain_route"; then
    pass "B4: OpenShell route points at compatible-anthropic-endpoint"
  else
    fail "B4: OpenShell route did not point at compatible-anthropic-endpoint: ${plain_route:0:400}"
  fi

  provider_output=$(openshell provider get compatible-anthropic-endpoint 2>&1 || true)
  if grep -Fq "compatible-anthropic-endpoint" <<<"$provider_output"; then
    pass "B5: OpenShell provider registry contains compatible-anthropic-endpoint"
  else
    fail "B5: OpenShell provider registry did not expose compatible-anthropic-endpoint"
  fi
}

assert_openclaw_config() {
  local output rc=0 script
  script=$(
    cat <<'SH'
python3 - "$1" <<'PY'
import json
import sys

model = sys.argv[1]
cfg = json.load(open("/sandbox/.openclaw/openclaw.json", encoding="utf-8"))
errors = []
providers = cfg.get("models", {}).get("providers", {})
inference = providers.get("inference") if isinstance(providers, dict) else None
if sorted(providers.keys()) != ["inference"]:
    errors.append("provider keys are %r" % sorted(providers.keys()))
if not isinstance(inference, dict):
    errors.append("models.providers.inference is missing")
else:
    if inference.get("baseUrl") != "https://inference.local/v1":
        errors.append("inference baseUrl is %r" % inference.get("baseUrl"))
    if inference.get("apiKey") != "unused":
        errors.append("inference apiKey is not the non-secret placeholder")
    if inference.get("api") != "openai-completions":
        errors.append("inference api is %r" % inference.get("api"))
primary = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary")
if primary != "inference/" + model:
    errors.append("primary model is %r" % primary)
print(json.dumps({
    "provider_keys": sorted(providers.keys()) if isinstance(providers, dict) else [],
    "inference_base": inference.get("baseUrl") if isinstance(inference, dict) else None,
    "inference_api_key": inference.get("apiKey") if isinstance(inference, dict) else None,
    "primary": primary,
    "errors": errors,
}))
sys.exit(1 if errors else 0)
PY
SH
  )
  output=$(sandbox_exec_sh_script "$script" "$BEDROCK_MODEL" 2>&1) || rc=$?
  info "OpenClaw config summary: ${output:0:500}"
  if [ "$rc" -eq 0 ]; then
    pass "B6: OpenClaw config uses only managed inference.local provider"
  else
    fail "B6: OpenClaw config did not use the expected inference.local provider shape"
  fi
}

assert_hermes_config() {
  local config probe
  config=$(openshell sandbox exec --name "$SANDBOX_NAME" -- cat /sandbox/.hermes/config.yaml 2>&1) || {
    fail "B6: could not read Hermes config.yaml: ${config:0:240}"
    return
  }

  probe=$(
    CONFIG_TEXT="$config" EXPECTED_MODEL="$BEDROCK_MODEL" python3 - <<'PY'
import os
import re

text = os.environ["CONFIG_TEXT"]
expected = os.environ["EXPECTED_MODEL"]
errors = []
model = {}
in_model = False
for line in text.splitlines():
    if re.match(r"^model:\s*$", line):
        in_model = True
        continue
    if in_model and re.match(r"^[A-Za-z0-9_-]+:", line):
        break
    if in_model:
        match = re.match(r"^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$", line)
        if match:
            value = match.group(2).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            model[match.group(1)] = value

if model.get("default") != expected:
    errors.append(f"model.default={model.get('default')!r}")
if model.get("base_url") != "https://inference.local/v1":
    errors.append(f"model.base_url={model.get('base_url')!r}")
if re.search(r"(?ms)^models:\s*\n(?:[ \t].*\n)*?[ \t]+providers:", text):
    errors.append("OpenClaw-style models.providers block present")
if "openshell:" in text:
    errors.append("OpenShell provider placeholder present")

if errors:
    print("; ".join(errors))
    raise SystemExit(1)
print("OK")
PY
  ) || {
    fail "B6: Hermes config.yaml was not patched correctly: ${probe:0:400}"
    return
  }
  pass "B6: Hermes config uses inference.local without OpenShell/OpenClaw provider blocks"
}

check_sandbox_inference() {
  local payload payload_arg response rc=0 content
  payload=$(BEDROCK_MODEL="$BEDROCK_MODEL" python3 -c '
import json
import os

print(json.dumps({
    "model": os.environ["BEDROCK_MODEL"],
    "messages": [{"role": "user", "content": "Reply with exactly one word: PONG"}],
    "max_tokens": 32,
}))
')
  payload_arg="$(printf '%q' "$payload")"
  response=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "curl -sS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d $payload_arg" 2>&1) || rc=$?
  content=$(printf '%s' "$response" | parse_chat_content 2>/dev/null) || true
  if [ "$rc" -eq 0 ] && grep -qi "PONG" <<<"$content"; then
    pass "B7: sandbox inference.local chat completion returned PONG"
  else
    fail "B7: sandbox inference.local chat completion failed: ${response:0:400}"
  fi
}

check_openclaw_agent_turn() {
  local session_id remote_cmd raw reply rc=0
  session_id="bedrock-openclaw-e2e-$(date +%s)-$$"
  remote_cmd="rm -f /sandbox/.openclaw/agents/main/sessions/${session_id}.jsonl.lock /sandbox/.openclaw/agents/main/sessions/${session_id}.trajectory.jsonl 2>/dev/null || true; nemoclaw-start openclaw agent --agent main --json --session-id $(quote_for_remote_sh "$session_id") -m 'Reply with only: PONG'"
  raw=$(run_with_timeout 240 openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$remote_cmd" 2>&1) || rc=$?

  if printf '%s' "$raw" | grep -qiE "SsrFBlockedError|Blocked hostname|transport error|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error|bedrock_runtime_error"; then
    fail "B8: OpenClaw agent turn hit a provider or transport error"
    return
  fi

  reply=$(printf '%s' "$raw" | python3 -c '
import json
import sys

text = sys.stdin.read()
for idx, char in enumerate(text):
    if char != "{":
        continue
    try:
        doc = json.loads(text[idx:])
    except Exception:
        continue
    payloads = ((doc.get("result") or {}).get("payloads") or [])
    parts = [p.get("text") for p in payloads if isinstance(p, dict) and isinstance(p.get("text"), str)]
    print("\n".join(parts))
    break
' 2>/dev/null) || true

  if [ "$rc" -eq 0 ] && grep -qi "PONG" <<<"$reply"; then
    pass "B8: OpenClaw agent completed a Bedrock-backed turn through inference.local"
  else
    fail "B8: OpenClaw agent did not return PONG through Bedrock adapter"
  fi
}

check_hermes_api_chat() {
  local payload payload_arg response rc=0 content remote
  payload=$(BEDROCK_MODEL="$BEDROCK_MODEL" python3 -c '
import json
import os

print(json.dumps({
    "model": os.environ["BEDROCK_MODEL"],
    "messages": [{"role": "user", "content": "Reply with exactly one word: PONG"}],
    "max_tokens": 32,
}))
')
  payload_arg="$(printf '%q' "$payload")"
  remote="set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; if [ -n \"\${API_SERVER_KEY:-}\" ]; then curl -sS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H \"Authorization: Bearer \${API_SERVER_KEY}\" -d $payload_arg; else curl -sS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -d $payload_arg; fi"
  response=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$remote" 2>&1) || rc=$?
  content=$(printf '%s' "$response" | parse_chat_content 2>/dev/null) || true
  if [ "$rc" -eq 0 ] && grep -qi "PONG" <<<"$content"; then
    pass "B8: Hermes local chat API completed a Bedrock-backed turn through inference.local"
  else
    fail "B8: Hermes local chat API did not return PONG through Bedrock adapter: ${response:0:400}"
  fi
}

check_mock_observed_traffic() {
  local converse_count stream_count
  converse_count=$(grep -c "POST /model/converse auth=ok" "$BEDROCK_MOCK_LOG" 2>/dev/null || true)
  stream_count=$(grep -c "POST /model/converse-stream auth=ok" "$BEDROCK_MOCK_LOG" 2>/dev/null || true)
  if [ "$converse_count" -ge 1 ]; then
    pass "B9: fake Bedrock Runtime endpoint observed authenticated Converse traffic"
  else
    fail "B9: fake Bedrock Runtime endpoint did not observe authenticated Converse traffic"
  fi
  if [ "$AGENT" = "openclaw" ]; then
    if [ "$stream_count" -ge 1 ]; then
      pass "B10: fake Bedrock Runtime endpoint observed authenticated ConverseStream traffic"
    else
      fail "B10: fake Bedrock Runtime endpoint did not observe OpenClaw streamed traffic"
    fi
  fi
}

check_adapter_log_breadcrumbs() {
  if [ ! -f "$ADAPTER_LOG" ]; then
    fail "B11: Bedrock Runtime adapter host log was not written"
    return
  fi
  if grep -Fq '"event":"request_completed"' "$ADAPTER_LOG" \
    && grep -Fq '"operation":"converse"' "$ADAPTER_LOG" \
    && grep -Fq "$BEDROCK_MODEL" "$ADAPTER_LOG"; then
    if [ "$AGENT" = "openclaw" ]; then
      if grep -Fq '"operation":"converse_stream"' "$ADAPTER_LOG"; then
        pass "B11: Bedrock Runtime adapter host log records safe Converse and ConverseStream breadcrumbs"
      else
        fail "B11: Bedrock Runtime adapter host log did not record a ConverseStream breadcrumb"
      fi
    else
      pass "B11: Bedrock Runtime adapter host log records safe Converse breadcrumbs"
    fi
  else
    fail "B11: Bedrock Runtime adapter host log did not record expected request breadcrumbs"
  fi
}

collect_sandbox_snapshot() {
  local script
  script=$(
    cat <<'SH'
set +e
emit_file() {
  path="$1"
  [ -r "$path" ] || return 0
  size=$(wc -c <"$path" 2>/dev/null || echo 0)
  [ "$size" -le 1048576 ] || return 0
  printf '\n@@NEMOCLAW_E2E_FILE@@ %s\n' "$path"
  tr '\000' '\n' <"$path" 2>/dev/null || true
}

for root in /sandbox/.openclaw /sandbox/.hermes /etc/nemoclaw /tmp; do
  [ -e "$root" ] || continue
  find "$root" -maxdepth 4 -type f 2>/dev/null | while IFS= read -r file; do
    case "$file" in
      */node_modules/*|*/.git/*) continue ;;
    esac
    emit_file "$file"
  done
done

for proc_dir in /proc/[0-9]*; do
  [ -d "$proc_dir" ] || continue
  pid=$(basename "$proc_dir")
  for name in environ cmdline; do
    emit_file "$proc_dir/$name"
  done
done
SH
  )
  sandbox_exec_sh_script "$script"
}

scan_file_for_leaks() {
  local file_path="$1"
  local label="$2"
  PATTERN_FAKE_KEY="$COMPATIBLE_KEY" \
    PATTERN_ADAPTER_TOKEN="$ADAPTER_TOKEN" \
    PATTERN_AWS_ENV_NAME="AWS_BEARER_TOKEN_BEDROCK" \
    PATTERN_ADAPTER_ENV_NAME="NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN" \
    PATTERN_BEDROCK_HOST="$BEDROCK_HOSTNAME" \
    SCAN_FILE_PATH="$file_path" \
    SCAN_LABEL="$label" \
    python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["SCAN_FILE_PATH"])
label = os.environ["SCAN_LABEL"]
patterns = [
    ("fake user key", os.environ.get("PATTERN_FAKE_KEY", "")),
    ("adapter token", os.environ.get("PATTERN_ADAPTER_TOKEN", "")),
    ("AWS bearer env name", os.environ.get("PATTERN_AWS_ENV_NAME", "")),
    ("adapter token env name", os.environ.get("PATTERN_ADAPTER_ENV_NAME", "")),
    ("raw Bedrock hostname", os.environ.get("PATTERN_BEDROCK_HOST", "")),
]
current = label
locations = []
for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
    if raw.startswith("@@NEMOCLAW_E2E_FILE@@ "):
        current = raw.split(" ", 1)[1]
        continue
    for name, value in patterns:
        if value and value in raw:
            locations.append(f"{name}: {current}")

if locations:
    for item in sorted(set(locations)):
        print(item)
    raise SystemExit(1)
PY
}

scan_for_leaks() {
  local snapshot_file host_log_file scan_output rc=0
  ADAPTER_TOKEN="$(tr -d '\n' <"$HOME/.nemoclaw/bedrock-runtime-adapter-token" 2>/dev/null || true)"
  if [ -z "$ADAPTER_TOKEN" ]; then
    fail "B11: adapter token file was not created on the host"
    return
  fi

  snapshot_file="$(mktemp)"
  host_log_file="$(mktemp)"
  collect_sandbox_snapshot >"$snapshot_file" 2>/dev/null || true
  {
    printf '\n@@NEMOCLAW_E2E_FILE@@ %s\n' "$ONBOARD_LOG"
    [ -f "$ONBOARD_LOG" ] && cat "$ONBOARD_LOG"
    printf '\n@@NEMOCLAW_E2E_FILE@@ %s\n' "$ADAPTER_LOG"
    [ -f "$ADAPTER_LOG" ] && cat "$ADAPTER_LOG"
    printf '\n@@NEMOCLAW_E2E_FILE@@ %s\n' "$BEDROCK_MOCK_LOG"
    [ -f "$BEDROCK_MOCK_LOG" ] && cat "$BEDROCK_MOCK_LOG"
  } >"$host_log_file"

  scan_output=$(scan_file_for_leaks "$snapshot_file" "sandbox snapshot" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    scan_output=$(scan_file_for_leaks "$host_log_file" "host e2e logs" 2>&1) || rc=$?
  fi
  rm -f "$snapshot_file" "$host_log_file" 2>/dev/null || true

  if [ "$rc" -eq 0 ]; then
    pass "B12: sandbox configs, env, proc, and logs contain no Bedrock token or hostname leaks"
  else
    fail "B12: leak scan found forbidden Bedrock token or hostname locations"
    printf '%s\n' "$scan_output" | sed 's/^/    /'
  fi
}

# Repo root
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

AGENT="${NEMOCLAW_AGENT:-openclaw}"
case "$AGENT" in
  openclaw | hermes) ;;
  *)
    echo "ERROR: NEMOCLAW_AGENT must be openclaw or hermes, got '$AGENT'" >&2
    exit 2
    ;;
esac

BEDROCK_HOSTNAME="bedrock-runtime.us-east-1.amazonaws.com"
BEDROCK_MOCK_PORT="${NEMOCLAW_BEDROCK_RUNTIME_MOCK_PORT:-18147}"
BEDROCK_ADAPTER_PORT="${NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT:-11436}"
BEDROCK_ENDPOINT_URL="http://${BEDROCK_HOSTNAME}:${BEDROCK_MOCK_PORT}"
BEDROCK_MODEL="${NEMOCLAW_BEDROCK_RUNTIME_MODEL:-anthropic.claude-3-5-sonnet-20240620-v1:0}"
COMPATIBLE_KEY="${NEMOCLAW_BEDROCK_RUNTIME_FAKE_KEY:-fake-pasted-bedrock-runtime-key-e2e}"
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-bedrock-${AGENT}}"
ONBOARD_LOG="/tmp/nemoclaw-e2e-bedrock-runtime-${AGENT}-onboard.log"
BUILD_LOG="/tmp/nemoclaw-e2e-bedrock-runtime-${AGENT}-build.log"
BEDROCK_MOCK_LOG="/tmp/nemoclaw-e2e-bedrock-runtime-${AGENT}-mock.log"
ADAPTER_LOG="$HOME/.nemoclaw/bedrock-runtime-adapter.log"
BEDROCK_MOCK_PID=""
HOSTS_BACKUP=""
ADAPTER_TOKEN=""

trap cleanup EXIT

rm -f "$ADAPTER_LOG" 2>/dev/null || true

echo ""
echo "============================================================"
echo "  Bedrock Runtime Compatible Anthropic E2E (#3767)"
echo "  $(date)"
echo "============================================================"
echo ""

section "Phase 0: Prerequisites"
if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  summary
fi

if command -v python3 >/dev/null 2>&1; then
  pass "python3 is available"
else
  fail "python3 not found"
  summary
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ]; then
  pass "NEMOCLAW_NON_INTERACTIVE=1"
else
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  summary
fi

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
  pass "third-party software acceptance is set"
else
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  summary
fi

load_shell_path
info "Repo: $REPO"
info "Agent: $AGENT"
info "Sandbox: $SANDBOX_NAME"
info "Model: $BEDROCK_MODEL"

section "Phase 1: Source CLI and OpenShell"
if prepare_source_cli; then
  pass "B0: source CLI and OpenShell are ready"
else
  fail "B0: source CLI/OpenShell preparation failed"
  info "Last 120 lines of build/setup log:"
  tail -120 "$BUILD_LOG" 2>/dev/null || true
  summary
fi

section "Phase 2: Fake Bedrock Runtime endpoint"
map_bedrock_host_to_loopback
if start_bedrock_mock; then
  pass "B0: fake Bedrock Runtime endpoint started"
else
  fail "B0: fake Bedrock Runtime endpoint failed to start"
  info "Mock log:"
  sed 's/^/    /' "$BEDROCK_MOCK_LOG" 2>/dev/null || true
  summary
fi

section "Phase 3: Onboard"
run_bedrock_onboard

section "Phase 4: Boundary assertions"
assert_onboard_identity
assert_adapter_health
assert_openshell_provider_route
if [ "$AGENT" = "hermes" ]; then
  assert_hermes_config
else
  assert_openclaw_config
fi

section "Phase 5: Runtime requests"
check_sandbox_inference
if [ "$AGENT" = "hermes" ]; then
  check_hermes_api_chat
else
  check_openclaw_agent_turn
fi
check_mock_observed_traffic
check_adapter_log_breadcrumbs

section "Phase 6: Leak scan"
scan_for_leaks

trap - EXIT
cleanup
summary
