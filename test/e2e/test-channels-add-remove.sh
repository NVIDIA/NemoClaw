#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Channel add/remove lifecycle E2E test.
#
# Covers Test 2 from issue #3462 ("onboard empty -> channels add -> channels remove").
# Regression coverage for:
#   - #3437 — `channels add <ch>` + rebuild must apply the channel's matching
#             network policy preset so the bridge boots with egress to its
#             upstream API (the SSRF engine blocked all outbound traffic before
#             the addSandboxChannel preset-apply fix).
#
# Telegram-only — Discord/Slack walk the same KNOWN_CHANNELS + preset lookup
# code path; telegram is the cheapest regression gate.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_INFERENCE_API_KEY set (real key or fake OpenAI endpoint)
#   - NEMOCLAW_NON_INTERACTIVE=1, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_INFERENCE_API_KEY=nvapi-... bash test/e2e/test-channels-add-remove.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=2400
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

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

print_summary() {
  section "Summary"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "FAILED"
    exit 1
  fi
  echo ""
  if [ "$SKIP" -gt 0 ]; then
    echo "PASSED (with $SKIP skipped)"
  else
    echo "ALL PASSED"
  fi
}

# Repo root resolution mirrors test-channels-stop-start.sh.
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-channels-add-remove}"
INSTALL_LOG="/tmp/nemoclaw-e2e-install.log"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-test-fake-telegram-token-add-remove-e2e}"
TELEGRAM_ALLOWED_IDS_VALUE="${TELEGRAM_ALLOWED_IDS:-123456789}"
TELEGRAM_REQUIRE_MENTION_VALUE="${TELEGRAM_REQUIRE_MENTION:-0}"

is_fake_telegram_token() {
  case "${1:-}" in
    *fake*) return 0 ;;
    *) return 1 ;;
  esac
}

maybe_skip_telegram_reachability_for_fake_token() {
  if [ -z "${NEMOCLAW_SKIP_TELEGRAM_REACHABILITY:-}" ] && is_fake_telegram_token "$TELEGRAM_TOKEN"; then
    # This E2E normally uses a fake token to exercise add/remove plumbing, not
    # the live Telegram API. Remove once the test has a hermetic fake Telegram API.
    export NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1
    info "Skipping Telegram reachability probe for fake-token E2E"
  fi
}

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# ── sandbox_exec: run a command inside the sandbox and capture output. ──
sandbox_exec() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null

  local result
  result=$(timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$cmd" \
    2>&1) || true

  rm -f "$ssh_config"
  echo "$result"
}

openclaw_has_telegram() {
  # Read /sandbox/.openclaw/openclaw.json from inside the sandbox and check
  # for `channels.telegram`. Exit 0 if present, 1 if absent, 2 if the file
  # could not be read.
  local out
  out=$(sandbox_exec \
    "python3 -c 'import json,sys; d=json.load(open(\"/sandbox/.openclaw/openclaw.json\")); print(\"yes\" if \"telegram\" in d.get(\"channels\",{}) else \"no\")' 2>&1") || true
  local verdict
  verdict="$(printf '%s\n' "$out" | tail -n1 | tr -d '\r')"
  case "$verdict" in
    yes) return 0 ;;
    no) return 1 ;;
    *) return 2 ;;
  esac
}

# Print the policy-list snapshot so the test transcript shows gateway state
# alongside each pass/fail line.
print_policy_list() {
  info "policy-list snapshot:"
  nemoclaw "$SANDBOX_NAME" policy-list 2>&1 | sed 's/^/    /' || true
}

# Check whether a named preset is currently applied. Matches only the
# applied marker (●); the inactive marker (○) is treated as "not applied".
policy_list_has_preset() {
  local preset="$1"
  nemoclaw "$SANDBOX_NAME" policy-list 2>/dev/null \
    | grep -E "^\s*●\s+${preset}\b" >/dev/null
}

assert_host_telegram_config() {
  local context="$1"
  local output
  if output="$(node -e '
const fs = require("fs");
const [registryPath, sandboxName, allowedIds, requireMention] = process.argv.slice(1);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!fs.existsSync(registryPath)) fail("registry file not found: " + registryPath);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const entry = registry.sandboxes?.[sandboxName];
if (!entry) fail("sandbox " + sandboxName + " missing from registry");
const plan = entry.messaging?.plan;
if (!plan || plan.schemaVersion !== 1) fail("messaging.plan missing or schemaVersion != 1");
const channel = Array.isArray(plan.channels)
  ? plan.channels.find((item) => item?.channelId === "telegram")
  : null;
if (!channel) fail("telegram channel missing from messaging.plan.channels");
const inputs = Array.isArray(channel.inputs) ? channel.inputs : [];
const inputValue = (id) => inputs.find((input) => input?.inputId === id)?.value;
if (inputValue("allowedIds") !== allowedIds) {
  fail("allowedIds input expected " + allowedIds + ", got " + JSON.stringify(inputValue("allowedIds")));
}
if (inputValue("requireMention") !== requireMention) {
  fail("requireMention input expected " + requireMention + ", got " + JSON.stringify(inputValue("requireMention")));
}
' "$REGISTRY" "$SANDBOX_NAME" "$TELEGRAM_ALLOWED_IDS_VALUE" "$TELEGRAM_REQUIRE_MENTION_VALUE" 2>&1)"; then
    pass "host registry messaging.plan persists telegram config ${context}"
  else
    fail "host registry messaging.plan missing telegram config ${context}: ${output}"
  fi
}

assert_host_telegram_plan() {
  local expected="$1"
  local context="$2"
  local output
  if output="$(node -e '
const fs = require("fs");
const [registryPath, sandboxName, expected] = process.argv.slice(1);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!fs.existsSync(registryPath)) fail("registry file not found: " + registryPath);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const entry = registry.sandboxes?.[sandboxName];
if (!entry) fail("sandbox " + sandboxName + " missing from registry");
const state = entry.messaging;
if (!state || state.schemaVersion !== 1) fail("messaging state missing or schemaVersion != 1");
const plan = state.plan;
if (!plan || plan.schemaVersion !== 1) fail("messaging.plan missing or schemaVersion != 1");
if (plan.sandboxName !== sandboxName) {
  fail("messaging.plan.sandboxName expected " + sandboxName + ", got " + JSON.stringify(plan.sandboxName));
}
if (plan.agent !== "openclaw") fail("messaging.plan.agent expected openclaw, got " + JSON.stringify(plan.agent));
const channels = Array.isArray(plan.channels) ? plan.channels : [];
const channel = channels.find((item) => item?.channelId === "telegram");
const disabledChannels = Array.isArray(plan.disabledChannels) ? plan.disabledChannels : [];
const credentialBindings = Array.isArray(plan.credentialBindings) ? plan.credentialBindings : [];
const networkEntries = Array.isArray(plan.networkPolicy?.entries) ? plan.networkPolicy.entries : [];
const networkPresets = Array.isArray(plan.networkPolicy?.presets) ? plan.networkPolicy.presets : [];
if (Object.hasOwn(plan, "agentRender")) fail("messaging.plan.agentRender should not be persisted");
if (channels.some((item) => item && Object.hasOwn(item, "hooks"))) fail("messaging.plan.channels hooks should not be persisted");
if (expected === "active") {
  if (!channel) fail("telegram channel missing from messaging.plan.channels");
  if (channel.active !== true) fail("telegram plan active expected true, got " + JSON.stringify(channel.active));
  if (channel.disabled === true) fail("telegram plan disabled unexpectedly true");
  if (!networkPresets.includes("telegram")) fail("telegram missing from messaging.plan.networkPolicy.presets");
  if (!networkEntries.some((entry) => entry?.channelId === "telegram")) {
    fail("telegram missing from messaging.plan.networkPolicy.entries");
  }
  if (!credentialBindings.some((entry) => entry?.channelId === "telegram" && entry?.providerEnvKey === "TELEGRAM_BOT_TOKEN")) {
    fail("telegram TELEGRAM_BOT_TOKEN credential binding missing from messaging.plan");
  }
  if (disabledChannels.includes("telegram")) fail("telegram unexpectedly listed in messaging.plan.disabledChannels");
} else if (expected === "removed") {
  if (channel) fail("telegram still present in messaging.plan.channels");
  if (disabledChannels.includes("telegram")) fail("telegram still present in messaging.plan.disabledChannels");
  if (networkPresets.includes("telegram")) fail("telegram still present in messaging.plan.networkPolicy.presets");
  if (networkEntries.some((entry) => entry?.channelId === "telegram")) {
    fail("telegram still present in messaging.plan.networkPolicy.entries");
  }
  if (credentialBindings.some((entry) => entry?.channelId === "telegram")) {
    fail("telegram credential binding still present in messaging.plan");
  }
} else {
  fail("unknown expected plan state: " + expected);
}
' "$REGISTRY" "$SANDBOX_NAME" "$expected" 2>&1)"; then
    pass "host registry messaging.plan has telegram ${expected} ${context}"
  else
    fail "host registry messaging.plan expected telegram ${expected} ${context}: ${output}"
  fi
}

# Run rebuild with live tail of the rebuild log so the operator can see
# progress. Mirrors the install.sh tail pattern in Phase 1.
run_rebuild_with_live_log() {
  local log_path="$1"
  nemoclaw "$SANDBOX_NAME" rebuild --yes >"$log_path" 2>&1 &
  local rebuild_pid=$!
  tail -f "$log_path" --pid=$rebuild_pid 2>/dev/null &
  local tail_pid=$!
  wait $rebuild_pid
  local rebuild_exit=$?
  kill $tail_pid 2>/dev/null || true
  wait $tail_pid 2>/dev/null || true
  return $rebuild_exit
}

# Egress probe through the L7 proxy from inside the sandbox. The telegram
# preset scopes egress to (binary IN [node]) AND (path /bot*/**), so probe
# with `node -e fetch` against a bot path. A 4xx from Telegram (e.g. 401
# for the fake token) still counts as success — it proves the proxy let
# the CONNECT through. Proxy denial surfaces as a fetch error with no
# STATUS_ line.
telegram_egress_open() {
  local body
  body=$(sandbox_exec "node -e 'fetch(\"https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe\", {signal: AbortSignal.timeout(15000)}).then(r => console.log(\"STATUS_\" + r.status)).catch(e => console.log(\"ERROR_\" + (e.cause?.code || e.code || e.message)))' 2>&1" || true)
  echo "  [egress-probe] node fetch output:"
  echo "$body" | head -20 | sed 's/^/    /'
  # STATUS_2xx (valid token) or STATUS_4xx (e.g. 401 Unauthorized for the
  # fake test token) — Telegram itself responded, meaning the proxy passed.
  if echo "$body" | grep -qE "STATUS_[24][0-9][0-9]"; then
    return 0
  fi
  # Proxy denial signatures — fetch raises a network error before any HTTP
  # status. The gateway L7 surfaces the rejection with one of these.
  if echo "$body" | grep -qiE "policy_denied|engine:ssrf|forbidden by policy|CONNECT.*40[0-9]"; then
    return 1
  fi
  if echo "$body" | grep -qiE "fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT"; then
    return 2
  fi
  return 2
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]; then
  fail "C0: NVIDIA_INFERENCE_API_KEY is required"
  print_summary
fi
pass "C0: NVIDIA_INFERENCE_API_KEY is set"

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "C0: NEMOCLAW_NON_INTERACTIVE=1 is required"
  print_summary
fi
pass "C0: NEMOCLAW_NON_INTERACTIVE=1 is set"

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "C0: NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  print_summary
fi
pass "C0: NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is set"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Install + onboard sandbox WITHOUT any messaging channel
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Install + onboard sandbox (no channel)"

cd "$REPO" || exit 1

# Pre-cleanup: leftover sandboxes from prior runs.
info "Pre-cleanup..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if openshell --version >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
pass "C1a: Pre-cleanup complete"

# Intentionally do NOT export TELEGRAM_BOT_TOKEN here — onboard must see no
# messaging tokens and skip the messaging step entirely. This reproduces the
# exact entry condition of the #3437 bug (onboard empty -> later channels add).
unset TELEGRAM_BOT_TOKEN
unset TELEGRAM_ALLOWED_IDS
unset TELEGRAM_REQUIRE_MENTION

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_FRESH=1

info "Running install.sh --non-interactive (this takes 5-10 min on first run)..."
bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

# Refresh PATH for nvm-managed installs.
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ $install_exit -eq 0 ]; then
  pass "C1b: install.sh + onboard completed (exit 0)"
else
  fail "C1b: install.sh failed (exit $install_exit)"
  tail -100 "$INSTALL_LOG" 2>/dev/null || true
  print_summary
fi

if ! openshell --version >/dev/null 2>&1; then
  fail "C1c: openshell not on PATH after install"
  print_summary
fi
pass "C1c: openshell installed"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "C1d: nemoclaw not on PATH after install"
  print_summary
fi
pass "C1d: nemoclaw installed"

if openshell sandbox list 2>&1 | grep -q "${SANDBOX_NAME}.*Ready"; then
  pass "C1e: Sandbox '${SANDBOX_NAME}' is Ready"
else
  fail "C1e: Sandbox '${SANDBOX_NAME}' not Ready"
  print_summary
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: Verify baseline state (no telegram anywhere)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Verify baseline state (no channel)"

if openshell provider get "${SANDBOX_NAME}-telegram-bridge" >/dev/null 2>&1; then
  fail "C2a: Provider '${SANDBOX_NAME}-telegram-bridge' unexpectedly exists at baseline"
else
  pass "C2a: No telegram-bridge provider at baseline"
fi

if openclaw_has_telegram; then
  fail "C2b: openclaw.json unexpectedly contains 'telegram' at baseline"
else
  rc=$?
  if [ "$rc" = "2" ]; then
    fail "C2b: could not read openclaw.json inside sandbox at baseline"
  else
    pass "C2b: openclaw.json has no 'telegram' channel block at baseline"
  fi
fi

print_policy_list
if policy_list_has_preset telegram; then
  fail "C2c: 'telegram' preset unexpectedly applied at baseline"
else
  pass "C2c: 'telegram' preset not applied at baseline"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: channels add telegram + rebuild
# ══════════════════════════════════════════════════════════════════
section "Phase 3: channels add telegram + rebuild"

# Now provide the token — this mirrors the real user flow: after onboard,
# the operator decides to add a channel and exports the token first.
export TELEGRAM_BOT_TOKEN="$TELEGRAM_TOKEN"
export TELEGRAM_ALLOWED_IDS="$TELEGRAM_ALLOWED_IDS_VALUE"
export TELEGRAM_REQUIRE_MENTION="$TELEGRAM_REQUIRE_MENTION_VALUE"
maybe_skip_telegram_reachability_for_fake_token

# Gateway-credential reuse gate. Before the fix, the rebuild preflight
# aborted with "provider credential not found" when NVIDIA_INFERENCE_API_KEY was unset
# in the host env even though the inference provider was already registered
# in the OpenShell gateway. Drop the key from the env around `channels add`
# + rebuild so the post-add rebuild has to reuse the gateway-stored
# credential instead of demanding it back on the host.
NVIDIA_INFERENCE_API_KEY_BACKUP="${NVIDIA_INFERENCE_API_KEY:-}"
unset NVIDIA_INFERENCE_API_KEY
info "NVIDIA_INFERENCE_API_KEY unset for gateway-credential-reuse gate; gateway must hold the credential"

if nemoclaw "$SANDBOX_NAME" channels add telegram >/tmp/nc-add.log 2>&1; then
  add_rc=0
else
  add_rc=$?
fi
cat /tmp/nc-add.log
if [ "$add_rc" -eq 0 ] && grep -q "Registered telegram" /tmp/nc-add.log; then
  pass "C3a: channels add telegram registered the bridge"
else
  fail "C3a: channels add telegram did not register"
  tail -20 /tmp/nc-add.log 2>/dev/null || true
fi
assert_host_telegram_config "after channels add"
assert_host_telegram_plan "active" "after channels add"

info "Rebuilding sandbox to apply the add..."
if run_rebuild_with_live_log /tmp/nc-rebuild-add.log; then
  pass "C3b: rebuild (post-add) completed"
else
  fail "C3b: rebuild (post-add) failed"
  tail -100 /tmp/nc-rebuild-add.log 2>/dev/null || true
  # Restore env before bailing so later phases (and operators rerunning
  # the script interactively) still see the original key.
  if [ -n "$NVIDIA_INFERENCE_API_KEY_BACKUP" ]; then
    export NVIDIA_INFERENCE_API_KEY="$NVIDIA_INFERENCE_API_KEY_BACKUP"
  fi
  print_summary
fi

# Gateway-credential reuse assertion: the rebuild must not have aborted with
# the "provider credential not found" error.
if grep -q "provider credential not found" /tmp/nc-rebuild-add.log; then
  fail "C3c: REGRESSION — rebuild aborted on missing NVIDIA_INFERENCE_API_KEY despite gateway-registered credential"
else
  pass "C3c: rebuild reused gateway-stored credential without NVIDIA_INFERENCE_API_KEY"
fi

# Restore for the remaining phases — `channels remove` + rebuild should
# work in the normal env-present case too.
if [ -n "$NVIDIA_INFERENCE_API_KEY_BACKUP" ]; then
  export NVIDIA_INFERENCE_API_KEY="$NVIDIA_INFERENCE_API_KEY_BACKUP"
fi
unset NVIDIA_INFERENCE_API_KEY_BACKUP

# ══════════════════════════════════════════════════════════════════
# Phase 4: Post-add assertions (Test 2 acceptance, regression #3437)
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Verify post-add state (regression #3437)"

# C4a: regression gate for #3437. Pre-fix, `channels add` did not apply
# the matching policy preset, so the rebuilt sandbox lost egress to
# api.telegram.org. This assertion catches that regression.
print_policy_list
if policy_list_has_preset telegram; then
  pass "C4a: 'telegram' preset present in policy list after add+rebuild (#3437 fixed)"
else
  fail "C4a: REGRESSION — 'telegram' preset missing from policy list after add+rebuild (#3437)"
fi

if openclaw_has_telegram; then
  pass "C4b: openclaw.json contains 'telegram' channel block after add+rebuild"
else
  rc=$?
  if [ "$rc" = "2" ]; then
    fail "C4b: could not read openclaw.json inside sandbox post-add"
  else
    fail "C4b: openclaw.json missing 'telegram' channel after add+rebuild"
  fi
fi

if openshell provider get "${SANDBOX_NAME}-telegram-bridge" >/dev/null 2>&1; then
  pass "C4c: telegram-bridge provider exists in gateway after add+rebuild"
else
  fail "C4c: telegram-bridge provider missing in gateway after add+rebuild"
fi

assert_host_telegram_config "after add+rebuild"
assert_host_telegram_plan "active" "after add+rebuild"

# C4d: network reachability. With the preset applied, the bridge-style
# probe (see telegram_egress_open) should reach Telegram and elicit a
# response; without it, the proxy denies the CONNECT. User-facing symptom
# of #3437 is the bot staying silent.
if telegram_egress_open; then
  pass "C4d: egress to api.telegram.org reaches Telegram through L7 proxy"
else
  rc=$?
  if [ "$rc" = "2" ]; then
    skip "C4d: egress probe inconclusive (network instability or unexpected proxy response)"
  else
    fail "C4d: egress to api.telegram.org blocked by proxy (preset not in effect)"
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: channels remove telegram + rebuild
# ══════════════════════════════════════════════════════════════════
section "Phase 5: channels remove telegram + rebuild"

if nemoclaw "$SANDBOX_NAME" channels remove telegram >/tmp/nc-remove.log 2>&1; then
  remove_rc=0
else
  remove_rc=$?
fi
cat /tmp/nc-remove.log
if [ "$remove_rc" -eq 0 ] && grep -q "Removed telegram" /tmp/nc-remove.log; then
  pass "C5a: channels remove telegram unregistered the bridge"
else
  fail "C5a: channels remove telegram did not unregister"
  tail -20 /tmp/nc-remove.log 2>/dev/null || true
fi
assert_host_telegram_plan "removed" "after channels remove"

info "Rebuilding sandbox to apply the remove..."
if run_rebuild_with_live_log /tmp/nc-rebuild-remove.log; then
  pass "C5b: rebuild (post-remove) completed"
else
  fail "C5b: rebuild (post-remove) failed"
  tail -100 /tmp/nc-rebuild-remove.log 2>/dev/null || true
  print_summary
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Post-remove assertions (clean state restored)
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Verify post-remove state"

if openclaw_has_telegram; then
  fail "C6a: openclaw.json still contains 'telegram' after remove+rebuild"
  info "openclaw.json channels after remove+rebuild:"
  sandbox_exec "python3 -c 'import json; print(list(json.load(open(\"/sandbox/.openclaw/openclaw.json\")).get(\"channels\",{}).keys()))' 2>&1" | head -5
else
  rc=$?
  if [ "$rc" = "2" ]; then
    fail "C6a: could not read openclaw.json inside sandbox post-remove"
  else
    pass "C6a: openclaw.json excludes 'telegram' after remove+rebuild"
  fi
fi

if openshell provider get "${SANDBOX_NAME}-telegram-bridge" >/dev/null 2>&1; then
  fail "C6b: telegram-bridge provider still exists in gateway after remove+rebuild"
else
  pass "C6b: telegram-bridge provider removed from gateway after remove+rebuild"
fi

# C6c: symmetric preset cleanup. `channels remove` should un-apply the
# channel's matching policy preset so the L7 proxy stops allow-listing the
# bridge's upstream API (defense-in-depth: bridge is gone, egress to
# api.telegram.org should follow).
print_policy_list
if policy_list_has_preset telegram; then
  fail "C6c: REGRESSION — 'telegram' preset still applied after remove+rebuild (#3671)"
else
  pass "C6c: 'telegram' preset removed from policy list after remove+rebuild"
fi

assert_host_telegram_plan "removed" "after remove+rebuild"

print_summary
