#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Local end-to-end test for the Slack channel guard (install_slack_channel_guard)
# from nemoclaw-start.sh.
#
# Extracts the guard's JS preload from the shell script, then runs Node.js
# scenarios that simulate Slack-style unhandled rejections and uncaught
# exceptions to verify the guard catches them without crashing the process,
# while still letting non-Slack errors through.
#
# Usage:  bash test/local-slack-auth-test.sh
#
# Requirements: node (v22+), bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
START_SCRIPT="$SCRIPT_DIR/../scripts/nemoclaw-start.sh"
PASS=0
FAIL=0

# ── Helpers ──────────────────────────────────────────────────────

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }

pass() {
  green "  PASS: $1"
  PASS=$((PASS + 1))
}
fail() {
  red "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

header() { printf '\n── %s ──\n' "$1"; }

# ── Extract the guard JS from the shell script ──────────────────

TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT

GUARD_JS="$TMPDIR_BASE/slack-channel-guard.js"

# The JS is between the line containing <<'SLACK_GUARD_EOF' and the closing SLACK_GUARD_EOF
sed -n "/<<'SLACK_GUARD_EOF'$/,/^SLACK_GUARD_EOF$/p" "$START_SCRIPT" \
  | sed '1d;$d' >"$GUARD_JS"

if [ ! -s "$GUARD_JS" ]; then
  echo "ERROR: could not extract guard JS from $START_SCRIPT" >&2
  exit 1
fi

echo "Extracted guard JS ($(wc -l <"$GUARD_JS") lines)"

# ── Test runner ─────────────────────────────────────────────────
# Runs node with the guard preloaded, executing inline JS.
# Captures stderr and exit code.

run_node() {
  local script="$1"
  local stderr_file="$TMPDIR_BASE/stderr.log"
  local exit_code=0

  node --require "$GUARD_JS" -e "$script" 2>"$stderr_file" || exit_code=$?

  LAST_STDERR=$(cat "$stderr_file")
  LAST_EXIT=$exit_code
}

# ══════════════════════════════════════════════════════════════════
# TESTS
# ══════════════════════════════════════════════════════════════════

header "T1: Slack unhandled rejection (invalid_auth) — should be caught"
run_node "
  var err = new Error('An API error occurred: invalid_auth');
  err.code = 'slack_webapi_platform_error';
  Promise.reject(err);
  setTimeout(function() { console.log('ALIVE'); }, 200);
"

if [ "$LAST_EXIT" -eq 0 ] && echo "$LAST_STDERR" | grep -q "caught by safety net"; then
  pass "invalid_auth rejection caught, process survived (exit=$LAST_EXIT)"
else
  fail "expected guard to catch, got exit=$LAST_EXIT stderr='$LAST_STDERR'"
fi

# ──────────────────────────────────────────────────────────────────

header "T2: Slack unhandled rejection (token_revoked) — should be caught"
run_node "
  var err = new Error('token_revoked');
  err.code = 'slack_webapi_platform_error';
  Promise.reject(err);
  setTimeout(function() { console.log('ALIVE'); }, 200);
"

if [ "$LAST_EXIT" -eq 0 ] && echo "$LAST_STDERR" | grep -q "caught by safety net"; then
  pass "token_revoked rejection caught (exit=$LAST_EXIT)"
else
  fail "expected guard to catch, got exit=$LAST_EXIT stderr='$LAST_STDERR'"
fi

# ──────────────────────────────────────────────────────────────────

header "T3: Slack rejection detected by stack trace (@slack/ in stack)"
run_node "
  var err = new Error('something went wrong');
  err.stack = 'Error: something\n    at Object.<anonymous> (node_modules/@slack/web-api/src/WebClient.ts:405:36)';
  Promise.reject(err);
  setTimeout(function() { console.log('ALIVE'); }, 200);
"

if [ "$LAST_EXIT" -eq 0 ] && echo "$LAST_STDERR" | grep -q "caught by safety net"; then
  pass "stack-trace detection works (exit=$LAST_EXIT)"
else
  fail "expected guard to catch via stack, got exit=$LAST_EXIT stderr='$LAST_STDERR'"
fi

# ──────────────────────────────────────────────────────────────────

header "T4: Non-Slack rejection — should NOT be caught (re-thrown)"
run_node "
  Promise.reject(new Error('database connection failed'));
  setTimeout(function() { console.log('SHOULD NOT REACH'); }, 200);
"

if [ "$LAST_EXIT" -ne 0 ]; then
  pass "non-Slack rejection re-thrown, process exited (exit=$LAST_EXIT)"
else
  fail "expected process to crash on non-Slack error, got exit=$LAST_EXIT"
fi

# ──────────────────────────────────────────────────────────────────

header "T5: Slack sync exception (uncaughtException) — should be caught"
run_node "
  var err = new Error('invalid_auth');
  err.code = 'slack_webapi_platform_error';
  throw err;
"

if [ "$LAST_EXIT" -eq 0 ] && echo "$LAST_STDERR" | grep -q "caught by safety net"; then
  pass "sync Slack exception caught (exit=$LAST_EXIT)"
else
  fail "expected guard to catch sync throw, got exit=$LAST_EXIT stderr='$LAST_STDERR'"
fi

# ──────────────────────────────────────────────────────────────────

header "T6: Non-Slack sync exception — should crash"
run_node "
  throw new Error('out of memory');
"

if [ "$LAST_EXIT" -ne 0 ]; then
  pass "non-Slack exception crashes as expected (exit=$LAST_EXIT)"
else
  fail "expected crash on non-Slack exception, got exit=$LAST_EXIT"
fi

# ──────────────────────────────────────────────────────────────────

header "T7: Guard logs include the error message"
run_node "
  var err = new Error('An API error occurred: invalid_auth');
  err.code = 'slack_webapi_platform_error';
  Promise.reject(err);
  setTimeout(function() {}, 200);
"

if echo "$LAST_STDERR" | grep -q "provider failed to start.*invalid_auth"; then
  pass "log message includes the Slack error details"
else
  fail "log missing error details, got: '$LAST_STDERR'"
fi

# ──────────────────────────────────────────────────────────────────

header "T8: Normal operation — no errors, guard is invisible"
run_node "
  console.log('hello');
  setTimeout(function() { console.log('done'); }, 100);
"

if [ "$LAST_EXIT" -eq 0 ] && [ -z "$LAST_STDERR" ]; then
  pass "guard is invisible during normal operation (exit=$LAST_EXIT)"
else
  fail "guard interfered with normal operation, exit=$LAST_EXIT stderr='$LAST_STDERR'"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════"
printf "  Results: "
green "$PASS passed"
if [ "$FAIL" -gt 0 ]; then
  printf "           "
  red "$FAIL failed"
fi
echo "═══════════════════════════════════════"

exit "$FAIL"
