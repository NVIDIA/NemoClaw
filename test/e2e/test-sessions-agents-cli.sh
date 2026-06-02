#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-sessions-agents-cli.sh
# NemoClaw `sessions` and `agents` subcommand E2E tests
#
# Covers the host-side CLI surface for the sandbox `sessions` and `agents`
# subcommand groups. The end-to-end recovery semantics for the in-sandbox
# session store (stale `.jsonl.lock`, corrupt `sessions.json`, the clean
# follow-up message after a reset) live with the OpenClaw gateway upstream
# — see the scope-boundary note in `src/lib/actions/sandbox/sessions/reset.ts`.
# This script exercises only what NemoClaw owns: argv translation, gateway
# dispatch, and JSON envelope handling.
#   TC-SESS-01: `nemoclaw <name> sessions --json`
#               (parent default = `openclaw sessions` list)
#   TC-SESS-02: `nemoclaw <name> sessions list --json`
#   TC-SESS-03: `nemoclaw <name> sessions reset <key>` via gateway RPC
#   TC-SESS-04: `nemoclaw <name> sessions list --json` after reset
#   TC-AGENT-01: `nemoclaw <name> agents add work --model gpt-4o`
#               (passthrough wizard; --non-interactive bypass)
#   TC-AGENT-02: `nemoclaw <name> agents delete work --force --json`
#               (passthrough delete; OpenClaw owns workspace removal)
#   TC-SESS-05: `nemoclaw <name> sessions delete <key>` on a non-main session
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key or fake OpenAI endpoint)
#   - NEMOCLAW_NON_INTERACTIVE=1, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-sessions-agents-cli.sh
# =============================================================================

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT="${NEMOCLAW_E2E_DEFAULT_TIMEOUT:-2400}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
. "${SCRIPT_DIR}/e2e-timeout.sh"

PASS=0
FAIL=0
SKIP=0
TOTAL=0
pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  SKIP=$((SKIP + 1))
  TOTAL=$((TOTAL + 1))
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-sessions-agents-cli}"
TEST_AGENT_ID="${NEMOCLAW_E2E_AGENT_ID:-work}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

is_valid_json() {
  printf '%s' "$1" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null
}

preflight() {
  section "Preflight"
  if ! docker info >/dev/null 2>&1; then
    fail "preflight: Docker not running"
    print_summary
    exit 1
  fi
  if [ -z "${NVIDIA_API_KEY:-}" ]; then
    skip "preflight: NVIDIA_API_KEY not set; sessions/agents E2E requires a working onboard credential"
    print_summary
    exit 0
  fi
  pass "preflight: docker + NVIDIA_API_KEY available"
}

onboard_sandbox() {
  section "Onboard sandbox '${SANDBOX_NAME}'"
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="open" \
    nemoclaw onboard --non-interactive --yes-i-accept-third-party-software 2>&1 || {
    fail "onboard: onboard command failed for '${SANDBOX_NAME}'"
    print_summary
    exit 1
  }
  pass "onboard: sandbox '${SANDBOX_NAME}' is up"
}

seed_main_session() {
  section "Seed main session by sending one prompt"
  if ! nemoclaw "$SANDBOX_NAME" exec -- openclaw agent --agent main -m "ping" 2>&1; then
    fail "seed: agent invocation failed; sessions store may not be populated"
    return 1
  fi
  pass "seed: sent one prompt to agent 'main'"
}

test_sessions_default_json() {
  section "TC-SESS-01: sessions --json (parent default = list)"
  local out
  out="$(nemoclaw "$SANDBOX_NAME" sessions --json 2>&1)" || {
    fail "TC-SESS-01: sessions --json exited non-zero"
    info "$out"
    return 1
  }
  if ! is_valid_json "$out"; then
    fail "TC-SESS-01: sessions --json did not return parseable JSON"
    info "$out"
    return 1
  fi
  pass "TC-SESS-01: sessions --json returned valid JSON"
}

test_sessions_list_json() {
  section "TC-SESS-02: sessions list --json"
  local out
  out="$(nemoclaw "$SANDBOX_NAME" sessions list --json 2>&1)" || {
    fail "TC-SESS-02: sessions list --json exited non-zero"
    info "$out"
    return 1
  }
  if ! is_valid_json "$out"; then
    fail "TC-SESS-02: sessions list --json did not return parseable JSON"
    info "$out"
    return 1
  fi
  pass "TC-SESS-02: sessions list --json returned valid JSON"
}

test_sessions_reset_main() {
  section "TC-SESS-03: sessions reset agent:main:main --json"
  local out
  out="$(nemoclaw "$SANDBOX_NAME" sessions reset agent:main:main --json 2>&1)" || {
    fail "TC-SESS-03: sessions reset exited non-zero"
    info "$out"
    return 1
  }
  if ! is_valid_json "$out"; then
    fail "TC-SESS-03: sessions reset --json did not return parseable JSON"
    info "$out"
    return 1
  fi
  pass "TC-SESS-03: sessions reset succeeded and returned JSON"
}

test_sessions_list_after_reset() {
  section "TC-SESS-04: sessions list --json after reset"
  local out
  out="$(nemoclaw "$SANDBOX_NAME" sessions list --json 2>&1)" || {
    fail "TC-SESS-04: sessions list --json exited non-zero after reset"
    info "$out"
    return 1
  }
  if ! is_valid_json "$out"; then
    fail "TC-SESS-04: sessions list --json after reset did not return parseable JSON"
    info "$out"
    return 1
  fi
  pass "TC-SESS-04: sessions list --json after reset returned valid JSON"
}

test_agents_add_passthrough() {
  section "TC-AGENT-01: agents add ${TEST_AGENT_ID} (passthrough wizard)"
  local add_out
  if ! add_out="$(nemoclaw "$SANDBOX_NAME" agents add "$TEST_AGENT_ID" --non-interactive 2>&1)"; then
    fail "TC-AGENT-01: agents add ${TEST_AGENT_ID} exited non-zero"
    info "$add_out"
    return 1
  fi
  # Assert the agent landed in the in-sandbox OpenClaw agents store. We use
  # the host-side `sessions list --agent <id>` gateway call because it is the
  # exact path real users hit and it fails if OpenClaw does not know the
  # agent. A passthrough exit status alone is not sufficient evidence that
  # `agents add` actually created the agent.
  local list_out
  if ! list_out="$(nemoclaw "$SANDBOX_NAME" sessions list --agent "$TEST_AGENT_ID" --json 2>&1)"; then
    fail "TC-AGENT-01: agent '${TEST_AGENT_ID}' not visible via sessions list after add"
    info "$list_out"
    return 1
  fi
  if ! is_valid_json "$list_out"; then
    fail "TC-AGENT-01: sessions list --agent '${TEST_AGENT_ID}' did not return parseable JSON after add"
    info "$list_out"
    return 1
  fi
  pass "TC-AGENT-01: agents add ${TEST_AGENT_ID} passthrough created the agent"
}

seed_agent_session() {
  section "Seed session for agent '${TEST_AGENT_ID}'"
  if ! nemoclaw "$SANDBOX_NAME" exec -- openclaw agent --agent "$TEST_AGENT_ID" -m "ping" 2>&1; then
    fail "seed: agent '${TEST_AGENT_ID}' invocation failed after agents add succeeded"
    return 1
  fi
  pass "seed: sent one prompt to agent '${TEST_AGENT_ID}'"
}

test_sessions_delete_non_main() {
  section "TC-SESS-05: sessions delete on a non-main session"
  local key
  key="$(nemoclaw "$SANDBOX_NAME" sessions list --agent "$TEST_AGENT_ID" --json 2>/dev/null \
    | python3 -c "import json,sys; sessions=json.loads(sys.stdin.read()); print(next((s['key'] for s in (sessions if isinstance(sessions, list) else sessions.get('sessions', [])) if s.get('key') and not s['key'].endswith(':main')), ''))" \
      2>/dev/null || true)"
  if [ -z "$key" ]; then
    fail "TC-SESS-05: no non-main session key found for agent '${TEST_AGENT_ID}'; expected the seeded prompt to create one"
    return 1
  fi
  if ! nemoclaw "$SANDBOX_NAME" sessions delete "$key" --json 2>&1; then
    fail "TC-SESS-05: sessions delete ${key} exited non-zero"
    return 1
  fi
  # Assert the deleted key really is gone, not just that delete returned 0.
  local after_keys
  after_keys="$(nemoclaw "$SANDBOX_NAME" sessions list --agent "$TEST_AGENT_ID" --json 2>/dev/null \
    | python3 -c "import json,sys; sessions=json.loads(sys.stdin.read()); print('\n'.join([s.get('key', '') for s in (sessions if isinstance(sessions, list) else sessions.get('sessions', []))]))" \
      2>/dev/null || true)"
  if printf '%s\n' "$after_keys" | grep -Fxq "$key"; then
    fail "TC-SESS-05: session key '${key}' still present after delete"
    return 1
  fi
  pass "TC-SESS-05: sessions delete ${key} succeeded and the key is gone"
}

test_agents_delete_passthrough() {
  section "TC-AGENT-02: agents delete ${TEST_AGENT_ID} --force --json"
  local out
  if ! out="$(nemoclaw "$SANDBOX_NAME" agents delete "$TEST_AGENT_ID" --force --json 2>&1)"; then
    fail "TC-AGENT-02: agents delete ${TEST_AGENT_ID} exited non-zero"
    info "$out"
    return 1
  fi
  # Assert the agent is actually gone: a follow-up `sessions list --agent <id>`
  # should no longer return a valid JSON listing for it. A successful exit on
  # the delete call alone does not prove the agent was removed.
  local follow_out
  if follow_out="$(nemoclaw "$SANDBOX_NAME" sessions list --agent "$TEST_AGENT_ID" --json 2>&1)" \
    && is_valid_json "$follow_out"; then
    fail "TC-AGENT-02: agent '${TEST_AGENT_ID}' still visible via sessions list after delete"
    info "$follow_out"
    return 1
  fi
  pass "TC-AGENT-02: agents delete ${TEST_AGENT_ID} passthrough removed the agent"
}

preflight
onboard_sandbox
if seed_main_session; then
  test_sessions_default_json
  test_sessions_list_json
  test_sessions_reset_main
  test_sessions_list_after_reset
else
  skip "TC-SESS-01: skipped (seed_main_session failed)"
  skip "TC-SESS-02: skipped (seed_main_session failed)"
  skip "TC-SESS-03: skipped (seed_main_session failed)"
  skip "TC-SESS-04: skipped (seed_main_session failed)"
fi

# Agents add/delete and non-main session delete are feature-critical for this
# CLI surface — any failure must fail the whole job rather than be skipped.
test_agents_add_passthrough
seed_agent_session
test_sessions_delete_non_main
test_agents_delete_passthrough

print_summary
