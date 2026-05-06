#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Kimi inference compatibility E2E (#2620 / #3046)
#
# Hermetic path:
#   - starts a local OpenAI-compatible mock endpoint
#   - onboards a fresh sandbox with moonshotai/kimi-k2.6 through inference.local
#   - the mock emits one combined Kimi exec tool call: hostname; date; uptime
#   - verifies the NemoClaw Kimi plugin splits it into three exec tool calls
#   - verifies the trajectory records exactly those three tool executions
#
# Environment:
#   NEMOCLAW_SANDBOX_NAME            - sandbox name (default: e2e-kimi-compat)
#   NEMOCLAW_KIMI_MOCK_PORT         - mock endpoint port (default: 18146)
#   NEMOCLAW_KIMI_MOCK_ENDPOINT_URL - optional endpoint URL for gateway provider
#   NEMOCLAW_E2E_KEEP_SANDBOX=1     - keep sandbox for debugging
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     bash test/e2e/test-kimi-inference-compat.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=2400
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
  echo "  Kimi Inference Compatibility E2E Results"
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

stop_kimi_mock() {
  if [ -n "${KIMI_MOCK_PID:-}" ] && kill -0 "$KIMI_MOCK_PID" 2>/dev/null; then
    kill "$KIMI_MOCK_PID" 2>/dev/null || true
    wait "$KIMI_MOCK_PID" 2>/dev/null || true
  fi
  KIMI_MOCK_PID=""
}

start_kimi_mock() {
  : >"$KIMI_MOCK_LOG"
  python3 - "$KIMI_MOCK_PORT" "$KIMI_MODEL" "$KIMI_MOCK_API_KEY" >"$KIMI_MOCK_LOG" 2>&1 <<'PY' &
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[1])
model = sys.argv[2]
api_key = sys.argv[3]


def chunk(chunk_id, delta, finish_reason=None):
    return {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_sse(self, chunks):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for item in chunks:
            self.wfile.write(("data: " + json.dumps(item) + "\n\n").encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")

    def _auth_ok(self):
        return self.headers.get("Authorization", "") == "Bearer " + api_key

    def do_GET(self):
        if self.path == "/v1/models":
            print("GET /v1/models", flush=True)
            self._send_json(200, {"object": "list", "data": [{"id": model, "object": "model"}]})
            return
        self._send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {}

        print(
            "POST %s auth=%s stream=%s tools=%s tool_results=%s model=%s"
            % (
                self.path,
                "ok" if self._auth_ok() else "missing",
                bool(payload.get("stream")),
                bool(payload.get("tools")),
                any(m.get("role") == "tool" for m in payload.get("messages", []) if isinstance(m, dict)),
                payload.get("model"),
            ),
            flush=True,
        )

        if self.path != "/v1/chat/completions":
            self._send_json(404, {"error": {"message": "not found"}})
            return
        if not self._auth_ok():
            self._send_json(401, {"error": {"message": "missing bearer credential"}})
            return

        request_text = json.dumps(payload)
        completion_id = "chatcmpl-kimi-e2e-%d" % int(time.time() * 1000)
        if "Reply with exactly: OK" in request_text:
            self._send_json(
                200,
                {
                    "id": completion_id,
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "OK"},
                            "finish_reason": "stop",
                        }
                    ],
                },
            )
            return

        has_tools = isinstance(payload.get("tools"), list) and len(payload.get("tools")) > 0
        has_tool_result = any(
            m.get("role") == "tool" for m in payload.get("messages", []) if isinstance(m, dict)
        )
        if has_tools and not has_tool_result:
            tool_call = {
                "index": 0,
                "id": "call_kimi_exec",
                "type": "function",
                "function": {
                    "name": "exec",
                    "arguments": json.dumps({"command": "hostname; date; uptime"}),
                },
            }
            if payload.get("stream"):
                self._send_sse(
                    [
                        chunk(completion_id, {"role": "assistant"}),
                        chunk(completion_id, {"tool_calls": [tool_call]}),
                        chunk(completion_id, {}, "tool_calls"),
                    ]
                )
            else:
                self._send_json(
                    200,
                    {
                        "id": completion_id,
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": None,
                                    "tool_calls": [
                                        {
                                            "id": tool_call["id"],
                                            "type": tool_call["type"],
                                            "function": tool_call["function"],
                                        }
                                    ],
                                },
                                "finish_reason": "tool_calls",
                            }
                        ],
                    },
                )
            return

        final_text = "hostname, date, and uptime completed successfully."
        if payload.get("stream"):
            self._send_sse(
                [
                    chunk(completion_id, {"role": "assistant"}),
                    chunk(completion_id, {"content": final_text}),
                    chunk(completion_id, {}, "stop"),
                ]
            )
        else:
            self._send_json(
                200,
                {
                    "id": completion_id,
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": final_text},
                            "finish_reason": "stop",
                        }
                    ],
                },
            )


ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
PY
  KIMI_MOCK_PID=$!

  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${KIMI_MOCK_PORT}/v1/models" >/dev/null 2>&1; then
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

  if [ ! -f "$REPO/dist/nemoclaw.js" ]; then
    info "Installing npm dependencies and building source CLI"
    (
      cd "$REPO" \
        && npm ci --ignore-scripts \
        && npm run build:cli
    ) >>"$BUILD_LOG" 2>&1 || rc=$?
    if [ "$rc" -ne 0 ]; then
      return "$rc"
    fi
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

cleanup() {
  stop_kimi_mock
  rm -f "$KIMI_MOCK_LOG" 2>/dev/null || true
  destroy_sandbox_best_effort
}

run_kimi_onboard() {
  local onboard_exit=0
  local prep_exit=0
  export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
  export NEMOCLAW_RECREATE_SANDBOX=1
  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
  export NEMOCLAW_YES=1
  export NEMOCLAW_PROVIDER=custom
  export NEMOCLAW_ENDPOINT_URL="$KIMI_ENDPOINT_URL"
  export NEMOCLAW_MODEL="$KIMI_MODEL"
  export NEMOCLAW_PREFERRED_API=openai-completions
  export NEMOCLAW_POLICY_TIER=restricted
  export NEMOCLAW_POLICY_MODE=skip
  export COMPATIBLE_API_KEY="$KIMI_MOCK_API_KEY"
  unset NVIDIA_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY
  unset TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN

  prepare_source_cli || prep_exit=$?
  if [ "$prep_exit" -ne 0 ]; then
    fail "K1: source CLI/OpenShell preparation failed (exit $prep_exit)"
    info "Last 100 lines of build/setup log:"
    tail -100 "$BUILD_LOG" 2>/dev/null || true
    summary
  fi

  destroy_sandbox_best_effort
  info "Using source-built CLI at $REPO/bin/nemoclaw.js"
  run_with_timeout 1500 node "$REPO/bin/nemoclaw.js" onboard --fresh --non-interactive --yes-i-accept-third-party-software \
    >"$ONBOARD_LOG" 2>&1 || onboard_exit=$?

  if [ "$onboard_exit" -eq 0 ]; then
    pass "K1: onboard completed for Kimi compatible endpoint sandbox"
  else
    fail "K1: onboard failed (exit $onboard_exit)"
    info "Last 100 lines of onboard log:"
    tail -100 "$ONBOARD_LOG" 2>/dev/null || true
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
    if inference.get("api") != "openai-completions":
        errors.append("inference api is %r" % inference.get("api"))
    models = inference.get("models") or []
    selected = next((m for m in models if m.get("id") == model), None)
    if not selected:
        errors.append("Kimi model entry is missing")
    else:
        compat = selected.get("compat") or {}
        for key, expected in {
            "supportsStore": False,
            "requiresStringContent": True,
            "maxTokensField": "max_tokens",
            "requiresToolResultName": True,
        }.items():
            if compat.get(key) != expected:
                errors.append("compat[%s] is %r" % (key, compat.get(key)))
primary = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary")
if primary != "inference/" + model:
    errors.append("primary model is %r" % primary)
plugins = cfg.get("plugins", {})
paths = plugins.get("load", {}).get("paths", [])
entries = plugins.get("entries", {})
if "/usr/local/share/nemoclaw/openclaw-plugins/kimi-inference-compat" not in paths:
    errors.append("Kimi plugin load path missing")
if not entries.get("nemoclaw-kimi-inference-compat", {}).get("enabled"):
    errors.append("Kimi plugin entry is not enabled")
print(json.dumps({
    "provider_keys": sorted(providers.keys()) if isinstance(providers, dict) else [],
    "primary": primary,
    "plugin_enabled": entries.get("nemoclaw-kimi-inference-compat", {}).get("enabled"),
    "errors": errors,
}))
sys.exit(1 if errors else 0)
PY
SH
  )
  output=$(sandbox_exec_sh_script "$script" "$KIMI_MODEL" 2>&1) || rc=$?
  info "OpenClaw config summary: ${output:0:800}"
  if [ "$rc" -eq 0 ]; then
    pass "K2: openclaw.json has managed Kimi compat and plugin wiring"
  else
    fail "K2: openclaw.json Kimi compat/plugin wiring is wrong"
  fi
}

check_inference_route() {
  local response rc=0
  response=$(openshell sandbox exec --name "$SANDBOX_NAME" -- curl -sk --connect-timeout 5 --max-time 20 https://inference.local/v1/models 2>&1) || rc=$?
  if [ "$rc" -eq 0 ] && echo "$response" | grep -q "$KIMI_MODEL"; then
    pass "K3: sandbox inference.local models route reaches Kimi mock"
  else
    fail "K3: sandbox inference.local models route failed (${response:0:400})"
  fi
}

run_agent_prompt() {
  local prompt remote_cmd agent_exit=0
  prompt="Use the exec tool to run hostname, date, and uptime. Run each command and then say exactly: hostname, date, and uptime completed successfully."
  remote_cmd="rm -f /sandbox/.openclaw/agents/main/sessions/${SESSION_ID}.jsonl.lock /sandbox/.openclaw/agents/main/sessions/${SESSION_ID}.trajectory.jsonl 2>/dev/null || true; nemoclaw-start openclaw agent --agent main --json --session-id $(quote_for_remote_sh "$SESSION_ID") -m $(quote_for_remote_sh "$prompt")"
  run_with_timeout 420 openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$remote_cmd" >"$AGENT_LOG" 2>&1 || agent_exit=$?
  if [ "$agent_exit" -eq 0 ] && grep -q "hostname, date, and uptime completed successfully." "$AGENT_LOG"; then
    pass "K4: OpenClaw agent completed after Kimi tool results"
  else
    fail "K4: OpenClaw agent did not complete successfully (exit $agent_exit)"
    info "Agent log tail:"
    tail -120 "$AGENT_LOG" 2>/dev/null || true
  fi
}

extract_runtime_session_id() {
  python3 - "$AGENT_LOG" <<'PY' 2>/dev/null || true
import json
import sys

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
for idx, ch in enumerate(text):
    if ch != "{":
        continue
    try:
        data = json.loads(text[idx:])
    except Exception:
        continue
    sid = (
        data.get("result", {})
        .get("meta", {})
        .get("agentMeta", {})
        .get("sessionId")
    )
    if sid:
        print(sid)
        break
PY
}

check_trajectory_acceptance() {
  local output rc=0 script runtime_session_id
  runtime_session_id="$(extract_runtime_session_id)"
  script=$(
    cat <<'SH'
python3 - "$1" "$2" <<'PY'
import json
import pathlib
import sys

explicit_sid = sys.argv[1]
runtime_sid = sys.argv[2] if len(sys.argv) > 2 else ""
candidate_sids = [sid for sid in [runtime_sid, explicit_sid] if sid]
root = pathlib.Path("/sandbox/.openclaw")
base = pathlib.Path("/sandbox/.openclaw/agents/main/sessions")


def add_candidate(pairs, session_path, trajectory_path, label):
    key = (str(session_path), str(trajectory_path))
    if key not in {item[:2] for item in pairs}:
        pairs.append((str(session_path), str(trajectory_path), label))


pairs = []
for sid in candidate_sids:
    add_candidate(pairs, base / (sid + ".jsonl"), base / (sid + ".trajectory.jsonl"), sid)

for trajectory_path in root.rglob("*.trajectory.jsonl"):
    stem = trajectory_path.name[: -len(".trajectory.jsonl")]
    add_candidate(pairs, trajectory_path.with_name(stem + ".jsonl"), trajectory_path, "recursive")

session_path = None
trajectory_path = None
for session_candidate, trajectory_candidate, _label in pairs:
    maybe_session = pathlib.Path(session_candidate)
    maybe_trajectory = pathlib.Path(trajectory_candidate)
    if maybe_session.exists() and maybe_trajectory.exists():
        session_path = maybe_session
        trajectory_path = maybe_trajectory
        break

if not session_path or not trajectory_path:
    diagnostic = {
        "errors": ["missing session/trajectory jsonl pair"],
        "explicitSessionId": explicit_sid,
        "runtimeSessionId": runtime_sid,
        "checkedPairs": pairs[:20],
        "sessionFiles": [str(p) for p in root.rglob("*.jsonl")][:40],
        "trajectoryFiles": [str(p) for p in root.rglob("*.trajectory.jsonl")][:40],
    }
    print(json.dumps(diagnostic, indent=2))
    sys.exit(1)

session = [json.loads(line) for line in session_path.read_text().splitlines() if line.strip()]
trajectory = [json.loads(line) for line in trajectory_path.read_text().splitlines() if line.strip()]
errors = []
artifacts = [item for item in trajectory if item.get("type") == "trace.artifacts"]
completed = [item for item in trajectory if item.get("type") == "model.completed"]
if len(artifacts) != 1:
    errors.append("expected 1 trace.artifacts record, got %d" % len(artifacts))
artifact_data = artifacts[-1].get("data", {}) if artifacts else {}
completed_data = completed[-1].get("data", {}) if completed else {}
metas = artifact_data.get("toolMetas", [])
assistant_tool_messages = [
    item.get("message", {})
    for item in session
    if item.get("type") == "message"
    and item.get("message", {}).get("role") == "assistant"
    and any(block.get("type") == "toolCall" for block in item.get("message", {}).get("content", []))
]
source_calls = assistant_tool_messages[-1].get("content", []) if assistant_tool_messages else []
source_commands = [block.get("arguments", {}).get("command") for block in source_calls]
messages = [item.get("message", {}) for item in session if item.get("type") == "message"]
tool_result_indices = [idx for idx, msg in enumerate(messages) if msg.get("role") == "toolResult"]
assistant_indices = [idx for idx, msg in enumerate(messages) if msg.get("role") == "assistant"]
raw = session_path.read_text() + "\n" + trajectory_path.read_text()

if artifact_data.get("finalStatus") != "success":
    errors.append("finalStatus is %r" % artifact_data.get("finalStatus"))
if len(metas) != 3:
    errors.append("expected 3 trace.artifacts.toolMetas, got %d" % len(metas))
if [meta.get("toolName") for meta in metas] != ["exec", "exec", "exec"]:
    errors.append("toolMeta tool names are %r" % [meta.get("toolName") for meta in metas])
if sorted(meta.get("meta") for meta in metas) != ["date", "hostname", "uptime"]:
    errors.append("toolMeta command set is %r" % sorted(meta.get("meta") for meta in metas))
if source_commands != ["hostname", "date", "uptime"]:
    errors.append("source assistant command order is %r" % source_commands)
if any(isinstance(command, str) and ";" in command for command in source_commands):
    errors.append("source assistant still contains a combined semicolon command")
if artifact_data.get("promptErrorSource") is not None:
    errors.append("promptErrorSource is %r" % artifact_data.get("promptErrorSource"))
if completed_data.get("promptErrorSource") is not None:
    errors.append("model.completed promptErrorSource is %r" % completed_data.get("promptErrorSource"))
for field in ["aborted", "externalAbort", "timedOut", "idleTimedOut", "timedOutDuringCompaction"]:
    if artifact_data.get(field):
        errors.append("%s is %r" % (field, artifact_data.get(field)))
if "abandoned" in raw.lower():
    errors.append("trajectory/session contains 'abandoned'")
if "want me to continue" in raw.lower():
    errors.append("trajectory/session contains 'want me to continue'")
final_texts = artifact_data.get("assistantTexts") or []
if not final_texts or final_texts[-1] != "hostname, date, and uptime completed successfully.":
    errors.append("final assistant text is %r" % (final_texts[-1] if final_texts else None))
if not tool_result_indices or not assistant_indices or max(assistant_indices) <= max(tool_result_indices):
    errors.append("final assistant response did not occur after all tool results")

summary = {
    "explicitSessionId": explicit_sid,
    "runtimeSessionId": runtime_sid,
    "sessionPath": str(session_path),
    "trajectoryPath": str(trajectory_path),
    "finalStatus": artifact_data.get("finalStatus"),
    "toolMetasCount": len(metas),
    "toolMetaToolNames": [meta.get("toolName") for meta in metas],
    "toolMetaCommandSet": sorted(meta.get("meta") for meta in metas),
    "sourceAssistantCommands": source_commands,
    "sourceHasCombinedSemicolonCommand": any(isinstance(command, str) and ";" in command for command in source_commands),
    "promptErrorSource": artifact_data.get("promptErrorSource"),
    "containsAbandoned": "abandoned" in raw.lower(),
    "containsWantMeToContinue": "want me to continue" in raw.lower(),
    "finalAssistantText": final_texts[-1] if final_texts else None,
    "finalAssistantAfterAllToolResults": bool(tool_result_indices and assistant_indices and max(assistant_indices) > max(tool_result_indices)),
    "messageRoles": [msg.get("role") for msg in messages],
    "errors": errors,
}
print(json.dumps(summary, indent=2))
sys.exit(1 if errors else 0)
PY
SH
  )
  output=$(sandbox_exec_sh_script "$script" "$SESSION_ID" "$runtime_session_id" 2>&1) || rc=$?
  info "Trajectory summary:"
  printf '%s\n' "$output" | sed 's/^/    /'
  if [ "$rc" -eq 0 ]; then
    pass "K5: trajectory proves split Kimi exec calls completed cleanly"
  else
    fail "K5: trajectory acceptance checks failed"
  fi
}

check_mock_observed_agent_traffic() {
  local stream_count
  stream_count=$(grep -c "POST /v1/chat/completions auth=ok stream=True" "$KIMI_MOCK_LOG" 2>/dev/null || true)
  if [ "$stream_count" -ge 2 ]; then
    pass "K6: Kimi mock observed authenticated streamed tool-call and final-answer traffic"
  else
    fail "K6: Kimi mock did not observe both streamed agent requests"
    info "Mock log:"
    sed 's/^/    /' "$KIMI_MOCK_LOG" 2>/dev/null || true
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-kimi-compat}"
KIMI_MOCK_PORT="${NEMOCLAW_KIMI_MOCK_PORT:-18146}"
KIMI_MODEL="${NEMOCLAW_KIMI_MODEL:-moonshotai/kimi-k2.6}"
KIMI_MOCK_API_KEY="${NEMOCLAW_KIMI_MOCK_API_KEY:-fake-kimi-compatible-key-e2e}"
KIMI_MOCK_HOST="${NEMOCLAW_KIMI_MOCK_HOST:-host.openshell.internal}"
KIMI_ENDPOINT_URL="${NEMOCLAW_KIMI_MOCK_ENDPOINT_URL:-http://${KIMI_MOCK_HOST}:${KIMI_MOCK_PORT}/v1}"
SESSION_ID="${NEMOCLAW_KIMI_SESSION_ID:-kimi-e2e-$(date +%s)}"
KIMI_MOCK_LOG="$(mktemp)"
ONBOARD_LOG="/tmp/nemoclaw-e2e-kimi-inference-compat-onboard.log"
AGENT_LOG="/tmp/nemoclaw-e2e-kimi-inference-compat-agent.log"
BUILD_LOG="/tmp/nemoclaw-e2e-kimi-inference-compat-build.log"
KIMI_MOCK_PID=""

trap cleanup EXIT

echo ""
echo "============================================================"
echo "  Kimi Inference Compatibility E2E (#2620 / #3046)"
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
info "Model: $KIMI_MODEL"
info "Mock endpoint URL for gateway: $KIMI_ENDPOINT_URL"

section "Phase 1: Kimi-compatible mock endpoint"
if start_kimi_mock; then
  pass "K0: Kimi-compatible mock endpoint started"
else
  fail "K0: Kimi-compatible mock endpoint failed to start"
  info "Mock log:"
  sed 's/^/    /' "$KIMI_MOCK_LOG" 2>/dev/null || true
  summary
fi

section "Phase 2: Onboard fresh Kimi sandbox"
run_kimi_onboard

section "Phase 3: Runtime assertions"
check_openclaw_config
check_inference_route
run_agent_prompt
check_trajectory_acceptance
check_mock_observed_agent_traffic

trap - EXIT
cleanup
summary
