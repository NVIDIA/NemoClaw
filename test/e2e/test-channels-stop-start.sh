#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Channel stop/start lifecycle E2E test.
#
# Covers Test 1 from issue #3462 ("onboard telegram → channels stop → channels start").
# Regression coverage for:
#   - #3453 — `channels stop <ch>` + rebuild must actually remove the channel
#             from openclaw.json (registry `disabledChannels` was lost across
#             the destroy/recreate window before the session-stash fix).
#   - #3381 — `channels start <ch>` + rebuild must re-attach the bridge from
#             cached credentials without re-prompting.
#
# Telegram-only — Discord/Slack carry the same code path; this script covers
# the regression with the minimal channel surface.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key or fake OpenAI endpoint)
#   - NEMOCLAW_NON_INTERACTIVE=1, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-channels-stop-start.sh

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

# Repo root resolution mirrors test-token-rotation.sh.
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-channels-stop-start}"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
INSTALL_LOG="/tmp/nemoclaw-e2e-install.log"
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-test-fake-telegram-token-stop-start-e2e}"
TELEGRAM_IDS="${TELEGRAM_ALLOWED_IDS:-123456789}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# ── sandbox_exec: capture a command's output from inside the sandbox ──
# Same pattern as test-messaging-providers.sh.
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

# Inspect the registry for one sandbox. Echoes a JSON blob; callers `jq` it.
# Falls back to `node -e` when jq is unavailable on the host.
registry_field() {
  local field="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -c --arg name "$SANDBOX_NAME" --arg field "$field" \
      '.sandboxes[$name][$field]' "$REGISTRY" 2>/dev/null || echo "null"
  else
    node -e "
const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const v = (r.sandboxes || {})[process.argv[2]]?.[process.argv[3]];
process.stdout.write(JSON.stringify(v ?? null));
" "$REGISTRY" "$SANDBOX_NAME" "$field" 2>/dev/null || echo "null"
  fi
}

openclaw_has_telegram() {
  # Read /sandbox/.openclaw/openclaw.json from inside the sandbox and check
  # for `channels.telegram`. Exit 0 if present, 1 if absent, 2 if the file
  # could not be read.
  local out
  out=$(sandbox_exec \
    "python3 -c 'import json,sys; d=json.load(open(\"/sandbox/.openclaw/openclaw.json\")); print(\"yes\" if \"telegram\" in d.get(\"channels\",{}) else \"no\")' 2>&1") || true
  case "$out" in
    *yes*) return 0 ;;
    *no*) return 1 ;;
    *) return 2 ;;
  esac
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if [ -z "${NVIDIA_API_KEY:-}" ]; then
  fail "C0: NVIDIA_API_KEY is required"
  print_summary
fi
pass "C0: NVIDIA_API_KEY is set"

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "C0: NEMOCLAW_NON_INTERACTIVE=1 is required"
  print_summary
fi
pass "C0: NEMOCLAW_NON_INTERACTIVE=1 is set"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Install + onboard with Telegram enabled
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Install + onboard sandbox with Telegram"

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

# Skip the host-side Telegram reachability probe in onboard — the fake token
# would fail Bot API contact anyway.
if [ -z "${NEMOCLAW_SKIP_TELEGRAM_REACHABILITY:-}" ]; then
  if ! curl -fsS --max-time 10 https://api.telegram.org/ >/dev/null 2>&1; then
    export NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1
    info "api.telegram.org unreachable from host; setting NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1"
  fi
fi

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_FRESH=1
export TELEGRAM_BOT_TOKEN="$TELEGRAM_TOKEN"
export TELEGRAM_ALLOWED_IDS="$TELEGRAM_IDS"

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
  tail -30 "$INSTALL_LOG" 2>/dev/null || true
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
# Phase 2: Verify baseline state (Telegram active)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Verify baseline state (Telegram active)"

if openshell provider get "${SANDBOX_NAME}-telegram-bridge" >/dev/null 2>&1; then
  pass "C2a: Provider '${SANDBOX_NAME}-telegram-bridge' exists in gateway"
else
  fail "C2a: Provider '${SANDBOX_NAME}-telegram-bridge' missing in gateway"
fi

if openclaw_has_telegram; then
  pass "C2b: openclaw.json contains 'telegram' channel block"
else
  rc=$?
  if [ "$rc" = "2" ]; then
    fail "C2b: could not read openclaw.json inside sandbox"
  else
    fail "C2b: openclaw.json missing 'telegram' channel before stop (precondition failed)"
  fi
fi

baseline_messaging=$(registry_field messagingChannels)
if echo "$baseline_messaging" | grep -q '"telegram"'; then
  pass "C2c: registry.messagingChannels contains telegram (${baseline_messaging})"
else
  fail "C2c: registry.messagingChannels missing telegram (got: ${baseline_messaging})"
fi

baseline_disabled=$(registry_field disabledChannels)
case "$baseline_disabled" in
  "null" | "[]") pass "C2d: registry.disabledChannels empty at baseline" ;;
  *) fail "C2d: registry.disabledChannels unexpectedly non-empty at baseline (got: ${baseline_disabled})" ;;
esac

# ══════════════════════════════════════════════════════════════════
# Phase 3: Stop telegram + rebuild
# ══════════════════════════════════════════════════════════════════
section "Phase 3: channels stop telegram + rebuild"

if nemoclaw "$SANDBOX_NAME" channels stop telegram >/tmp/nc-stop.log 2>&1; then
  stop_rc=0
else
  stop_rc=$?
fi
cat /tmp/nc-stop.log
if [ "$stop_rc" -eq 0 ] && grep -q "Marked telegram" /tmp/nc-stop.log; then
  pass "C3a: channels stop telegram registered the change"
else
  fail "C3a: channels stop telegram did not register"
  tail -20 /tmp/nc-stop.log 2>/dev/null || true
fi

info "Rebuilding sandbox to apply the stop..."
if nemoclaw "$SANDBOX_NAME" rebuild --yes >/tmp/nc-rebuild-stop.log 2>&1; then
  pass "C3b: rebuild (post-stop) completed"
else
  fail "C3b: rebuild (post-stop) failed"
  tail -30 /tmp/nc-rebuild-stop.log 2>/dev/null || true
  print_summary
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Post-stop assertions (Test 1 acceptance criteria, #3453)
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Verify post-stop state (regression #3453)"

# C4a: THE REGRESSION CHECK. Before the session-stash fix, the rebuild
# destroyed the registry entry before onboard --resume read disabledChannels
# back — so the filter was a no-op and telegram came back live. This is the
# load-bearing assertion of the whole test.
if openclaw_has_telegram; then
  fail "C4a: REGRESSION — openclaw.json still contains 'telegram' after stop+rebuild (#3453)"
  info "openclaw.json channels after stop+rebuild:"
  sandbox_exec "python3 -c 'import json; print(list(json.load(open(\"/sandbox/.openclaw/openclaw.json\")).get(\"channels\",{}).keys()))' 2>&1" | head -5
else
  rc=$?
  if [ "$rc" = "2" ]; then
    fail "C4a: could not read openclaw.json inside sandbox post-stop"
  else
    pass "C4a: openclaw.json excludes 'telegram' after stop+rebuild (#3453 fixed)"
  fi
fi

# C4b: messagingChannels keeps telegram so `channels start` can recover it
# (deliberate — the channel isn't removed, just paused).
post_stop_messaging=$(registry_field messagingChannels)
if echo "$post_stop_messaging" | grep -q '"telegram"'; then
  pass "C4b: registry.messagingChannels still contains telegram (${post_stop_messaging})"
else
  fail "C4b: registry.messagingChannels lost telegram after stop (got: ${post_stop_messaging})"
fi

# C4c: disabledChannels must contain telegram.
post_stop_disabled=$(registry_field disabledChannels)
if echo "$post_stop_disabled" | grep -q '"telegram"'; then
  pass "C4c: registry.disabledChannels contains telegram (${post_stop_disabled})"
else
  fail "C4c: registry.disabledChannels missing telegram (got: ${post_stop_disabled})"
fi

# C4d: The bridge provider must NOT be attached to the rebuilt sandbox. The
# provider record itself stays in the gateway (so `channels start` can
# re-attach without re-prompting); only the sandbox attachment is gone.
attached=$(openshell sandbox describe "$SANDBOX_NAME" 2>&1 \
  | grep -F "${SANDBOX_NAME}-telegram-bridge" || true)
if [ -z "$attached" ]; then
  pass "C4d: telegram-bridge provider not attached to rebuilt sandbox"
else
  fail "C4d: telegram-bridge provider still attached after stop+rebuild (${attached})"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Start telegram + rebuild
# ══════════════════════════════════════════════════════════════════
section "Phase 5: channels start telegram + rebuild"

if nemoclaw "$SANDBOX_NAME" channels start telegram >/tmp/nc-start.log 2>&1; then
  start_rc=0
else
  start_rc=$?
fi
cat /tmp/nc-start.log
if [ "$start_rc" -eq 0 ] && grep -q "Marked telegram" /tmp/nc-start.log; then
  pass "C5a: channels start telegram registered the change"
else
  fail "C5a: channels start telegram did not register"
  tail -20 /tmp/nc-start.log 2>/dev/null || true
fi

info "Rebuilding sandbox to apply the start..."
if nemoclaw "$SANDBOX_NAME" rebuild --yes >/tmp/nc-rebuild-start.log 2>&1; then
  pass "C5b: rebuild (post-start) completed"
else
  fail "C5b: rebuild (post-start) failed"
  tail -30 /tmp/nc-rebuild-start.log 2>/dev/null || true
  print_summary
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Post-start assertions (Test 1 acceptance criteria, #3381)
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Verify post-start state (regression #3381)"

# C6a: Telegram block back in openclaw.json. The host-side credential is
# still cached from Phase 1 (channels start does not re-prompt) — proves
# #3381's "start should recover from cached credentials" contract.
if openclaw_has_telegram; then
  pass "C6a: openclaw.json contains 'telegram' again after start+rebuild (#3381 fixed)"
else
  rc=$?
  if [ "$rc" = "2" ]; then
    fail "C6a: could not read openclaw.json inside sandbox post-start"
  else
    fail "C6a: openclaw.json missing 'telegram' after start+rebuild (#3381 regression)"
  fi
fi

# C6b: disabledChannels cleared.
post_start_disabled=$(registry_field disabledChannels)
case "$post_start_disabled" in
  "null" | "[]") pass "C6b: registry.disabledChannels cleared (${post_start_disabled})" ;;
  *) fail "C6b: registry.disabledChannels still set after start (got: ${post_start_disabled})" ;;
esac

# C6c: Provider record still resolvable in the gateway (cached token survived).
if openshell provider get "${SANDBOX_NAME}-telegram-bridge" >/dev/null 2>&1; then
  pass "C6c: telegram-bridge provider record present in gateway (cached token reused)"
else
  fail "C6c: telegram-bridge provider record missing in gateway after start"
fi

print_summary
