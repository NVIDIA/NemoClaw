#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Deep Agents Code interactive TUI startup (#5620).
#
# This live check runs against a real Deep Agents Code sandbox. It proves the
# interactive `dcode` TUI starts in a PTY, reaches a prompt-like startup state,
# exits after Ctrl-C, and leaves only sanitized, secret-free capture artifacts.
#
# shellcheck disable=SC2016
# expect(1) Tcl: $env(...) and {...} are Tcl/sh expansion, not bash expansion.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-onboard}}"
PREFIX="10-deepagents-code-tui-startup"
TUI_TIMEOUT="${DEEPAGENTS_TUI_TIMEOUT:-90}"
SECRET_PATTERN='nvapi-[A-Za-z0-9_-]{10,}|nvcf-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|(xox[bpas]|xapp)-[A-Za-z0-9-]{10,}|A(K|S)IA[A-Z0-9]{16}|hf_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|pypi-[A-Za-z0-9_-]{10,}|bot[0-9]{8,10}:[A-Za-z0-9_-]{35}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}'

ok() { printf '%s\n' "${PREFIX}: OK ($*)"; }
info() { printf '%s\n' "${PREFIX}: $*"; }
fail_test() {
  printf '%s\n' "${PREFIX}: FAIL: $1" >&2
  FAILED=$((FAILED + 1))
}
pass() {
  ok "$1"
  PASSED=$((PASSED + 1))
}

sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c "$1" 2>&1
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

contains_secret() {
  grep -Eq "$SECRET_PATTERN"
}

strip_terminal_control_sequences() {
  perl -pe 's/\x1b\][^\a]*(?:\a|\x1b\\)//g; s/\x1b\[[0-9;?]*[ -\/]*[@-~]//g; s/\r/\n/g'
}

make_capture_dir() {
  if [ -n "${DEEPAGENTS_TUI_CAPTURE_DIR:-}" ]; then
    mkdir -p "$DEEPAGENTS_TUI_CAPTURE_DIR"
    printf '%s\n' "$DEEPAGENTS_TUI_CAPTURE_DIR"
  else
    mktemp -d "${TMPDIR:-/tmp}/${PREFIX}.XXXXXX"
  fi
}

run_tui_expect() {
  local raw_capture_file="$1"
  env \
    NEMOCLAW_TUI_CAPTURE="$raw_capture_file" \
    NEMOCLAW_TUI_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_TUI_TIMEOUT="$TUI_TIMEOUT" \
    expect <<'EXPECT'
set timeout $env(NEMOCLAW_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_TUI_SANDBOX_NAME)
set capture $env(NEMOCLAW_TUI_CAPTURE)
log_file -a $capture

spawn openshell sandbox exec --name $sandbox --tty -- sh -lc {export TERM=xterm-256color; cd /sandbox; dcode; status=$?; printf "\nNEMOCLAW_TUI_EXIT:%s\n" "$status"}
expect {
  -nocase -re {(deep agents|what would you like|what do you want|enter (your )?(task|message|prompt)|describe (the )?(task|change)|how can i help|press enter)} {
    puts "\nNEMOCLAW_TUI_READY"
    send -- "\003"
  }
  timeout {
    puts "\nNEMOCLAW_TUI_TIMEOUT"
    send -- "\003"
    exit 20
  }
  eof {
    puts "\nNEMOCLAW_TUI_EOF_BEFORE_READY"
    exit 21
  }
}

set timeout 20
expect {
  -re {NEMOCLAW_TUI_EXIT:([0-9]+)} {
    puts "\nNEMOCLAW_TUI_EXIT_CAPTURED:$expect_out(1,string)"
    exit 0
  }
  timeout {
    puts "\nNEMOCLAW_TUI_EXIT_TIMEOUT"
    send -- "\003"
    exit 22
  }
  eof {
    puts "\nNEMOCLAW_TUI_EOF_BEFORE_EXIT"
    exit 23
  }
}
EXPECT
}

assert_clean_exit_code() {
  local plain_capture_file="$1"
  local exit_code
  exit_code="$(sed -n 's/.*NEMOCLAW_TUI_EXIT_CAPTURED:\([0-9]\+\).*/\1/p' "$plain_capture_file" | tail -n1)"
  if [ -z "$exit_code" ]; then
    fail_test "TUI capture did not include an exit-status marker"
    return
  fi
  case "$exit_code" in
    0 | 1 | 130) pass "dcode TUI exited cleanly after Ctrl-C (exit ${exit_code})" ;;
    *) fail_test "dcode TUI exited with unexpected status ${exit_code}" ;;
  esac
}

PASSED=0
FAILED=0

main() {
  if ! is_positive_integer "$TUI_TIMEOUT"; then
    fail_test "DEEPAGENTS_TUI_TIMEOUT must be a positive integer"
    printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
    exit 1
  fi

  if ! command -v expect >/dev/null 2>&1; then
    fail_test "expect is required for the Deep Agents Code TUI startup check"
    printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
    exit 1
  fi

  if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
    info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
    exit 0
  fi

  local capture_dir raw_capture_file expect_log_file combined_capture_file plain_capture_file
  capture_dir="$(make_capture_dir)"
  raw_capture_file="${capture_dir}/${PREFIX}.raw.log"
  expect_log_file="${capture_dir}/${PREFIX}.expect.log"
  combined_capture_file="${capture_dir}/${PREFIX}.combined.log"
  plain_capture_file="${capture_dir}/${PREFIX}.sanitized.log"
  : >"$raw_capture_file"
  : >"$expect_log_file"

  info "Running Deep Agents Code TUI startup check in sandbox: $SANDBOX_NAME"
  info "Capture directory: $capture_dir"

  set +e
  run_tui_expect "$raw_capture_file" >"$expect_log_file" 2>&1
  local expect_rc
  expect_rc=$?
  set -e

  cat "$raw_capture_file" "$expect_log_file" >"$combined_capture_file"
  strip_terminal_control_sequences <"$combined_capture_file" >"$plain_capture_file"

  if [ "$expect_rc" -eq 0 ]; then
    pass "finite expect harness reached startup and observed exit"
  else
    fail_test "finite expect harness exited ${expect_rc}"
  fi

  if grep -q "NEMOCLAW_TUI_READY" "$plain_capture_file"; then
    pass "dcode TUI rendered a usable startup prompt signature"
  else
    fail_test "dcode TUI prompt-ready marker missing from capture"
  fi

  assert_clean_exit_code "$plain_capture_file"

  if contains_secret <"$plain_capture_file"; then
    fail_test "secret-shaped value found in sanitized TUI capture"
  else
    pass "sanitized TUI capture does not contain secret-shaped values"
  fi

  printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
  info "sanitized capture: ${plain_capture_file}"
  [ "$FAILED" -eq 0 ] || exit 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
