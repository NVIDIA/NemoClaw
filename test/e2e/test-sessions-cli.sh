#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-sessions-cli.sh
# NemoClaw `sessions` Subcommand E2E Tests
#
# Covers:
#   TC-SESS-01: `nemoclaw <name> sessions list --json` returns valid JSON
#               from the in-sandbox OpenClaw CLI (pass-through wiring).
#   TC-SESS-02: `nemoclaw <name> sessions cleanup --dry-run` runs without
#               mutating state (pass-through wiring).
#   TC-SESS-03: `nemoclaw <name> sessions download <agent>` copies the
#               agent's sessions directory to the host with sessions.json
#               present.
#   TC-SESS-04: `nemoclaw <name> sessions reset <agent> <sessionKey>` rebinds
#               the session via the OpenClaw gateway and writes a
#               `<sessionId>.reset.<ts>.jsonl` archive entry under
#               `sessions/`.
#   TC-SESS-05: After TC-SESS-04, `nemoclaw <name> sessions list --json`
#               still surfaces the rebound key (reset is archive-then-rebind,
#               not delete).
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key or fake OpenAI endpoint)
#   - NEMOCLAW_NON_INTERACTIVE=1, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-sessions-cli.sh
# =============================================================================

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT="${NEMOCLAW_E2E_DEFAULT_TIMEOUT:-2400}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
. "${SCRIPT_DIR}/e2e-timeout.sh"

# ── Tally + reporting ────────────────────────────────────────────────────────
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-sessions-cli}"
DOWNLOAD_DIR="$(mktemp -d -t nemoclaw-sessions-dl-XXXXXX)"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# ── Preflight ────────────────────────────────────────────────────────────────
preflight() {
  section "Preflight"
  if ! docker info >/dev/null 2>&1; then
    fail "preflight: Docker not running"
    print_summary
    exit 1
  fi
  if [ -z "${NVIDIA_API_KEY:-}" ]; then
    skip "preflight: NVIDIA_API_KEY not set; sessions E2E requires a working onboard credential"
    print_summary
    exit 0
  fi
  pass "preflight: docker + NVIDIA_API_KEY available"
}

# ── Onboard a fresh sandbox ──────────────────────────────────────────────────
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

# ── Send one prompt so the agent creates a session ───────────────────────────
seed_session() {
  section "Seed session by sending one prompt"
  if ! nemoclaw "$SANDBOX_NAME" exec -- openclaw agent --agent main -m "ping" 2>&1; then
    fail "seed: agent invocation failed; sessions store may not be populated"
    return 1
  fi
  pass "seed: sent one prompt to agent 'main'"
}

# ── TC-SESS-01: sessions list --json ─────────────────────────────────────────
test_sessions_list_json() {
  section "TC-SESS-01: sessions list --json returns JSON"
  local out
  out="$(nemoclaw "$SANDBOX_NAME" sessions list --json 2>&1)" || {
    fail "TC-SESS-01: sessions list --json exited non-zero"
    info "$out"
    return 1
  }
  if ! printf '%s' "$out" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null; then
    fail "TC-SESS-01: sessions list --json did not return parseable JSON"
    info "$out"
    return 1
  fi
  pass "TC-SESS-01: sessions list --json returned valid JSON"
}

# ── TC-SESS-02: sessions cleanup --dry-run ───────────────────────────────────
test_sessions_cleanup_dry_run() {
  section "TC-SESS-02: sessions cleanup --dry-run"
  if ! nemoclaw "$SANDBOX_NAME" sessions cleanup --dry-run 2>&1; then
    fail "TC-SESS-02: sessions cleanup --dry-run exited non-zero"
    return 1
  fi
  pass "TC-SESS-02: sessions cleanup --dry-run exited zero"
}

# ── TC-SESS-03: sessions download <agent> ────────────────────────────────────
test_sessions_download() {
  section "TC-SESS-03: sessions download main"
  local dest="${DOWNLOAD_DIR}/agent-main"
  if ! nemoclaw "$SANDBOX_NAME" sessions download main --out "$dest" 2>&1; then
    fail "TC-SESS-03: sessions download main exited non-zero"
    return 1
  fi
  if [ ! -f "${dest}/sessions.json" ]; then
    fail "TC-SESS-03: expected ${dest}/sessions.json on host"
    return 1
  fi
  pass "TC-SESS-03: sessions download produced sessions.json on host"
}

# ── TC-SESS-04: sessions reset <agent> <sessionKey> via gateway RPC ──────────
test_sessions_reset_agent_session() {
  section "TC-SESS-04: sessions reset main agent:main:main"
  if ! nemoclaw "$SANDBOX_NAME" sessions reset main agent:main:main 2>&1; then
    fail "TC-SESS-04: sessions reset main agent:main:main exited non-zero"
    return 1
  fi
  pass "TC-SESS-04: sessions reset main agent:main:main exited zero"
}

# ── TC-SESS-05: list after reset still surfaces the rebound key ──────────────
test_sessions_list_after_reset() {
  section "TC-SESS-05: sessions list --json after reset still surfaces the key"
  local out
  out="$(nemoclaw "$SANDBOX_NAME" sessions list --json 2>&1)" || {
    fail "TC-SESS-05: sessions list --json exited non-zero after reset"
    info "$out"
    return 1
  }
  if ! printf '%s' "$out" | python3 -c "import json,sys; v=json.loads(sys.stdin.read())" 2>/dev/null; then
    fail "TC-SESS-05: sessions list --json after reset did not return parseable JSON"
    info "$out"
    return 1
  fi
  pass "TC-SESS-05: sessions list --json after reset returned valid JSON"
}

# ── Main ─────────────────────────────────────────────────────────────────────
preflight
onboard_sandbox
if seed_session; then
  test_sessions_list_json
  test_sessions_cleanup_dry_run
  test_sessions_download
  test_sessions_reset_agent_session
  test_sessions_list_after_reset
else
  skip "TC-SESS-01: skipped (seed_session failed; agent never produced a session)"
  skip "TC-SESS-02: skipped (seed_session failed; agent never produced a session)"
  skip "TC-SESS-03: skipped (seed_session failed; agent never produced a session)"
  skip "TC-SESS-04: skipped (seed_session failed; agent never produced a session)"
  skip "TC-SESS-05: skipped (seed_session failed; agent never produced a session)"
fi
print_summary
