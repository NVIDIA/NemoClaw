#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# E2E: onboard negative and edge-case paths.
#
# Regression coverage for issue #2573. The nightly happy-path onboard test
# should not be the only place that exercises non-interactive validation.
#
# Scenarios:
#   1. NEMOCLAW_POLICY_MODE=restricted falls back to tier suggestions.
#   2. NEMOCLAW_POLICY_MODE=nonexistent falls back to tier suggestions.
#   3. Invalid NVIDIA API key format is rejected without a stack trace.
#   4. Non-NVIDIA provider keys are not forced to use nvapi-.
#   5. A host listener on the configured gateway port produces a friendly conflict.
#   6. Custom non-interactive policy presets are applied.
#   7. NEMOCLAW_PROVIDER=cloud and NEMOCLAW_MODEL are honored.
#   8. --from without --name/NEMOCLAW_SANDBOX_NAME fails before defaulting.
#   9. --from with NEMOCLAW_SANDBOX_NAME proceeds past entry validation.

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1800
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

LOG_FILE="${NEMOCLAW_E2E_LOG:-/tmp/nemoclaw-e2e-onboard-negative-paths.log}"
exec > >(tee "$LOG_FILE") 2>&1

PASS=0
FAIL=0
SKIP=0
TOTAL=0
PORT_HOLDER_PID=""

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

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

run_nemoclaw() {
  node "$REPO/bin/nemoclaw.js" "$@"
}

if ! command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw() { node "$REPO/bin/nemoclaw.js" "$@"; }
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-onboard-negative}"
CLOUD_MODEL="${NEMOCLAW_ONBOARD_NEGATIVE_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
PORT_CONFLICT_PORT="${NEMOCLAW_ONBOARD_NEGATIVE_CONFLICT_PORT:-18080}"
SESSION_FILE="$HOME/.nemoclaw/onboard-session.json"
REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"
RESTORE_API_KEY="${NVIDIA_INFERENCE_API_KEY:-}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"
register_sandbox_for_teardown "${SANDBOX_NAME}-bad-key"
register_sandbox_for_teardown "${SANDBOX_NAME}-port"

cleanup_extra() {
  set +e
  if [ -n "$PORT_HOLDER_PID" ]; then
    kill "$PORT_HOLDER_PID" >/dev/null 2>&1 || true
    wait "$PORT_HOLDER_PID" >/dev/null 2>&1 || true
  fi
  openshell sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1 || true
  openshell sandbox delete "${SANDBOX_NAME}-bad-key" >/dev/null 2>&1 || true
  openshell sandbox delete "${SANDBOX_NAME}-port" >/dev/null 2>&1 || true
  openshell forward stop 18789 >/dev/null 2>&1 || true
  openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true
  rm -f "$SESSION_FILE"
}
trap 'cleanup_extra; _nemoclaw_sandbox_teardown' EXIT

print_summary() {
  echo ""
  echo "========================================"
  echo "  PASS: $PASS"
  echo "  FAIL: $FAIL"
  echo "  SKIP: $SKIP"
  echo " TOTAL: $TOTAL"
  echo "========================================"
  echo ""
}

assert_no_stack_trace() {
  local output="$1"
  if printf '%s\n' "$output" | grep -Eq '(^|[[:space:]])(TypeError|ReferenceError|SyntaxError):|^[[:space:]]+at '; then
    return 1
  fi
  return 0
}

ensure_cli_build() {
  if [ -f "$REPO/dist/lib/onboard.js" ] && [ -f "$REPO/dist/lib/validation.js" ]; then
    return 0
  fi
  info "dist/ is missing; building CLI..."
  (cd "$REPO" && npm run build:cli)
}

run_policy_fallback_check() {
  local mode="$1"
  node - "$REPO" "$mode" <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = process.argv[2];
const mode = process.argv[3];
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-negative-policy-"));
process.env.HOME = home;
process.env.NEMOCLAW_NON_INTERACTIVE = "1";
process.env.NEMOCLAW_POLICY_TIER = "balanced";
process.env.NEMOCLAW_POLICY_MODE = mode;
process.env.NEMOCLAW_POLICY_PRESETS = "";

try {
  Object.defineProperty(process, "platform", { value: "darwin" });
} catch {}

const credentials = require(path.join(repo, "dist", "lib", "credentials", "store.js"));
const runner = require(path.join(repo, "dist", "lib", "runner.js"));
const registry = require(path.join(repo, "dist", "lib", "state", "registry.js"));
const policies = require(path.join(repo, "dist", "lib", "policy", "index.js"));
const resolveOpenshell = require(path.join(repo, "dist", "lib", "adapters", "openshell", "resolve.js"));

credentials.prompt = async (msg) => { throw new Error(`unexpected prompt: ${msg}`); };
credentials.ensureApiKey = async () => {};
credentials.getCredential = () => null;
runner.run = () => ({ status: 0, stdout: "", stderr: "" });
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : String(command);
  if (text.includes("sandbox list")) return "test-sb Ready";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.getSandbox = () => ({ name: "test-sb", model: null, provider: null });
resolveOpenshell.resolveOpenshell = () => "/usr/bin/true";

const appliedCalls = [];
policies.applyPreset = (_sandbox, name) => { appliedCalls.push(name); return true; };
policies.applyPresets = (_sandbox, names) => {
  for (const name of names) appliedCalls.push(name);
  return true;
};
policies.getAppliedPresets = () => [];

const warnings = [];
console.log = () => {};
console.warn = (msg) => warnings.push(String(msg));

(async () => {
  const { setupPoliciesWithSelection } = require(path.join(repo, "dist", "lib", "onboard.js"));
  const applied = await setupPoliciesWithSelection("test-sb", {});
  if (!Array.isArray(applied) || applied.length === 0) {
    throw new Error(`expected fallback presets for ${mode}, got ${JSON.stringify(applied)}`);
  }
  if (appliedCalls.length === 0) {
    throw new Error(`expected preset application calls for ${mode}`);
  }
  if (!warnings.some((line) => line.includes(`Unsupported NEMOCLAW_POLICY_MODE: ${mode}`))) {
    throw new Error(`missing unsupported-mode warning for ${mode}: ${warnings.join(" | ")}`);
  }
  if (!warnings.some((line) => line.includes("Falling back to suggested presets"))) {
    throw new Error(`missing fallback warning for ${mode}: ${warnings.join(" | ")}`);
  }
  const hasTierHint = warnings.some((line) => line.includes("NEMOCLAW_POLICY_TIER=restricted"));
  if (mode === "restricted" && !hasTierHint) {
    throw new Error(`missing tier hint for restricted mode: ${warnings.join(" | ")}`);
  }
  if (mode !== "restricted" && hasTierHint) {
    throw new Error(`unexpected tier hint for ${mode}: ${warnings.join(" | ")}`);
  }
})()
  .then(() => fs.rmSync(home, { recursive: true, force: true }))
  .catch((err) => {
    fs.rmSync(home, { recursive: true, force: true });
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
NODE
}

run_validation_check() {
  node - "$REPO" <<'NODE'
const path = require("node:path");
const repo = process.argv[2];
const { validateNvidiaApiKeyValue } = require(path.join(repo, "dist", "lib", "validation.js"));

const nvidiaError = validateNvidiaApiKeyValue("not-a-nvidia-key", "NVIDIA_INFERENCE_API_KEY");
if (!nvidiaError || !nvidiaError.includes("Must start with nvapi-")) {
  throw new Error(`expected NVIDIA key prefix rejection, got: ${nvidiaError}`);
}

const anthropicError = validateNvidiaApiKeyValue("sk-ant-test-key-without-nvapi-prefix", "ANTHROPIC_API_KEY");
if (anthropicError !== null) {
  throw new Error(`expected Anthropic key to bypass nvapi- prefix enforcement, got: ${anthropicError}`);
}
NODE
}

start_port_holder() {
  local port="$1"
  PORT_HOLDER_PID=""
  node - "$port" <<'NODE' >/tmp/nemoclaw-e2e-port-holder.log 2>&1 &
const net = require("node:net");
const port = Number(process.argv[2]);
const server = net.createServer((socket) => socket.end());
server.on("error", (err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(2);
});
server.listen(port, "127.0.0.1", () => {
  console.log("ready");
});
setInterval(() => {}, 1000);
NODE
  PORT_HOLDER_PID=$!
  local _i
  for _i in $(seq 1 40); do
    if node -e 'const net=require("node:net"); const port=Number(process.argv[1]); const s=net.connect(port,"127.0.0.1"); s.once("connect",()=>{s.destroy(); process.exit(0);}); s.once("error",()=>process.exit(1)); setTimeout(()=>process.exit(1),250);' "$port" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$PORT_HOLDER_PID" >/dev/null 2>&1; then
      PORT_HOLDER_PID=""
      return 1
    fi
    sleep 0.25
  done
  return 1
}

section "Phase 0: Prerequisites"

if command -v node >/dev/null 2>&1; then
  pass "Node.js available"
else
  fail "Node.js not found"
  print_summary
  exit 1
fi

if ensure_cli_build; then
  pass "CLI build output available"
else
  fail "Could not build CLI"
  print_summary
  exit 1
fi

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  print_summary
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell CLI installed"
else
  fail "openshell CLI not found"
  print_summary
  exit 1
fi

if [[ -n "$RESTORE_API_KEY" && "$RESTORE_API_KEY" == nvapi-* ]]; then
  pass "NVIDIA_INFERENCE_API_KEY is set"
else
  fail "NVIDIA_INFERENCE_API_KEY not set or invalid; required for live onboard scenarios"
  print_summary
  exit 1
fi

section "Phase 1: Pre-cleanup"
info "Destroying leftover test sandboxes and gateway state..."
run_nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true
run_nemoclaw "${SANDBOX_NAME}-bad-key" destroy --yes >/dev/null 2>&1 || true
run_nemoclaw "${SANDBOX_NAME}-port" destroy --yes >/dev/null 2>&1 || true
openshell sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1 || true
openshell sandbox delete "${SANDBOX_NAME}-bad-key" >/dev/null 2>&1 || true
openshell sandbox delete "${SANDBOX_NAME}-port" >/dev/null 2>&1 || true
openshell forward stop 18789 >/dev/null 2>&1 || true
openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true
rm -f "$SESSION_FILE"
pass "Pre-cleanup complete"

section "Phase 2: Policy-mode fallback validation"

if run_policy_fallback_check restricted; then
  pass "NEMOCLAW_POLICY_MODE=restricted falls back to suggested presets"
else
  fail "NEMOCLAW_POLICY_MODE=restricted did not fall back cleanly"
fi

if run_policy_fallback_check nonexistent; then
  pass "NEMOCLAW_POLICY_MODE=nonexistent falls back to suggested presets"
else
  fail "NEMOCLAW_POLICY_MODE=nonexistent did not fall back cleanly"
fi

section "Phase 3: Entry option validation"

FROM_GUARD_LOG="$(mktemp)"
env -u NEMOCLAW_SANDBOX_NAME \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_PROVIDER=cloud \
  NEMOCLAW_POLICY_MODE=skip \
  NVIDIA_INFERENCE_API_KEY="$RESTORE_API_KEY" \
  node "$REPO/bin/nemoclaw.js" onboard --non-interactive --from "$REPO/Dockerfile" \
  >"$FROM_GUARD_LOG" 2>&1
from_guard_exit=$?
from_guard_output="$(cat "$FROM_GUARD_LOG")"
rm -f "$FROM_GUARD_LOG"
rm -f "$SESSION_FILE"

if [ "$from_guard_exit" -eq 1 ]; then
  pass "--from without sandbox name exited 1"
else
  fail "--from without sandbox name exited $from_guard_exit (expected 1)"
fi

if printf '%s\n' "$from_guard_output" | grep -q -- "--from <Dockerfile> requires --name <sandbox>"; then
  pass "--from missing-name guard message is explicit"
else
  fail "--from missing-name guard message missing"
fi

if assert_no_stack_trace "$from_guard_output"; then
  pass "--from missing-name guard did not print a stack trace"
else
  fail "--from missing-name guard printed a stack trace"
fi

FROM_ENV_NAME_LOG="$(mktemp)"
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="bad name" \
  NEMOCLAW_PROVIDER=cloud \
  NEMOCLAW_POLICY_MODE=skip \
  NVIDIA_INFERENCE_API_KEY="$RESTORE_API_KEY" \
  node "$REPO/bin/nemoclaw.js" onboard --non-interactive --from "$REPO/Dockerfile" \
  >"$FROM_ENV_NAME_LOG" 2>&1
from_env_name_exit=$?
from_env_name_output="$(cat "$FROM_ENV_NAME_LOG")"
rm -f "$FROM_ENV_NAME_LOG"
rm -f "$SESSION_FILE"

if [ "$from_env_name_exit" -eq 1 ]; then
  pass "--from with NEMOCLAW_SANDBOX_NAME reached name validation"
else
  fail "--from with NEMOCLAW_SANDBOX_NAME exited $from_env_name_exit (expected 1)"
fi

if printf '%s\n' "$from_env_name_output" | grep -q "Invalid sandbox name"; then
  pass "--from with env sandbox name used NEMOCLAW_SANDBOX_NAME"
else
  fail "--from with env sandbox name did not reach name validation"
fi

if printf '%s\n' "$from_env_name_output" | grep -q -- "--from <Dockerfile> requires --name <sandbox>"; then
  fail "--from with env sandbox name still printed missing-name guard"
else
  pass "--from with env sandbox name did not print missing-name guard"
fi

section "Phase 4: Provider credential validation"

INVALID_KEY_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="${SANDBOX_NAME}-bad-key" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_PROVIDER=cloud \
  NEMOCLAW_POLICY_MODE=skip \
  NVIDIA_INFERENCE_API_KEY=not-a-nvidia-key \
  node "$REPO/bin/nemoclaw.js" onboard --non-interactive >"$INVALID_KEY_LOG" 2>&1
invalid_key_exit=$?
invalid_key_output="$(cat "$INVALID_KEY_LOG")"
rm -f "$INVALID_KEY_LOG"
openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true
rm -f "$SESSION_FILE"

if [ "$invalid_key_exit" -eq 1 ]; then
  pass "Invalid NVIDIA API key exited 1"
else
  fail "Invalid NVIDIA API key exited $invalid_key_exit (expected 1)"
fi

if printf '%s\n' "$invalid_key_output" | grep -q "Invalid NVIDIA API key. Must start with nvapi-"; then
  pass "Invalid NVIDIA API key message is explicit"
else
  fail "Invalid NVIDIA API key message missing"
fi

if assert_no_stack_trace "$invalid_key_output"; then
  pass "Invalid NVIDIA API key path did not print a stack trace"
else
  fail "Invalid NVIDIA API key path printed a stack trace"
fi

if run_validation_check; then
  pass "Provider-aware credential validation accepts non-NVIDIA key prefixes"
else
  fail "Provider-aware credential validation rejected a non-NVIDIA key prefix"
fi

section "Phase 5: Gateway port conflict"

if start_port_holder "$PORT_CONFLICT_PORT"; then
  pass "Held gateway port ${PORT_CONFLICT_PORT} with a host listener"
else
  skip "Could not start a local holder on port ${PORT_CONFLICT_PORT}; attempting conflict assertion against any existing listener"
fi

PORT_CONFLICT_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="${SANDBOX_NAME}-port" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_GATEWAY_PORT="$PORT_CONFLICT_PORT" \
  NEMOCLAW_PROVIDER=cloud \
  NEMOCLAW_POLICY_MODE=skip \
  NVIDIA_INFERENCE_API_KEY="$RESTORE_API_KEY" \
  node "$REPO/bin/nemoclaw.js" onboard --non-interactive >"$PORT_CONFLICT_LOG" 2>&1
port_conflict_exit=$?
port_conflict_output="$(cat "$PORT_CONFLICT_LOG")"
rm -f "$PORT_CONFLICT_LOG"

if [ -n "$PORT_HOLDER_PID" ]; then
  kill "$PORT_HOLDER_PID" >/dev/null 2>&1 || true
  wait "$PORT_HOLDER_PID" >/dev/null 2>&1 || true
  PORT_HOLDER_PID=""
fi
rm -f "$SESSION_FILE"

if [ "$port_conflict_exit" -eq 1 ]; then
  pass "Onboard rejected occupied gateway port"
else
  fail "Occupied gateway port exited $port_conflict_exit (expected 1)"
fi

if printf '%s\n' "$port_conflict_output" | grep -q "Port ${PORT_CONFLICT_PORT} is not available"; then
  pass "Port conflict message is user-friendly"
else
  fail "Port conflict message missing"
fi

if assert_no_stack_trace "$port_conflict_output"; then
  pass "Port conflict path did not print a stack trace"
else
  fail "Port conflict path printed a stack trace"
fi

section "Phase 6: Live non-interactive onboard honors presets and model"

LIVE_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_PROVIDER=cloud \
  NEMOCLAW_MODEL="$CLOUD_MODEL" \
  NEMOCLAW_POLICY_MODE=custom \
  NEMOCLAW_POLICY_PRESETS=npm,pypi \
  NVIDIA_INFERENCE_API_KEY="$RESTORE_API_KEY" \
  node "$REPO/bin/nemoclaw.js" onboard --non-interactive >"$LIVE_LOG" 2>&1
live_exit=$?
live_output="$(cat "$LIVE_LOG")"
rm -f "$LIVE_LOG"

if [ "$live_exit" -eq 0 ]; then
  pass "Live non-interactive onboard completed"
else
  fail "Live non-interactive onboard exited $live_exit"
  printf '%s\n' "$live_output" | tail -120
  print_summary
  exit 1
fi

if printf '%s\n' "$live_output" | grep -q "Using NVIDIA Endpoints with model: ${CLOUD_MODEL}"; then
  pass "Live onboard selected requested cloud model"
else
  fail "Live onboard output did not confirm requested cloud model"
fi

if node - "$REGISTRY_FILE" "$SANDBOX_NAME" "$CLOUD_MODEL" <<'NODE'; then
const fs = require("node:fs");
const [registryPath, sandboxName, expectedModel] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const sandbox = registry.sandboxes && registry.sandboxes[sandboxName];
if (!sandbox) throw new Error(`missing sandbox registry entry: ${sandboxName}`);
if (sandbox.provider !== "nvidia-prod") {
  throw new Error(`expected provider nvidia-prod, got ${sandbox.provider}`);
}
if (sandbox.model !== expectedModel) {
  throw new Error(`expected model ${expectedModel}, got ${sandbox.model}`);
}
const policies = Array.isArray(sandbox.policies) ? sandbox.policies : [];
for (const preset of ["npm", "pypi"]) {
  if (!policies.includes(preset)) {
    throw new Error(`missing policy preset ${preset}; policies=${JSON.stringify(policies)}`);
  }
}
NODE
  pass "Registry recorded requested provider, model, and policy presets"
else
  fail "Registry did not record requested provider, model, and policy presets"
fi

if node - "$SESSION_FILE" "$SANDBOX_NAME" "$CLOUD_MODEL" <<'NODE'; then
const fs = require("node:fs");
const [sessionPath, sandboxName, expectedModel] = process.argv.slice(2);
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
if (session.status !== "complete") throw new Error(`session status ${session.status}`);
if (session.sandboxName !== sandboxName) throw new Error(`session sandbox ${session.sandboxName}`);
if (session.provider !== "nvidia-prod") throw new Error(`session provider ${session.provider}`);
if (session.model !== expectedModel) throw new Error(`session model ${session.model}`);
const presets = Array.isArray(session.policyPresets) ? session.policyPresets : [];
for (const preset of ["npm", "pypi"]) {
  if (!presets.includes(preset)) {
    throw new Error(`missing session policy preset ${preset}; presets=${JSON.stringify(presets)}`);
  }
}
NODE
  pass "Session recorded requested provider, model, and policy presets"
else
  fail "Session did not record requested provider, model, and policy presets"
fi

section "Phase 7: Final cleanup"

if [[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" != "1" ]]; then
  run_nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true
fi
openshell sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1 || true
openshell forward stop 18789 >/dev/null 2>&1 || true
openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true
rm -f "$SESSION_FILE"

if openshell sandbox get "$SANDBOX_NAME" >/dev/null 2>&1; then
  fail "Sandbox '$SANDBOX_NAME' still exists after cleanup"
else
  pass "Sandbox '$SANDBOX_NAME' cleaned up"
fi

if [ -f "$SESSION_FILE" ]; then
  fail "Onboard session file still exists after cleanup"
else
  pass "Onboard session file cleaned up"
fi

pass "Final cleanup complete"
print_summary

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
