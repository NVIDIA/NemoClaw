#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Deep Agents Code interactive TUI startup (#5620).
#
# This live check runs twice against a real Deep Agents Code sandbox. It proves
# the interactive `dcode` TUI starts in a PTY, opens and closes the `/agents`
# modal, exits after Ctrl-C without leaking DCode/LangGraph processes, and
# leaves only sanitized, secret-free capture artifacts.
#
# shellcheck disable=SC2016
# expect(1) Tcl: $env(...) and {...} are Tcl/sh expansion, not bash expansion.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-onboard}}"
PREFIX="10-deepagents-code-tui-startup"
TUI_TIMEOUT="${DEEPAGENTS_TUI_TIMEOUT:-90}"
PROCESS_CLEANUP_TIMEOUT=20
# Shell-only live check fallback for remote e2e hosts; Vitest parity coverage in
# test/deepagents-code-tui-startup-check.test.ts pins this to secret-patterns.ts.
SECRET_PATTERN='(?:nvapi-[A-Za-z0-9_-]{10,}|nvcf-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}|A(?:K|S)IA[A-Z0-9]{16}|hf_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|pypi-[A-Za-z0-9_-]{10,}|\bbot[0-9]{8,10}:[A-Za-z0-9_-]{35}\b|\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b|\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b|tvly-[A-Za-z0-9_-]{10,}|lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*)'
CONTEXT_SECRET_VALUE_PATTERN='[A-Za-z0-9_.+\/=-]{10,}'
# Pinned DCode 0.1.34 renders this exact modal title for `/agents`. Opening it
# proves input reached the main composer after optional onboarding; headless
# check 07 independently owns backend readiness and inference acceptance.
TUI_READY_PATTERN='(select agent)'
# Wait for the pinned main TUI banner before sending `/agents`; a fixed delay
# can race startup and submit `agents` as an ordinary chat prompt instead.
TUI_COMPOSER_PATTERN='(dcode[^\r\n]*v0\.1\.34)'
# NemoClaw configures DCode's model and managed provider before launch, so
# the model picker is a regression. The name prompt is allowed on first run.
TUI_FIRST_RUN_PATTERN='(choose a recommended model)'
TUI_NAME_PROMPT_PATTERN='(your name \(optional\)|what should deep agents call you)'
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

dcode_process_count() {
  sandbox_exec 'self=$$; parent=$PPID; count=0; for proc_dir in /proc/[0-9]*; do pid=${proc_dir##*/}; case " $self $parent " in *" $pid "*) continue ;; esac; [ -r "$proc_dir/cmdline" ] || continue; cmdline=$(tr "\000" " " <"$proc_dir/cmdline" 2>/dev/null) || continue; case "${cmdline,,}" in *dcode-session-supervisor* | *deepagents_code* | *langgraph* | */opt/venv/bin/dcode*) count=$((count + 1)) ;; esac; done; printf "NEMOCLAW_DCODE_PROCESS_COUNT:%s\n" "$count"'
}

wait_for_dcode_process_baseline() {
  local baseline="$1"
  local deadline=$((SECONDS + PROCESS_CLEANUP_TIMEOUT))
  local count output
  while :; do
    output="$(dcode_process_count)" || return 1
    count="$(sed -n 's/^NEMOCLAW_DCODE_PROCESS_COUNT:\([0-9][0-9]*\)$/\1/p' <<<"$output" | tail -n1)"
    [[ "$count" =~ ^[0-9]+$ ]] || return 1
    if [ "$count" -le "$baseline" ]; then
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      return 1
    fi
    sleep 1
  done
}

ensure_expect_available() {
  # The Deep Agents Code TUI proof is a PTY contract, so expect(1) is a
  # required host dependency. Privileged installation belongs to the reviewed
  # E2E workflow setup; this PR-controlled check only verifies the prerequisite
  # and fails closed when manual/older runners do not provide it.
  command -v expect >/dev/null 2>&1
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
        /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/ ||
        /$token_pattern/ ||
        /Bearer\s+$context_value_pattern/i ||
        /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)["'\''"]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["'\''"]?[^\s"'\''"]{10,}/i ||
        /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["'\''"]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["'\''"]?[^\s"'\''"]{10,}/ ||
        /(?:^|[^A-Za-z0-9])KEY["'\''"]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["'\''"]?[^\s"'\''"]{10,}/
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
      s/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/[REDACTED_SECRET]/g;
      s/$token_pattern/[REDACTED_SECRET]/g;
      s/(Bearer\s+)$context_value_pattern/${1}[REDACTED_SECRET]/gi;
      s/((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)["'\''"]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["'\''"]?)[^\s"'\''"]{10,}/${1}[REDACTED_SECRET]/gim;
      s/((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["'\''"]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["'\''"]?)[^\s"'\''"]{10,}/${1}[REDACTED_SECRET]/gm;
      s/((?:^|[^A-Za-z0-9])KEY["'\''"]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["'\''"]?)[^\s"'\''"]{10,}/${1}[REDACTED_SECRET]/gm;
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
  local marker_capture_file="$2"
  local expect_name_prompt="$3"
  env \
    NEMOCLAW_TUI_CAPTURE="$raw_capture_file" \
    NEMOCLAW_TUI_COMPOSER_PATTERN="$TUI_COMPOSER_PATTERN" \
    NEMOCLAW_TUI_MARKERS="$marker_capture_file" \
    NEMOCLAW_TUI_FIRST_RUN_PATTERN="$TUI_FIRST_RUN_PATTERN" \
    NEMOCLAW_TUI_NAME_PROMPT_PATTERN="$TUI_NAME_PROMPT_PATTERN" \
    NEMOCLAW_TUI_READY_PATTERN="$TUI_READY_PATTERN" \
    NEMOCLAW_TUI_EXPECT_NAME_PROMPT="$expect_name_prompt" \
    NEMOCLAW_TUI_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_TUI_TIMEOUT="$TUI_TIMEOUT" \
    expect <<'EXPECT'
set timeout $env(NEMOCLAW_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_TUI_SANDBOX_NAME)
set capture $env(NEMOCLAW_TUI_CAPTURE)
set composer_pattern $env(NEMOCLAW_TUI_COMPOSER_PATTERN)
set markers $env(NEMOCLAW_TUI_MARKERS)
set first_run_pattern $env(NEMOCLAW_TUI_FIRST_RUN_PATTERN)
set name_prompt_pattern $env(NEMOCLAW_TUI_NAME_PROMPT_PATTERN)
set ready_pattern $env(NEMOCLAW_TUI_READY_PATTERN)
set expect_name_prompt $env(NEMOCLAW_TUI_EXPECT_NAME_PROMPT)
log_file -a $capture

proc append_marker {markers marker} {
  set fh [open $markers a]
  puts $fh $marker
  close $fh
}

proc submit_agents {markers} {
  # Type at human cadence so DCode 0.1.34's reactive slash completion processes
  # the exact command before Enter submits the selected /agents entry.
  foreach char [split "/agents" ""] {
    send -- $char
    after 150
  }
  after 500
  send -- "\r"
  append_marker $markers "NEMOCLAW_TUI_AGENTS_SUBMITTED"
}

set cmd [list openshell sandbox exec --name $sandbox --tty -- sh -lc {export TERM=xterm-256color; cd /sandbox; dcode; status=$?; printf "\nNEMOCLAW_TUI_EXIT:%s\n" "$status"}]
spawn {*}$cmd

# DCode's own onboarding predicate is sampled immediately before launch. This
# avoids guessing from a short negative observation while imports/first paint
# are still in flight (which could otherwise type `/agents` into the name field).
if {$expect_name_prompt eq "1"} {
  set timeout $env(NEMOCLAW_TUI_TIMEOUT)
  expect {
    -nocase -re $name_prompt_pattern {
      append_marker $markers "$expect_out(0,string)"
      append_marker $markers "NEMOCLAW_TUI_NAME_PROMPT"
      puts "\nNEMOCLAW_TUI_NAME_PROMPT"
      # The prompt copy can render just before its input receives focus. Let the
      # first frame settle, then submit the empty optional name accepted by 0.1.34.
      after 500
      send -- "\r"
      after 500
      submit_agents $markers
    }
    -nocase -re $first_run_pattern {
      append_marker $markers "$expect_out(0,string)"
      append_marker $markers "NEMOCLAW_TUI_UNEXPECTED_FIRST_RUN"
      puts "\nNEMOCLAW_TUI_UNEXPECTED_FIRST_RUN"
      send -- "\003"
      exit 24
    }
    timeout {
      append_marker $markers "NEMOCLAW_TUI_TIMEOUT"
      puts "\nNEMOCLAW_TUI_TIMEOUT"
      send -- "\003"
      exit 20
    }
    eof {
      append_marker $markers "NEMOCLAW_TUI_EOF_BEFORE_READY"
      puts "\nNEMOCLAW_TUI_EOF_BEFORE_READY"
      exit 21
    }
  }
} else {
  append_marker $markers "NEMOCLAW_TUI_NO_NAME_PROMPT"
  set timeout $env(NEMOCLAW_TUI_TIMEOUT)
  expect {
    -nocase -re $composer_pattern {
      append_marker $markers "$expect_out(0,string)"
      append_marker $markers "NEMOCLAW_TUI_COMPOSER_READY"
      submit_agents $markers
    }
    -nocase -re $name_prompt_pattern {
      append_marker $markers "$expect_out(0,string)"
      append_marker $markers "NEMOCLAW_TUI_UNEXPECTED_NAME_PROMPT"
      puts "\nNEMOCLAW_TUI_UNEXPECTED_NAME_PROMPT"
      send -- "\003"
      exit 25
    }
    -nocase -re $first_run_pattern {
      append_marker $markers "$expect_out(0,string)"
      append_marker $markers "NEMOCLAW_TUI_UNEXPECTED_FIRST_RUN"
      puts "\nNEMOCLAW_TUI_UNEXPECTED_FIRST_RUN"
      send -- "\003"
      exit 24
    }
    timeout {
      append_marker $markers "NEMOCLAW_TUI_TIMEOUT"
      puts "\nNEMOCLAW_TUI_TIMEOUT"
      send -- "\003"
      exit 20
    }
    eof {
      append_marker $markers "NEMOCLAW_TUI_EOF_BEFORE_READY"
      puts "\nNEMOCLAW_TUI_EOF_BEFORE_READY"
      exit 21
    }
  }
}

set ready_match ""
set timeout $env(NEMOCLAW_TUI_TIMEOUT)
expect {
  -nocase -re $ready_pattern {
    set ready_match $expect_out(0,string)
  }
  -nocase -re $first_run_pattern {
    append_marker $markers "$expect_out(0,string)"
    append_marker $markers "NEMOCLAW_TUI_UNEXPECTED_FIRST_RUN"
    puts "\nNEMOCLAW_TUI_UNEXPECTED_FIRST_RUN"
    send -- "\003"
    exit 24
  }
  timeout {
    append_marker $markers "NEMOCLAW_TUI_TIMEOUT"
    puts "\nNEMOCLAW_TUI_TIMEOUT"
    send -- "\003"
    exit 20
  }
  eof {
    append_marker $markers "NEMOCLAW_TUI_EOF_BEFORE_READY"
    puts "\nNEMOCLAW_TUI_EOF_BEFORE_READY"
    exit 21
  }
}

append_marker $markers "$ready_match"
append_marker $markers "NEMOCLAW_TUI_READY"
puts "\nNEMOCLAW_TUI_READY"
# Close the Select Agent modal before exercising the idle-app quit path.
send -- "\033"
after 500
# Idle dcode arms quit on the first Ctrl-C and exits on the second.
send -- "\003"
after 250
catch {send -- "\003"}

set timeout 20
expect {
  -re {NEMOCLAW_TUI_EXIT:([0-9]+)} {
    append_marker $markers "NEMOCLAW_TUI_EXIT_CAPTURED:$expect_out(1,string)"
    puts "\nNEMOCLAW_TUI_EXIT_CAPTURED:$expect_out(1,string)"
    exit 0
  }
  timeout {
    append_marker $markers "NEMOCLAW_TUI_EXIT_TIMEOUT"
    puts "\nNEMOCLAW_TUI_EXIT_TIMEOUT"
    send -- "\003"
    exit 22
  }
  eof {
    append_marker $markers "NEMOCLAW_TUI_EOF_BEFORE_EXIT"
    puts "\nNEMOCLAW_TUI_EOF_BEFORE_EXIT"
    exit 23
  }
}
EXPECT
}

print_sanitized_capture_excerpt() {
  local plain_capture_file="$1"
  if [ ! -r "$plain_capture_file" ]; then
    info "sanitized TUI capture unavailable for diagnostics"
    return
  fi
  if contains_secret <"$plain_capture_file"; then
    info "sanitized TUI capture omitted because secret-shaped data remains"
    return
  fi

  printf '%s\n' "${PREFIX}: sanitized capture excerpt (last 20000 bytes):" >&2
  tail -c 20000 -- "$plain_capture_file" >&2
  printf '\n%s\n' "${PREFIX}: end sanitized capture excerpt" >&2
}

assert_clean_exit_code() {
  local plain_capture_file="$1"
  local exit_code
  exit_code="$(sed -n 's/.*NEMOCLAW_TUI_EXIT_CAPTURED:\([0-9][0-9]*\).*/\1/p' "$plain_capture_file" | tail -n1)"
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

  local probe_output expect_name_prompt
  if ! probe_output="$(sandbox_exec 'if test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1; then printf "NEMOCLAW_DCODE_PROBE:deepagents\n"; env -u PYTHONHOME -u PYTHONPATH HOME=/sandbox /opt/venv/bin/python3 -I -c "from deepagents_code.onboarding import should_run_onboarding; print(\"NEMOCLAW_DCODE_ONBOARDING:\" + (\"pending\" if should_run_onboarding() else \"complete\"))"; else printf "NEMOCLAW_DCODE_PROBE:other\n"; fi')"; then
    fail_test "unable to probe sandbox '${SANDBOX_NAME}' for Deep Agents Code markers"
    printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
    exit 1
  fi
  case "$probe_output" in
    *NEMOCLAW_DCODE_PROBE:deepagents*NEMOCLAW_DCODE_ONBOARDING:pending*)
      fail_test "managed Deep Agents Code first-run onboarding is still pending"
      printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
      exit 1
      ;;
    *NEMOCLAW_DCODE_PROBE:deepagents*NEMOCLAW_DCODE_ONBOARDING:complete*) expect_name_prompt=0 ;;
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

  local capture_dir raw_capture_file marker_capture_file expect_log_file combined_capture_file plain_capture_file
  capture_dir="$(make_capture_dir)"
  # The typed target may inherit agent processes from earlier checks, so the
  # acceptance contract is no increase from one recorded baseline. The small
  # local polling helper is reused for both sessions; separate capture names
  # retain per-session evidence instead of overwriting the first failure.
  local baseline_output baseline_process_count
  if ! baseline_output="$(dcode_process_count)"; then
    fail_test "unable to record the baseline DCode/LangGraph process count"
    printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
    exit 1
  fi
  baseline_process_count="$(sed -n 's/^NEMOCLAW_DCODE_PROCESS_COUNT:\([0-9][0-9]*\)$/\1/p' <<<"$baseline_output" | tail -n1)"
  if [[ ! "$baseline_process_count" =~ ^[0-9]+$ ]]; then
    fail_test "unable to record the baseline DCode/LangGraph process count"
    printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
    exit 1
  fi

  info "Running two Deep Agents Code TUI sessions in sandbox: $SANDBOX_NAME"
  info "Capture directory: $capture_dir"

  local session_index suffix expect_rc secret_detected
  for session_index in 1 2; do
    suffix=""
    [ "$session_index" -eq 2 ] && suffix=".repeat"
    raw_capture_file="${capture_dir}/${PREFIX}${suffix}.raw.log"
    marker_capture_file="${capture_dir}/${PREFIX}${suffix}.markers.log"
    expect_log_file="${capture_dir}/${PREFIX}${suffix}.expect.log"
    combined_capture_file="${capture_dir}/${PREFIX}${suffix}.combined.log"
    plain_capture_file="${capture_dir}/${PREFIX}${suffix}.sanitized.log"
    SENSITIVE_CAPTURE_FILES+=(
      "$raw_capture_file"
      "$marker_capture_file"
      "$expect_log_file"
      "$combined_capture_file"
    )
    : >"$raw_capture_file"
    : >"$marker_capture_file"
    : >"$expect_log_file"

    set +e
    run_tui_expect "$raw_capture_file" "$marker_capture_file" "$expect_name_prompt" >"$expect_log_file" 2>&1
    expect_rc=$?
    set -e

    cat "$raw_capture_file" "$expect_log_file" "$marker_capture_file" >"$combined_capture_file"
    strip_terminal_control_sequences <"$combined_capture_file" >"$plain_capture_file"
    secret_detected=0
    if contains_secret <"$plain_capture_file"; then
      secret_detected=1
      if ! redact_secrets_in_file "$plain_capture_file"; then
        :
      fi
      if [ -e "$plain_capture_file" ] && contains_secret <"$plain_capture_file"; then
        fail_test "session ${session_index}: secret-shaped value remained after redacting sanitized TUI capture"
      fi
    fi
    cleanup_sensitive_captures

    if [ "$expect_rc" -eq 0 ]; then
      pass "session ${session_index}: finite expect harness reached startup and observed exit"
    else
      fail_test "session ${session_index}: finite expect harness exited ${expect_rc}"
      print_sanitized_capture_excerpt "$plain_capture_file"
    fi

    if grep -q "NEMOCLAW_TUI_READY" "$plain_capture_file" && is_tui_ready_capture <"$plain_capture_file"; then
      pass "session ${session_index}: dcode TUI reached the main composer and opened Select Agent"
    else
      fail_test "session ${session_index}: dcode TUI Select Agent readiness marker missing from capture"
    fi

    assert_clean_exit_code "$plain_capture_file"

    if [ "$secret_detected" -eq 1 ]; then
      fail_test "session ${session_index}: secret-shaped value found in sanitized TUI capture"
    else
      pass "session ${session_index}: sanitized TUI capture does not contain secret-shaped values"
    fi

    if wait_for_dcode_process_baseline "$baseline_process_count"; then
      pass "session ${session_index}: DCode/LangGraph process count returned to baseline"
    else
      fail_test "session ${session_index}: DCode/LangGraph process count remained above baseline after ${PROCESS_CLEANUP_TIMEOUT}s"
    fi
    info "sanitized capture: ${plain_capture_file}"
  done

  printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
  [ "$FAILED" -eq 0 ] || exit 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
