#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: managed Deep Agents Code thread-scoped auto-approval (#6478).
#
# This check starts from the typed target's default-disabled DCode sandbox,
# enables the root-owned capability through NemoClaw's named rebuild surface,
# selects the upstream "Auto-approve for this thread" action in a real TUI,
# and proves that a new thread returns to manual approval. It then reruns the
# established network and credential boundary checks in the enabled posture.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-}}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
CLI="${NEMOCLAW_CLI_BIN:-${REPO}/bin/nemoclaw.js}"
PREFIX="12-deepagents-code-thread-auto-approval"
TUI_TIMEOUT="${DEEPAGENTS_AUTORUN_TIMEOUT:-420}"
CAPABILITY_FILE="/usr/local/share/nemoclaw/dcode-auto-approval"
NETWORK_BOUNDARY_CHECK="${REPO}/test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh"
CREDENTIAL_BOUNDARY_CHECK="${REPO}/test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh"
SHELL_ROUND_ONE="/sandbox/.nemoclaw-e2e-autorun-shell-1"
WRITE_ROUND="/sandbox/.nemoclaw-e2e-autorun-write"
SHELL_ROUND_THREE="/sandbox/.nemoclaw-e2e-autorun-shell-3"
RESET_ROUND="/sandbox/.nemoclaw-e2e-autorun-reset-must-not-run"

fail() {
  printf '%s: FAIL: %s\n' "$PREFIX" "$1" >&2
  exit 1
}

pass() {
  printf '%s: OK (%s)\n' "$PREFIX" "$1"
}

info() {
  printf '%s: %s\n' "$PREFIX" "$1"
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c "$1" 2>&1
}

is_default_auto_approval_denial() {
  local exit_code="$1"
  local output
  output="$(cat)"
  [ "$exit_code" -eq 2 ] \
    && printf '%s\n' "$output" | grep -Fq "NemoClaw manages Deep Agents Code tool approval posture"
}

assert_capability_projection() {
  local expected_mode="$1"
  local expected_size
  case "$expected_mode" in
    disabled) expected_size=9 ;;
    thread-opt-in) expected_size=14 ;;
    *) fail "unsupported expected capability mode '$expected_mode'" ;;
  esac

  local expected_metadata remote_command projection_output
  expected_metadata="0:0:444:${expected_size}"
  remote_command="set -euo pipefail; file=${CAPABILITY_FILE@Q}; test -f \"\$file\"; test ! -L \"\$file\"; test \"\$(stat -c '%u:%g:%a:%s' \"\$file\")\" = ${expected_metadata@Q}; test \"\$(cat \"\$file\")\" = ${expected_mode@Q}; /opt/venv/bin/python3 -I -c 'from deepagents_code._nemoclaw_managed import managed_auto_approval_mode; print(managed_auto_approval_mode())'"
  projection_output="$(sandbox_exec "$remote_command")" \
    || fail "trusted capability projection is not root-owned, read-only, and exact: $projection_output"
  [ "$projection_output" = "$expected_mode" ] \
    || fail "managed runtime resolved capability '$projection_output' instead of '$expected_mode'"
}

assert_status_mode() {
  local expected_mode="$1"
  local status_json
  status_json="$("$CLI" "$SANDBOX_NAME" status --json)" \
    || fail "nemoclaw status failed while checking '$expected_mode'"
  STATUS_JSON="$status_json" EXPECTED_MODE="$expected_mode" SANDBOX_NAME="$SANDBOX_NAME" node -e '
const status = JSON.parse(process.env.STATUS_JSON);
if (status.name !== process.env.SANDBOX_NAME ||
    status.agent !== "langchain-deepagents-code" ||
    status.dcodeAutoApprovalMode !== process.env.EXPECTED_MODE) process.exit(1);
' || fail "nemoclaw status did not report DCode auto-approval capability '$expected_mode'"
}

assert_default_denial_ignores_ambient_override() {
  local output status
  set +e
  output="$(
    sandbox_exec \
      "env NEMOCLAW_DCODE_AUTO_APPROVAL=thread-opt-in timeout 20 /usr/local/bin/dcode --auto-approve --help"
  )"
  status=$?
  set -e
  if ! printf '%s\n' "$output" | is_default_auto_approval_denial "$status"; then
    fail "default-disabled dcode accepted --auto-approve or lacked managed denial evidence"
  fi
}

run_autorun_tui() {
  local marker_file="$1"
  local first_prompt reset_prompt
  first_prompt="Use tools in exactly four sequential rounds, waiting for each result before starting the next. Round 1: use the shell execute tool to run printf and write shell-round-1 followed by a newline to ${SHELL_ROUND_ONE}. Round 2: use the non-shell write_file tool to write write-round-2 followed by a newline to ${WRITE_ROUND}. Round 3: use the shell execute tool to run printf and write shell-round-3 followed by a newline to ${SHELL_ROUND_THREE}. Round 4: use the non-shell read_file tool to read all three files and verify their exact contents. Do not combine rounds or substitute shell for write_file or read_file. After all four rounds succeed, reply with exactly the concatenation of NEMOCLAW_AUTORUN_ and COMPLETE."
  reset_prompt="Use the shell execute tool once to write reset-should-not-run followed by a newline to ${RESET_ROUND}, then report completion."

  env \
    NEMOCLAW_AUTORUN_EXPECT_MARKERS="$marker_file" \
    NEMOCLAW_AUTORUN_FIRST_PROMPT="$first_prompt" \
    NEMOCLAW_AUTORUN_RESET_PROMPT="$reset_prompt" \
    NEMOCLAW_AUTORUN_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_AUTORUN_TUI_TIMEOUT="$TUI_TIMEOUT" \
    expect <<'EXPECT'
set timeout $env(NEMOCLAW_AUTORUN_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_AUTORUN_SANDBOX_NAME)
set first_prompt $env(NEMOCLAW_AUTORUN_FIRST_PROMPT)
set reset_prompt $env(NEMOCLAW_AUTORUN_RESET_PROMPT)
set markers $env(NEMOCLAW_AUTORUN_EXPECT_MARKERS)
log_user 0

proc append_marker {markers marker} {
  set fh [open $markers a]
  puts $fh $marker
  close $fh
}

proc submit_text {text delay_ms} {
  foreach char [split $text ""] {
    send -- $char
    after $delay_ms
  }
  after 300
  send -- "\r"
}

proc abort_tui {markers marker code} {
  append_marker $markers $marker
  catch {send -- "\003"}
  after 200
  catch {send -- "\003"}
  exit $code
}

set remote_script {cd /sandbox && /usr/local/bin/dcode -m "$1"; status=$?; printf "\nNEMOCLAW_AUTORUN_TUI_EXIT:%s\n" "$status"}
set cmd [list openshell sandbox exec --name $sandbox --tty -- env HOME=/sandbox TERM=xterm-256color bash -lc $remote_script nemoclaw-e2e $first_prompt]
spawn {*}$cmd

expect {
  -nocase -re {auto-approve for this thread} {
    append_marker $markers "NEMOCLAW_AUTORUN_APPROVAL_MENU"
    send -- "a"
  }
  timeout { abort_tui $markers "NEMOCLAW_AUTORUN_TIMEOUT_APPROVAL_MENU" 20 }
  eof { abort_tui $markers "NEMOCLAW_AUTORUN_EOF_APPROVAL_MENU" 21 }
}

expect {
  -nocase -re {auto-approval is enabled} {
    append_marker $markers "NEMOCLAW_AUTORUN_WARNING"
  }
  timeout { abort_tui $markers "NEMOCLAW_AUTORUN_TIMEOUT_WARNING" 22 }
  eof { abort_tui $markers "NEMOCLAW_AUTORUN_EOF_WARNING" 23 }
}

expect {
  -re {NEMOCLAW_AUTORUN_COMPLETE} {
    append_marker $markers "NEMOCLAW_AUTORUN_WORKFLOW_COMPLETE"
  }
  timeout { abort_tui $markers "NEMOCLAW_AUTORUN_TIMEOUT_WORKFLOW" 24 }
  eof { abort_tui $markers "NEMOCLAW_AUTORUN_EOF_WORKFLOW" 25 }
}

after 1000
submit_text "/clear" 100
expect {
  -nocase -re {started new thread:} {
    append_marker $markers "NEMOCLAW_AUTORUN_NEW_THREAD"
  }
  timeout { abort_tui $markers "NEMOCLAW_AUTORUN_TIMEOUT_NEW_THREAD" 26 }
  eof { abort_tui $markers "NEMOCLAW_AUTORUN_EOF_NEW_THREAD" 27 }
}

after 500
submit_text $reset_prompt 5
expect {
  -nocase -re {auto-approve for this thread} {
    append_marker $markers "NEMOCLAW_AUTORUN_MANUAL_APPROVAL_RESTORED"
    send -- "n"
  }
  timeout { abort_tui $markers "NEMOCLAW_AUTORUN_TIMEOUT_MANUAL_APPROVAL" 28 }
  eof { abort_tui $markers "NEMOCLAW_AUTORUN_EOF_MANUAL_APPROVAL" 29 }
}

after 700
submit_text "/quit" 100
set timeout 30
expect {
  -re {NEMOCLAW_AUTORUN_TUI_EXIT:([0-9]+)} {
    append_marker $markers "NEMOCLAW_AUTORUN_TUI_EXIT:$expect_out(1,string)"
    exit 0
  }
  timeout {
    append_marker $markers "NEMOCLAW_AUTORUN_TUI_EXIT_TIMEOUT"
    catch {send -- "\003"}
    exit 30
  }
  eof {
    append_marker $markers "NEMOCLAW_AUTORUN_TUI_EOF_BEFORE_EXIT"
    exit 31
  }
}
EXPECT
}

assert_autorun_evidence() {
  local marker_file="$1"
  local marker
  for marker in \
    NEMOCLAW_AUTORUN_APPROVAL_MENU \
    NEMOCLAW_AUTORUN_WARNING \
    NEMOCLAW_AUTORUN_WORKFLOW_COMPLETE \
    NEMOCLAW_AUTORUN_NEW_THREAD \
    NEMOCLAW_AUTORUN_MANUAL_APPROVAL_RESTORED; do
    grep -Fxq "$marker" "$marker_file" || fail "TUI evidence marker is missing: $marker"
  done
  grep -Eq '^NEMOCLAW_AUTORUN_TUI_EXIT:(0|130)$' "$marker_file" \
    || fail "DCode TUI did not exit cleanly after the thread reset proof: $(tr '\n' ' ' <"$marker_file")"

  local file_output
  file_output="$(
    sandbox_exec \
      "set -e; printf '%s\\n' shell-round-1 | cmp -s - ${SHELL_ROUND_ONE@Q}; printf '%s\\n' write-round-2 | cmp -s - ${WRITE_ROUND@Q}; printf '%s\\n' shell-round-3 | cmp -s - ${SHELL_ROUND_THREE@Q}; test ! -e ${RESET_ROUND@Q}; printf '%s\\n' NEMOCLAW_AUTORUN_FILES_VERIFIED"
  )" || fail "autorun output files or reset-thread denial evidence are invalid: $file_output"
  [ "$file_output" = "NEMOCLAW_AUTORUN_FILES_VERIFIED" ] \
    || fail "autorun file verification marker is missing"
}

run_boundary_check() {
  local label="$1"
  local script_path="$2"
  local output
  output="$(env SANDBOX_NAME="$SANDBOX_NAME" NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" REPO="$REPO" bash "$script_path" 2>&1)" \
    || fail "$label failed with thread-opt-in enabled: $output"
  if printf '%s\n' "$output" | grep -Eq '(^|[[:space:]])SKIP([[:space:]]|:)'; then
    fail "$label skipped with thread-opt-in enabled: $output"
  fi
  pass "$label remains enforced with thread-opt-in enabled"
}

cleanup_probe_files() {
  sandbox_exec \
    "rm -f ${SHELL_ROUND_ONE@Q} ${WRITE_ROUND@Q} ${SHELL_ROUND_THREE@Q} ${RESET_ROUND@Q}" \
    >/dev/null 2>&1 || true
}

main() {
  [ -n "$SANDBOX_NAME" ] || fail "sandbox name is required"
  [ -x "$CLI" ] || fail "NemoClaw CLI is not executable at $CLI"
  [ -x "$NETWORK_BOUNDARY_CHECK" ] || fail "network boundary check is not executable"
  [ -x "$CREDENTIAL_BOUNDARY_CHECK" ] || fail "credential boundary check is not executable"
  command -v expect >/dev/null 2>&1 || fail "expect is required for the DCode autorun TUI check"
  command -v node >/dev/null 2>&1 || fail "node is required to inspect status JSON"
  is_positive_integer "$TUI_TIMEOUT" \
    || fail "DEEPAGENTS_AUTORUN_TIMEOUT must be a positive integer"

  # The generic cloud-onboard target runs shared checks against OpenClaw. Typed
  # DCode targets reject this SKIP through the required-check wrapper.
  if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
    printf '%s: SKIP: sandbox %q is not a Deep Agents Code sandbox\n' "$PREFIX" "$SANDBOX_NAME"
    exit 0
  fi

  trap cleanup_probe_files EXIT
  cleanup_probe_files

  assert_capability_projection disabled
  assert_status_mode disabled
  assert_default_denial_ignores_ambient_override
  pass "fresh sandbox denies auto-approval by trusted default and ignores ambient overrides"

  local rebuild_output
  info "Enabling thread-opt-in through the named sandbox rebuild interface"
  rebuild_output="$(
    "$CLI" "$SANDBOX_NAME" rebuild --yes \
      --dcode-auto-approval thread-opt-in 2>&1
  )" || fail "named sandbox rebuild could not enable thread-opt-in: $rebuild_output"

  assert_capability_projection thread-opt-in
  assert_status_mode thread-opt-in
  pass "named sandbox rebuild projects and reports thread-opt-in"

  local capture_dir marker_file
  capture_dir="$(mktemp -d "${TMPDIR:-/tmp}/${PREFIX}.XXXXXX")"
  marker_file="${capture_dir}/markers.log"
  : >"$marker_file"
  # Raw PTY bytes are intentionally neither logged nor persisted. The marker
  # file contains only fixed, non-secret phase names and is deleted below.
  if ! run_autorun_tui "$marker_file"; then
    fail "finite DCode autorun TUI harness failed: $(tr '\n' ' ' <"$marker_file")"
  fi
  assert_autorun_evidence "$marker_file"
  rm -rf "$capture_dir"
  pass "approval-menu opt-in autoruns repeated shell and non-shell rounds only for the current thread"

  run_boundary_check "OpenShell network policy boundary" "$NETWORK_BOUNDARY_CHECK"
  run_boundary_check "managed credential boundary" "$CREDENTIAL_BOUNDARY_CHECK"

  info "Disabling thread-opt-in through the named sandbox rebuild interface"
  rebuild_output="$(
    "$CLI" "$SANDBOX_NAME" rebuild --yes \
      --dcode-auto-approval disabled 2>&1
  )" || fail "named sandbox rebuild could not disable thread-opt-in: $rebuild_output"

  assert_capability_projection disabled
  assert_status_mode disabled
  assert_default_denial_ignores_ambient_override
  pass "named sandbox rebuild restores trusted default denial"

  printf '%s: 6 passed, 0 failed\n' "$PREFIX"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
