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
#   TC-AGENT-03: `nemoclaw <name> agents list --json`
#               (passthrough lister; OpenClaw owns gateway dispatch)
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

# Silence Node.js experimental-feature warnings (e.g. UNDICI-EHPA "EnvHttpProxyAgent
# is experimental") from every `nemoclaw` invocation. These warnings go to stderr
# but every JSON-capture below uses `2>&1` for diagnostics-on-failure, so without
# this they would prefix the JSON payload and break `python -c json.loads`.
export NODE_NO_WARNINGS=1

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

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INSTALL_LOG="${E2E_SESSIONS_AGENTS_INSTALL_LOG:-/tmp/nemoclaw-e2e-install.log}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# shellcheck source=test/e2e/lib/install-path-refresh.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/install-path-refresh.sh"

install_nemoclaw_from_source() {
  section "Install NemoClaw from source (install.sh --non-interactive)"
  if command -v nemoclaw >/dev/null 2>&1; then
    info "nemoclaw already on PATH at $(command -v nemoclaw); skipping install"
    pass "install: nemoclaw already available"
    return 0
  fi
  if [ ! -x "${REPO_ROOT}/install.sh" ]; then
    fail "install: ${REPO_ROOT}/install.sh missing or not executable"
    print_summary
    exit 1
  fi
  if ! bash "${REPO_ROOT}/install.sh" --non-interactive >"$INSTALL_LOG" 2>&1; then
    info "install.sh exited non-zero (may be benign on re-install); verifying PATH"
  fi
  nemoclaw_refresh_install_env
  if ! command -v nemoclaw >/dev/null 2>&1; then
    fail "install: nemoclaw not found on PATH after install.sh (see ${INSTALL_LOG})"
    print_summary
    exit 1
  fi
  pass "install: nemoclaw installed at $(command -v nemoclaw)"
}

is_valid_json() {
  # Tolerate leading non-JSON lines on stdout (Node deprecation warnings, oclif
  # banner) by scanning for the first line that begins with `{` or `[` and
  # parsing from there. Anchoring at line-start avoids false positives like the
  # `[UNDICI-EHPA]` token inside Node warning text. `NODE_NO_WARNINGS=1` already
  # suppresses the known UNDICI-EHPA warning, but this stays defensive against
  # any future stderr leakage when a JSON-capture uses `2>&1`.
  printf '%s' "$1" | python3 -c "
import json, sys
raw = sys.stdin.read()
offset = -1
cursor = 0
for line in raw.splitlines(keepends=True):
  if line.startswith('{') or line.startswith('['):
    offset = cursor
    break
  cursor += len(line)
if offset < 0:
  sys.exit(1)
json.loads(raw[offset:])
" 2>/dev/null
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

# Approve any pending OpenClaw CLI device-pairing / scope-upgrade requests so
# downstream `openclaw gateway call ...` invocations (used by `sessions reset`
# and `sessions delete`) do not fall back to the embedded agent. The
# `nemoclaw-start.sh` auto-pair watcher allowlists `cli` / `openclaw-control-ui`
# clients, but a fresh CI sandbox can race the watcher's slow-mode polling on
# late scope upgrades; this loop is defensive and idempotent.
approve_pending_pairing_requests() {
  section "Approve any pending OpenClaw pairing / scope-upgrade requests"
  local max_iters=10
  local interval=3
  local i state ids
  for ((i = 0; i < max_iters; i++)); do
    state="$(nemoclaw "$SANDBOX_NAME" exec -- openclaw devices list --json 2>/dev/null || true)"
    if [ -z "$state" ]; then
      sleep "$interval"
      continue
    fi
    ids="$(printf '%s' "$state" | python3 -c "
import json, sys
try:
  data = json.loads(sys.stdin.read())
except Exception:
  sys.exit(0)
pending = data.get('pending') or []
for d in pending:
  if not isinstance(d, dict):
    continue
  rid = d.get('requestId') or d.get('id')
  if rid:
    print(rid)
" 2>/dev/null || true)"
    if [ -z "$ids" ]; then
      pass "gateway scope: no pending pairing/scope-upgrade requests"
      return 0
    fi
    while IFS= read -r rid; do
      [ -z "$rid" ] && continue
      info "approving pending request '$rid'"
      nemoclaw "$SANDBOX_NAME" exec -- openclaw devices approve "$rid" --json >/dev/null 2>&1 || true
    done <<<"$ids"
    sleep "$interval"
  done
  info "gateway scope: gave up after $((max_iters * interval))s; gateway-RPC tests may still hit pending-scope failures"
  return 1
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
  local out exit_code attempt=1 max_attempts=5 backoff=4
  # The first invocation of any new gateway-RPC method (here `sessions.reset`)
  # can itself trigger a fresh CLI scope-upgrade request that the auto-pair
  # watcher only approves asynchronously. Retry while approving any pending
  # requests between attempts, until the gateway accepts the scope or we run
  # out of attempts.
  while [ "$attempt" -le "$max_attempts" ]; do
    if out="$(nemoclaw "$SANDBOX_NAME" sessions reset agent:main:main --json 2>&1)"; then
      exit_code=0
      break
    else
      exit_code=$?
    fi
    if ! grep -qE "scope upgrade pending|Failed to reach the OpenClaw gateway|pairing required" <<<"$out"; then
      break
    fi
    info "TC-SESS-03: gateway scope still pending (attempt ${attempt}/${max_attempts}); approving and retrying"
    approve_pending_pairing_requests >/dev/null 2>&1 || true
    sleep "$backoff"
    attempt=$((attempt + 1))
  done
  if [ "$exit_code" -ne 0 ]; then
    fail "TC-SESS-03: sessions reset exited non-zero"
    info "$out"
    return 1
  fi
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
  # OpenClaw's `agents add --non-interactive` mandates --workspace; the wizard
  # only fills it interactively. Pass the canonical secondary-agent workspace
  # path reserved by the in-sandbox layout.
  if ! add_out="$(nemoclaw "$SANDBOX_NAME" agents add "$TEST_AGENT_ID" \
    --workspace "/sandbox/.openclaw/workspace-${TEST_AGENT_ID}" \
    --non-interactive 2>&1)"; then
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
  # A session under `--agent <work-agent-id>` is by definition non-main: the
  # original main session for the primary `main` agent never appears in this
  # filtered list. Take the first key for the work agent; an earlier filter
  # that excluded keys ending with `:main` mishandled the canonical case where
  # the secondary agent's default slot is also `main` (key `agent:work:main`).
  key="$(nemoclaw "$SANDBOX_NAME" sessions list --agent "$TEST_AGENT_ID" --json 2>/dev/null \
    | python3 -c "import json,sys; sessions=json.loads(sys.stdin.read()); print(next((s['key'] for s in (sessions if isinstance(sessions, list) else sessions.get('sessions', [])) if s.get('key')), ''))" \
      2>/dev/null || true)"
  if [ -z "$key" ]; then
    fail "TC-SESS-05: no session key found for agent '${TEST_AGENT_ID}'; expected the seeded prompt to create one"
    return 1
  fi
  local del_out del_code attempt=1 max_attempts=5 backoff=4
  while [ "$attempt" -le "$max_attempts" ]; do
    if del_out="$(nemoclaw "$SANDBOX_NAME" sessions delete "$key" --json 2>&1)"; then
      del_code=0
      break
    else
      del_code=$?
    fi
    if ! grep -qE "scope upgrade pending|Failed to reach the OpenClaw gateway|pairing required" <<<"$del_out"; then
      break
    fi
    info "TC-SESS-05: gateway scope still pending (attempt ${attempt}/${max_attempts}); approving and retrying"
    approve_pending_pairing_requests >/dev/null 2>&1 || true
    sleep "$backoff"
    attempt=$((attempt + 1))
  done
  if [ "$del_code" -ne 0 ]; then
    fail "TC-SESS-05: sessions delete ${key} exited non-zero"
    info "$del_out"
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

test_agents_list_passthrough() {
  section "TC-AGENT-03: agents list --json (passthrough)"
  local out
  if ! out="$(nemoclaw "$SANDBOX_NAME" agents list --json 2>&1)"; then
    fail "TC-AGENT-03: agents list --json exited non-zero"
    info "$out"
    return 1
  fi
  if ! is_valid_json "$out"; then
    fail "TC-AGENT-03: agents list --json did not return parseable JSON"
    info "$out"
    return 1
  fi
  # The previously added secondary agent must appear in the listing. A pure
  # exit-status check does not prove the passthrough reached the gateway.
  # Mirror `is_valid_json`'s prefix-strip so Node warning lines that escape
  # `NODE_NO_WARNINGS=1` (via openshell sub-invocations) don't break the parse.
  if ! printf '%s' "$out" | TARGET="$TEST_AGENT_ID" python3 -c "
import json, os, sys
raw = sys.stdin.read()
offset = -1
cursor = 0
for line in raw.splitlines(keepends=True):
  if line.startswith('{') or line.startswith('['):
    offset = cursor
    break
  cursor += len(line)
if offset < 0:
  sys.exit(1)
data = json.loads(raw[offset:])
entries = data if isinstance(data, list) else data.get('agents', [])
target = os.environ['TARGET']
sys.exit(0 if any(entry.get('id') == target for entry in entries) else 1)
" 2>/dev/null; then
    fail "TC-AGENT-03: agent '${TEST_AGENT_ID}' not present in agents list --json output"
    info "$out"
    return 1
  fi
  pass "TC-AGENT-03: agents list --json surfaced agent '${TEST_AGENT_ID}'"
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
install_nemoclaw_from_source
onboard_sandbox
approve_pending_pairing_requests
if seed_main_session; then
  # The seed prompt itself may have triggered a scope-upgrade request — drain
  # again before the first gateway-RPC test (TC-SESS-03) so the call does not
  # land on a still-pending scope.
  approve_pending_pairing_requests
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
test_agents_list_passthrough
seed_agent_session
approve_pending_pairing_requests
test_sessions_delete_non_main
test_agents_delete_passthrough

print_summary
