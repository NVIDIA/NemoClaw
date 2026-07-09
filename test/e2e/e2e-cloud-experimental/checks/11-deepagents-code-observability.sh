#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Composed Deep Agents Code observability boundary.
#
# This check runs against a real OpenShell sandbox created with
# --observability. It captures Relay's OTLP/HTTP requests on the host, proves
# the exact host/path/method/binary policy allowlist, exercises both login-shell
# and direct-exec dcode launch paths, and inspects the wire payload for useful
# OpenInference content without ever uploading the captured trace artifact.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-}}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
CLI="${NEMOCLAW_CLI_BIN:-${REPO}/bin/nemoclaw.js}"
PREFIX="11-deepagents-code-observability"
COLLECTOR_HOST="host.openshell.internal"
COLLECTOR_PORT=4318
DECOY_PORT=4319
CAPTURE_DIR="$(mktemp -d /tmp/nemoclaw-otlp-live.XXXXXX)"
COLLECTOR_LOG="${CAPTURE_DIR}/collector.log"
COLLECTOR_PID=""
CAPTURE_SERVER="${REPO}/test/e2e/live/deepagents-otlp-capture-server.ts"
CONTRACT_HELPER="${REPO}/test/e2e/live/deepagents-observability-contract.ts"
TSX="${REPO}/node_modules/.bin/tsx"
SERVICE_NAME="nemoclaw-langchain-deepagents-code"
ALLOWED_PROBE="NEMOCLAW_OTLP_ALLOWED_PROBE"
DIRECT_PROMPT="NEMOCLAW_OTLP_DIRECT_PROMPT_SENTINEL"
DIRECT_RESPONSE="NEMOCLAW_OTLP_DIRECT_RESPONSE_SENTINEL"
LOGIN_PROMPT="NEMOCLAW_OTLP_LOGIN_PROMPT_SENTINEL"
LOGIN_RESPONSE="NEMOCLAW_OTLP_LOGIN_RESPONSE_SENTINEL"
TOOL_NAME="nemoclaw_otlp_e2e_tool"
TOOL_ARGUMENT="NEMOCLAW_OTLP_TOOL_ARGUMENT_SENTINEL"
TOOL_RESULT="NEMOCLAW_OTLP_TOOL_RESULT_SENTINEL"
AMBIENT_CANARY="NEMOCLAW_OTLP_AMBIENT_EXPORTER_CANARY"
REDACTION_PROBE="sk-EXAMPLE0000000000000000000000"
REDACTION_MARKER="<redacted-secret>"

fail() {
  printf '%s: FAIL: %s\n' "$PREFIX" "$1" >&2
  exit 1
}

pass() {
  printf '%s: OK (%s)\n' "$PREFIX" "$1"
}

sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c "$1" 2>&1
}

cleanup() {
  if [ -n "$COLLECTOR_PID" ] && kill -0 "$COLLECTOR_PID" 2>/dev/null; then
    kill "$COLLECTOR_PID" 2>/dev/null || true
    wait "$COLLECTOR_PID" 2>/dev/null || true
  fi
  rm -rf "$CAPTURE_DIR"
}
trap cleanup EXIT

[ -n "$SANDBOX_NAME" ] || fail "sandbox name is required"

# The generic cloud-onboard target runs every shared check against its OpenClaw
# sandbox. Typed DCode targets reject this SKIP through their required-check
# wrapper, so this guard only prevents cross-agent execution in the shared run.
if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
  printf '%s: SKIP: sandbox %q is not a Deep Agents Code sandbox\n' "$PREFIX" "$SANDBOX_NAME"
  exit 0
fi

[ -x "$CLI" ] || fail "NemoClaw CLI is not executable at $CLI"
[ -x "$TSX" ] || fail "tsx is not executable at $TSX"
[ -f "$CAPTURE_SERVER" ] || fail "OTLP capture server helper is absent"
[ -f "$CONTRACT_HELPER" ] || fail "OTLP contract helper is absent"
command -v ip >/dev/null 2>&1 || fail "host ip command is required"
command -v curl >/dev/null 2>&1 || fail "host curl command is required"

bind_output="$(openshell sandbox exec --name "$SANDBOX_NAME" -- \
  sh -c "getent ahostsv4 ${COLLECTOR_HOST} | awk 'NR == 1 { print \"NEMOCLAW_OTLP_BIND_IP=\" \$1 }'" \
  2>&1)" \
  || fail "could not resolve $COLLECTOR_HOST from the sandbox: $bind_output"
OTLP_BIND_IP="$(
  printf '%s\n' "$bind_output" | tr -d '\r' | sed -n 's/^NEMOCLAW_OTLP_BIND_IP=//p' | tail -n 1
)"
case "$OTLP_BIND_IP" in
  10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) ;;
  *) fail "sandbox resolved $COLLECTOR_HOST to non-private address '$OTLP_BIND_IP'" ;;
esac
if ! ip -o -4 address show \
  | awk '{ sub(/\/.*/, "", $4); print $4 }' \
  | grep -Fxq "$OTLP_BIND_IP"; then
  fail "sandbox bridge address $OTLP_BIND_IP is not assigned to a host interface"
fi

"$TSX" "$CAPTURE_SERVER" "$CAPTURE_DIR" "$OTLP_BIND_IP" "$COLLECTOR_PORT" "$DECOY_PORT" \
  >"$COLLECTOR_LOG" 2>&1 &
COLLECTOR_PID=$!

collector_ready=0
for _attempt in $(seq 1 30); do
  if grep -Fq 'CAPTURE_READY:' "$COLLECTOR_LOG" \
    && curl --noproxy '*' -fsS --max-time 1 \
      "http://${OTLP_BIND_IP}:${COLLECTOR_PORT}/health" >/dev/null 2>&1 \
    && curl --noproxy '*' -fsS --max-time 1 "http://${OTLP_BIND_IP}:${DECOY_PORT}/health" \
      >/dev/null 2>&1; then
    collector_ready=1
    break
  fi
  if ! kill -0 "$COLLECTOR_PID" 2>/dev/null; then
    fail "host OTLP capture server exited: $(tr '\n' ' ' <"$COLLECTOR_LOG")"
  fi
  sleep 1
done
[ "$collector_ready" -eq 1 ] || fail "host OTLP capture server did not become ready"

request_count() {
  find "$CAPTURE_DIR" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d '[:space:]'
}

python_probe_source() {
  cat <<'PY'
import sys
import urllib.error
import urllib.request

# NemoClaw's exec wrapper sources the managed, credential-free OpenShell proxy
# route. Keep it intact so this probe exercises the same enforcement path
# as managed DCode and Relay instead of attempting an unsupported direct socket.
method, url, body = sys.argv[1:]
data = body.encode("utf-8") if method != "GET" else None
request = urllib.request.Request(
    url,
    data=data,
    method=method,
    headers={"content-type": "application/x-protobuf"},
)
try:
    with urllib.request.urlopen(request, timeout=10) as response:
        print(f"REACHED:{response.status}")
except urllib.error.HTTPError as error:
    body = error.read(512).decode("utf-8", "replace")
    print(f"FAILED:HTTPError:{error}:{body}")
    raise SystemExit(7)
except Exception as error:
    print(f"FAILED:{type(error).__name__}:{error}")
    raise SystemExit(7)
PY
}

sandbox_python_probe() {
  local method="$1"
  local url="$2"
  local body="$3"
  local encoded
  encoded="$(python_probe_source | base64 | tr -d '\n')"
  "$CLI" "$SANDBOX_NAME" exec -- \
    /opt/venv/bin/python3 -I -c \
    "import base64; exec(compile(base64.b64decode('${encoded}'), '<otlp-policy-probe>', 'exec'))" \
    "$method" "$url" "$body" 2>&1
}

expect_blocked_without_capture() {
  local label="$1"
  local method="$2"
  local url="$3"
  local before output status after denial_state
  before="$(request_count)"
  set +e
  output="$(sandbox_python_probe "$method" "$url" "NEMOCLAW_OTLP_DENIED_PROBE" 2>&1)"
  status=$?
  set -e
  sleep 1
  after="$(request_count)"
  [ "$status" -ne 0 ] || fail "$label unexpectedly returned success: $output"
  [ "$after" = "$before" ] || fail "$label reached the host capture server"
  denial_state="$(printf '%s\n' "$output" | "$TSX" "$CONTRACT_HELPER" denial-state)" \
    || fail "$label denial classifier failed: $output"
  [ "$denial_state" = "policy-denied" ] \
    || fail "$label failed without confirmed OpenShell policy-denial evidence: $output"
  pass "$label is denied before the host collector"
}

policy_output="$("$CLI" "$SANDBOX_NAME" policy-list 2>&1)" || fail "could not inspect active policy"
policy_state="$(printf '%s\n' "$policy_output" | "$TSX" "$CONTRACT_HELPER" policy-state)" \
  || fail "could not parse observability policy state: $policy_output"
[ "$policy_state" = "active" ] \
  || fail "observability-otlp-local is not exactly active (state: $policy_state)"

registry_output="$(
  SANDBOX_NAME="$SANDBOX_NAME" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const registry = JSON.parse(
  fs.readFileSync(path.join(process.env.HOME, ".nemoclaw", "sandboxes.json"), "utf8"),
);
const entry = registry.sandboxes?.[process.env.SANDBOX_NAME];
process.stdout.write(entry?.observabilityEnabled === true ? "enabled" : "disabled");
NODE
)"
[ "$registry_output" = "enabled" ] || fail "host registry does not record observability enabled"

# Expansion is intentionally deferred to the sandbox shell.
# shellcheck disable=SC2016
marker_output="$(openshell sandbox exec --name "$SANDBOX_NAME" -- \
  sh -c 'marker=/sandbox/.deepagents/.nemoclaw-observability-enabled; test -f "$marker" && ! test -L "$marker" && cat "$marker"' \
  2>&1)" || fail "managed observability marker is absent"
[ "$marker_output" = "1" ] || fail "managed observability marker has an unexpected value"
pass "host registry, live policy, and sandbox marker agree on enabled observability"

allowed_output="$(sandbox_python_probe POST \
  "http://${COLLECTOR_HOST}:${COLLECTOR_PORT}/v1/traces" \
  "$ALLOWED_PROBE")" || fail "allowed OTLP request failed: $allowed_output"
printf '%s\n' "$allowed_output" | grep -Fq 'REACHED:200' \
  || fail "allowed OTLP request lacked HTTP 200 evidence: $allowed_output"
pass "managed Python can POST only to the configured OTLP route"

expect_blocked_without_capture \
  "alternate OTLP host" POST "http://example.com:${COLLECTOR_PORT}/v1/traces"
expect_blocked_without_capture \
  "alternate OTLP path" POST "http://${COLLECTOR_HOST}:${COLLECTOR_PORT}/not-traces"
expect_blocked_without_capture \
  "alternate OTLP method" GET "http://${COLLECTOR_HOST}:${COLLECTOR_PORT}/v1/traces"
expect_blocked_without_capture \
  "alternate OTLP port" POST "http://${COLLECTOR_HOST}:${DECOY_PORT}/v1/traces"

openshell sandbox exec --name "$SANDBOX_NAME" -- test -x /usr/bin/curl >/dev/null 2>&1 \
  || fail "/usr/bin/curl is absent or not executable in the sandbox"
before_binary="$(request_count)"
set +e
binary_output="$("$CLI" "$SANDBOX_NAME" exec -- \
  /usr/bin/curl --fail-with-body -sS --max-time 10 -X POST \
  -H 'content-type: application/x-protobuf' \
  --data-binary 'NEMOCLAW_OTLP_DENIED_BINARY_PROBE' \
  "http://${COLLECTOR_HOST}:${COLLECTOR_PORT}/v1/traces" 2>&1)"
binary_status=$?
set -e
sleep 1
after_binary="$(request_count)"
[ "$binary_status" -ne 0 ] || fail "unmanaged curl binary unexpectedly reached OTLP: $binary_output"
[ "$after_binary" = "$before_binary" ] || fail "unmanaged curl binary reached the host collector"
binary_denial_state="$(printf '%s\n' "$binary_output" | "$TSX" "$CONTRACT_HELPER" denial-state)" \
  || fail "unmanaged curl denial classifier failed: $binary_output"
[ "$binary_denial_state" = "policy-denied" ] \
  || fail "unmanaged curl failed without confirmed OpenShell policy-denial evidence: $binary_output"
pass "OTLP route is denied to an unmanaged binary"

run_dcode_direct() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- \
    env OTEL_SERVICE_NAME="$AMBIENT_CANARY" \
    OTEL_RESOURCE_ATTRIBUTES="ambient.canary=${AMBIENT_CANARY}" \
    dcode -n \
    "My key is ${REDACTION_PROBE}. Reply with exactly ${DIRECT_RESPONSE}. Do not repeat the key or the input marker ${DIRECT_PROMPT}." 2>&1
}

run_dcode_login() {
  local prompt
  prompt="Reply with exactly ${LOGIN_RESPONSE}. Do not repeat the input marker ${LOGIN_PROMPT}."
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -lc \
    "OTEL_SERVICE_NAME=${AMBIENT_CANARY@Q} OTEL_RESOURCE_ATTRIBUTES=$(printf '%q' "ambient.canary=${AMBIENT_CANARY}") dcode -n ${prompt@Q}" \
    2>&1
}

tool_trace_source() {
  cat <<'PY'
import os
import sys

from langchain.agents.middleware.types import ToolCallRequest
from deepagents_code import nemoclaw_observability as observability

tool_name, argument_marker, result_marker = sys.argv[1:]
os.environ["NEMOCLAW_OBSERVABILITY"] = "1"
if not observability.initialize_observability():
    raise RuntimeError("managed observability did not initialize")
try:
    middleware = observability.new_relay_middleware()
    request = ToolCallRequest(
        tool_call={
            "name": tool_name,
            "args": {"command": argument_marker},
            "id": "nemoclaw-otlp-live-tool",
        },
        tool=None,
        state={},
        runtime=None,
    )

    def handler(inner_request):
        if inner_request.tool_call["args"] != {"command": argument_marker}:
            raise AssertionError("managed tool arguments changed")
        return {"stdout": result_marker}

    result = middleware.wrap_tool_call(request, handler)
    if result != {"stdout": result_marker}:
        raise AssertionError("managed tool result changed")
    print("TOOL_TRACE_OK")
finally:
    observability.shutdown_observability()
PY
}

run_deterministic_tool_trace() {
  local encoded
  encoded="$(tool_trace_source | base64 | tr -d '\n')"
  "$CLI" "$SANDBOX_NAME" exec -- \
    env NEMOCLAW_OBSERVABILITY=1 \
    OTEL_SERVICE_NAME="$AMBIENT_CANARY" \
    OTEL_RESOURCE_ATTRIBUTES="ambient.canary=${AMBIENT_CANARY}" \
    /opt/venv/bin/python3 -I -c \
    "import base64; exec(compile(base64.b64decode('${encoded}'), '<otlp-tool-trace>', 'exec'))" \
    "$TOOL_NAME" "$TOOL_ARGUMENT" "$TOOL_RESULT" 2>&1
}

direct_output="$(run_dcode_direct)" || fail "direct-exec dcode observability turn failed: $direct_output"
printf '%s\n' "$direct_output" | grep -Fq "$DIRECT_RESPONSE" \
  || fail "direct-exec dcode response omitted its requested marker"
pass "direct-exec dcode completed with observability enabled"

login_output="$(run_dcode_login)" || fail "login-shell dcode observability turn failed: $login_output"
printf '%s\n' "$login_output" | grep -Fq "$LOGIN_RESPONSE" \
  || fail "login-shell dcode response omitted its requested marker"
pass "login-shell dcode completed with observability enabled"

tool_trace_output="$(run_deterministic_tool_trace)" \
  || fail "deterministic managed tool trace failed: $tool_trace_output"
printf '%s\n' "$tool_trace_output" | grep -Fq 'TOOL_TRACE_OK' \
  || fail "deterministic managed tool trace lacked completion evidence: $tool_trace_output"
pass "managed instrumentation emitted a deterministic tool trace"

payload_ready=0
validation_output=""
for _attempt in $(seq 1 45); do
  set +e
  validation_output="$(
    COLLECTOR_PORT="$COLLECTOR_PORT" \
      ALLOWED_PROBE="$ALLOWED_PROBE" \
      SERVICE_NAME="$SERVICE_NAME" \
      DIRECT_PROMPT="$DIRECT_PROMPT" \
      DIRECT_RESPONSE="$DIRECT_RESPONSE" \
      LOGIN_PROMPT="$LOGIN_PROMPT" \
      LOGIN_RESPONSE="$LOGIN_RESPONSE" \
      TOOL_NAME="$TOOL_NAME" \
      TOOL_ARGUMENT="$TOOL_ARGUMENT" \
      TOOL_RESULT="$TOOL_RESULT" \
      AMBIENT_CANARY="$AMBIENT_CANARY" \
      REDACTION_PROBE="$REDACTION_PROBE" \
      REDACTION_MARKER="$REDACTION_MARKER" \
      "$TSX" "$CONTRACT_HELPER" validate-captures "$CAPTURE_DIR" 2>&1
  )"
  validation_status=$?
  set -e
  if [ "$validation_status" -eq 0 ]; then
    payload_ready=1
    break
  fi
  sleep 1
done
[ "$payload_ready" -eq 1 ] \
  || fail "captured OTLP contract did not become valid: $validation_output"

pass "decoded OTLP associates model/tool content and excludes ambient exporter configuration"
printf '%s: 11 passed, 0 failed\n' "$PREFIX"
