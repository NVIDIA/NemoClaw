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
# Shell-only live check fallback for remote e2e hosts; Vitest parity coverage in
# test/deepagents-code-tui-startup-check.test.ts pins this to secret-patterns.ts.
SECRET_PATTERN='(?:nvapi-[A-Za-z0-9_-]{10,}|nvcf-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}|A(?:K|S)IA[A-Z0-9]{16}|hf_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|pypi-[A-Za-z0-9_-]{10,}|\bbot[0-9]{8,10}:[A-Za-z0-9_-]{35}\b|\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b|\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b)'
CONTEXT_SECRET_VALUE_PATTERN='[A-Za-z0-9_.+\/=-]{10,}'
# Upstream dcode does not expose a stable machine-readable TUI ready marker.
# Keep this localized heuristic prompt-shaped; do not match banner-only text.
TUI_READY_PATTERN='(what would you like|what do you want|enter (your )?(task|message|prompt)|describe (the )?(task|change)|how can i help)'
SENSITIVE_CAPTURE_FILES=()

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

ensure_expect_available() {
  if command -v expect >/dev/null 2>&1; then
    return 0
  fi
  if [ "${GITHUB_ACTIONS:-}" = "true" ] && command -v sudo >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    info "expect is not preinstalled; installing expect for the Deep Agents Code TUI PTY check"
    if sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends expect; then
      command -v expect >/dev/null 2>&1
      return $?
    fi
  fi
  return 1
}

contains_secret() {
  NEMOCLAW_TOKEN_SECRET_PATTERN="$SECRET_PATTERN" \
    NEMOCLAW_CONTEXT_SECRET_VALUE_PATTERN="$CONTEXT_SECRET_VALUE_PATTERN" \
    perl -0ne '
      BEGIN {
        $token_pattern = $ENV{"NEMOCLAW_TOKEN_SECRET_PATTERN"};
        $context_value_pattern = $ENV{"NEMOCLAW_CONTEXT_SECRET_VALUE_PATTERN"};
      }
      if (
        /$token_pattern/ ||
        /Bearer\s+$context_value_pattern/i ||
        /(?:_KEY|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[=: ]["'\''"]?$context_value_pattern/i
      ) {
        $found = 1;
      }
      END { exit($found ? 0 : 1) }
    '
}

redact_secrets() {
  NEMOCLAW_TOKEN_SECRET_PATTERN="$SECRET_PATTERN" \
    NEMOCLAW_CONTEXT_SECRET_VALUE_PATTERN="$CONTEXT_SECRET_VALUE_PATTERN" \
    perl -0pe '
      BEGIN {
        $token_pattern = $ENV{"NEMOCLAW_TOKEN_SECRET_PATTERN"};
        $context_value_pattern = $ENV{"NEMOCLAW_CONTEXT_SECRET_VALUE_PATTERN"};
      }
      s/$token_pattern/[REDACTED_SECRET]/g;
      s/(Bearer\s+)$context_value_pattern/${1}[REDACTED_SECRET]/gi;
      s/((?:_KEY|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[=: ]["'\''"]?)$context_value_pattern/${1}[REDACTED_SECRET]/gi;
    '
}

redact_secrets_in_file() {
  local target_file="$1"
  local redacted_file
  redacted_file="${target_file}.redacted.$$"
  if redact_secrets <"$target_file" >"$redacted_file"; then
    mv -- "$redacted_file" "$target_file"
  else
    rm -f -- "$redacted_file"
    if ! printf '%s\n' "[redaction failed; sanitized capture unavailable]" >"$target_file"; then
      rm -f -- "$target_file"
    fi
    fail_test "unable to redact sanitized TUI capture"
    return 1
  fi
}

is_tui_ready_capture() {
  grep -Eiq "$TUI_READY_PATTERN"
}

strip_terminal_control_sequences() {
  perl -pe 's/\x1b\][^\a]*(?:\a|\x1b\\)//g; s/\x1b\[[0-9;?]*[ -\/]*[@-~]//g; s/\r/\n/g'
}

cleanup_sensitive_captures() {
  local artifact
  for artifact in "${SENSITIVE_CAPTURE_FILES[@]}"; do
    [ -n "$artifact" ] && rm -f -- "$artifact"
  done
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
    NEMOCLAW_TUI_READY_PATTERN="$TUI_READY_PATTERN" \
    NEMOCLAW_TUI_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_TUI_TIMEOUT="$TUI_TIMEOUT" \
    expect <<'EXPECT'
set timeout $env(NEMOCLAW_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_TUI_SANDBOX_NAME)
set capture $env(NEMOCLAW_TUI_CAPTURE)
set ready_pattern $env(NEMOCLAW_TUI_READY_PATTERN)
log_file -a $capture

set cmd [list openshell sandbox exec --name $sandbox --tty -- sh -lc {export TERM=xterm-256color; cd /sandbox; dcode; status=$?; printf "\nNEMOCLAW_TUI_EXIT:%s\n" "$status"}]
spawn {*}$cmd
expect {
  -nocase -re $ready_pattern {
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
    0 | 130) pass "dcode TUI exited cleanly after Ctrl-C (exit ${exit_code})" ;;
    *) fail_test "dcode TUI exited with unexpected status ${exit_code}" ;;
  esac
}

PASSED=0
FAILED=0

main() {
  trap cleanup_sensitive_captures EXIT

  if ! is_positive_integer "$TUI_TIMEOUT"; then
    fail_test "DEEPAGENTS_TUI_TIMEOUT must be a positive integer"
    printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
    exit 1
  fi

  if ! command -v perl >/dev/null 2>&1; then
    fail_test "perl is required to sanitize and redact Deep Agents Code TUI captures"
    printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
    exit 1
  fi

  local probe_output
  if ! probe_output="$(sandbox_exec 'if test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1; then printf "NEMOCLAW_DCODE_PROBE:deepagents\n"; else printf "NEMOCLAW_DCODE_PROBE:other\n"; fi')"; then
    fail_test "unable to probe sandbox '${SANDBOX_NAME}' for Deep Agents Code markers"
    printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
    exit 1
  fi
  case "$probe_output" in
    *NEMOCLAW_DCODE_PROBE:deepagents*) ;;
    *NEMOCLAW_DCODE_PROBE:other*)
      info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
      exit 0
      ;;
    *)
      fail_test "unexpected sandbox probe output for '${SANDBOX_NAME}'"
      printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
      exit 1
      ;;
  esac

  if ! ensure_expect_available; then
    fail_test "expect is required for the Deep Agents Code TUI startup check"
    printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
    exit 1
  fi

  local capture_dir raw_capture_file expect_log_file combined_capture_file plain_capture_file
  capture_dir="$(make_capture_dir)"
  raw_capture_file="${capture_dir}/${PREFIX}.raw.log"
  expect_log_file="${capture_dir}/${PREFIX}.expect.log"
  combined_capture_file="${capture_dir}/${PREFIX}.combined.log"
  plain_capture_file="${capture_dir}/${PREFIX}.sanitized.log"
  SENSITIVE_CAPTURE_FILES=("$raw_capture_file" "$expect_log_file" "$combined_capture_file")
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
  local secret_detected=0
  if contains_secret <"$plain_capture_file"; then
    secret_detected=1
    if ! redact_secrets_in_file "$plain_capture_file"; then
      :
    fi
    if [ -e "$plain_capture_file" ] && contains_secret <"$plain_capture_file"; then
      fail_test "secret-shaped value remained after redacting sanitized TUI capture"
    fi
  fi
  cleanup_sensitive_captures

  if [ "$expect_rc" -eq 0 ]; then
    pass "finite expect harness reached startup and observed exit"
  else
    fail_test "finite expect harness exited ${expect_rc}"
  fi

  if grep -q "NEMOCLAW_TUI_READY" "$plain_capture_file" && is_tui_ready_capture <"$plain_capture_file"; then
    pass "dcode TUI rendered a usable startup prompt signature"
  else
    fail_test "dcode TUI prompt-ready marker missing from capture"
  fi

  assert_clean_exit_code "$plain_capture_file"

  if [ "$secret_detected" -eq 1 ]; then
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
