#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: managed Deep Agents Code native Auto mode (#6478).
#
# This check starts from the typed target's default-disabled DCode sandbox,
# enables the root-owned capability through NemoClaw's named rebuild surface,
# selects the upstream "Enable Auto for this thread" action in a real TUI,
# and confirms the native Auto notice. It then reruns the established network
# and credential boundary checks in the enabled posture.

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
AUTORUN_DEBUG_DIR="/sandbox/.nemoclaw-e2e-autorun-debug"
EXPORT_BASELINE_RECOVERY_ARMED=0

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

rebuild_named_sandbox() {
  local mode="$1"
  local observability_flag="${2:-}"
  local attempt output status prior_timeout_output retry_delay_seconds
  prior_timeout_output=""
  retry_delay_seconds="${NEMOCLAW_E2E_DCODE_REBUILD_RETRY_DELAY_SECONDS:-3}"
  [[ "$retry_delay_seconds" =~ ^[0-9]+$ ]] \
    || fail "rebuild retry delay must be a non-negative integer"

  for attempt in 1 2; do
    local -a rebuild_args=(
      "$SANDBOX_NAME" rebuild --yes --dcode-auto-approval "$mode"
    )
    if [ -n "$observability_flag" ]; then
      rebuild_args+=("$observability_flag")
    fi
    if output="$("$CLI" "${rebuild_args[@]}" 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    else
      status=$?
    fi

    if [ "$attempt" -eq 1 ] \
      && printf '%s\n' "$output" | grep -Fq "existing sandbox inference probe exited with status 28" \
      && printf '%s\n' "$output" | grep -Fq "Sandbox is untouched"; then
      prior_timeout_output="$output"
      info "Retrying named sandbox rebuild once after a fail-closed inference timeout" >&2
      sleep "$retry_delay_seconds"
      continue
    fi

    if [ -n "$prior_timeout_output" ]; then
      printf '%s\n%s\n' "$prior_timeout_output" "$output"
    else
      printf '%s\n' "$output"
    fi
    return "$status"
  done
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c "$1" 2>&1
}

save_preferences_source() {
  cat <<'PY'
import hashlib
from pathlib import Path
import tomllib

from deepagents_code.model_config import _save_toml_field

path = Path("/sandbox/.deepagents/config.toml")
original = path.read_text(encoding="utf-8")
config = tomllib.loads(original)
scrollbar = not config.get("ui", {}).get("show_scrollbar", False)
# The earlier runtime checks may have already saved preferences. Add a comment
# so this call must demonstrate the pinned writer's comment removal itself.
path.write_text(original + "\n# NemoClaw preference rewrite probe\n", encoding="utf-8")
assert _save_toml_field("ui", "show_scrollbar", scrollbar, path), "preference save failed"
saved = path.read_text(encoding="utf-8")
assert not any(line.lstrip().startswith("#") for line in saved.splitlines()), "comments survived"
config.setdefault("ui", {})["show_scrollbar"] = scrollbar
assert tomllib.loads(saved) == config, "preference save changed other native state"
print(hashlib.sha256(path.read_bytes()).hexdigest())
PY
}

saved_identity_source() {
  cat <<'PY'
import hashlib
import os
from pathlib import Path
import stat
import subprocess
import sys
import tomllib

path = Path("/sandbox/.deepagents/config.toml")
assert hashlib.sha256(path.read_bytes()).hexdigest() == sys.argv[1], "saved config changed"
config = tomllib.loads(path.read_text(encoding="utf-8"))
# This supported target uses NVIDIA hosted inference via compatible-endpoint.
# Model and endpoint come from the saved native preferences, not metadata files.
expected = {
    "Route": "inference",
    "Provider": "compatible-endpoint",
    "Model": config["models"]["default"],
    "Endpoint": config["models"]["providers"]["openai"]["base_url"],
}
assert os.getuid() != 0, "identity probe must run as the sandbox user"
for name in ("dcode-provider-route", "dcode-upstream-provider"):
    metadata = Path("/usr/local/share/nemoclaw") / name
    posture = metadata.lstat()
    assert stat.S_ISREG(posture.st_mode), f"{name} is not a regular file"
    assert (posture.st_uid, posture.st_gid, stat.S_IMODE(posture.st_mode)) == (0, 0, 0o444), name
    try:
        descriptor = os.open(metadata, os.O_WRONLY)
    except PermissionError:
        pass
    else:
        os.close(descriptor)
        raise AssertionError(f"sandbox user can write {name}")
for alias in ("status", "whoami", "identity"):
    result = subprocess.run(
        ["/usr/local/bin/dcode", alias], check=True, capture_output=True, text=True, timeout=30,
    )
    fields = dict(line.split(":", 1) for line in result.stdout.splitlines() if ":" in line)
    for field, value in expected.items():
        assert fields.get(field, "").strip() == value, f"{alias} lost {field}"
print("saved preferences and protected identity verified")
PY
}

assert_saved_identity() {
  local config_digest="$1"
  openshell sandbox exec --name "$SANDBOX_NAME" -- \
    /usr/bin/env HOME=/sandbox /opt/venv/bin/python3 -I -c "$(saved_identity_source)" "$config_digest" \
    || fail "saved preferences or installed DCode identity failed verification"
}

native_state_digest_source() {
  cat <<'PY'
import hashlib
from pathlib import Path
import sqlite3
import sys

try:
    root = Path(sys.argv[1]).resolve()
    database = root / ".deepagents/.state/sessions.db"
    digest = hashlib.sha256()
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("PRAGMA trusted_schema = OFF")
        connection.execute("BEGIN")
        has_rows = False
        # Logical state includes committed WAL data without checkpointing the native database.
        for line in connection.iterdump():
            has_rows = has_rows or line.startswith("INSERT INTO")
            digest.update((line + "\n").encode())
        if not has_rows:
            raise ValueError("conversation state is empty")
    for name in (".nemoclaw-e2e-autorun-shell-1", ".nemoclaw-e2e-autorun-write",
                 ".nemoclaw-e2e-autorun-shell-3"):
        content = (root / name).read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    print(digest.hexdigest())
except Exception:
    raise SystemExit("could not inspect native conversation and workspace state") from None
PY
}

native_state_digest() {
  timeout --kill-after=5 30 openshell sandbox exec --name "$SANDBOX_NAME" -- \
    /opt/venv/bin/python3 -I -c "$(native_state_digest_source)" /sandbox
}

export_baseline_registry_state() {
  SANDBOX_NAME="$SANDBOX_NAME" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const registry = JSON.parse(
  fs.readFileSync(path.join(process.env.HOME, ".nemoclaw", "sandboxes.json"), "utf8"),
);
const entry = registry.sandboxes?.[process.env.SANDBOX_NAME];
if (!entry || entry.agent !== "langchain-deepagents-code" ||
    !["disabled", "thread-opt-in"].includes(entry.dcodeAutoApprovalMode) ||
    typeof entry.observabilityEnabled !== "boolean") process.exit(1);
process.stdout.write(
  `${entry.dcodeAutoApprovalMode}:${entry.observabilityEnabled ? "enabled" : "disabled"}`,
);
NODE
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
  local attempt attempts retry_delay_seconds status status_json
  attempts="${NEMOCLAW_E2E_DCODE_STATUS_ATTEMPTS:-3}"
  retry_delay_seconds="${NEMOCLAW_E2E_DCODE_STATUS_RETRY_DELAY_SECONDS:-3}"
  is_positive_integer "$attempts" \
    || fail "status attempt count must be a positive integer"
  [[ "$retry_delay_seconds" =~ ^[0-9]+$ ]] \
    || fail "status retry delay must be a non-negative integer"

  status=1
  status_json=""
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if status_json="$("$CLI" "$SANDBOX_NAME" status --json)"; then
      status=0
      break
    else
      status=$?
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      info "Retrying NemoClaw status after a non-success health probe (attempt $attempt/$attempts)" >&2
      sleep "$retry_delay_seconds"
    fi
  done
  [ "$status" -eq 0 ] \
    || fail "nemoclaw status failed while checking '$expected_mode' after $attempts attempts: ${status_json:-<no stdout>}"
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
  local first_prompt
  first_prompt="Use tools in exactly four sequential rounds, waiting for each result before starting the next. Round 1: use the shell execute tool to write the text shell-round-1 to ${SHELL_ROUND_ONE}. Round 2: use the non-shell write_file tool to write the text write-round-2 to ${WRITE_ROUND}. Round 3: use the shell execute tool to write the text shell-round-3 to ${SHELL_ROUND_THREE}. Round 4: use the non-shell read_file tool to read all three files and verify their text. Do not combine rounds or substitute shell for write_file or read_file. After all four rounds succeed, reply with exactly the concatenation of NEMOCLAW_AUTORUN_ and COMPLETE."

  env \
    NEMOCLAW_AUTORUN_EXPECT_MARKERS="$marker_file" \
    NEMOCLAW_AUTORUN_FIRST_PROMPT="$first_prompt" \
    NEMOCLAW_AUTORUN_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_AUTORUN_TUI_TIMEOUT="$TUI_TIMEOUT" \
    expect <<'EXPECT'
set timeout $env(NEMOCLAW_AUTORUN_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_AUTORUN_SANDBOX_NAME)
set first_prompt $env(NEMOCLAW_AUTORUN_FIRST_PROMPT)
set markers $env(NEMOCLAW_AUTORUN_EXPECT_MARKERS)
log_user 0
# Preserve a terminal frame for redacted failure diagnostics across repaints.
match_max -d 65536

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
  global expect_out
  if {[info exists expect_out(buffer)]} { puts $expect_out(buffer) }
  append_marker $markers $marker
  catch {send -- "\003"}
  after 200
  catch {send -- "\003"}
  exit $code
}

# Exercise direct tool approvals; interpreter-mediated calls bypass these gates.
set remote_script {cd /sandbox && DEEPAGENTS_CODE_DEBUG=1 DEEPAGENTS_CODE_DEBUG_DIRECTORY=/sandbox/.nemoclaw-e2e-autorun-debug /usr/local/bin/dcode --no-interpreter -m "$1"; status=$?; printf "\nNEMOCLAW_AUTORUN_TUI_EXIT:%s\n" "$status"}
set cmd [list openshell sandbox exec --name $sandbox --tty -- env HOME=/sandbox TERM=xterm-256color bash -lc $remote_script nemoclaw-e2e $first_prompt]
spawn {*}$cmd

expect {
  -nocase -re {enable auto for this thread} {
    append_marker $markers "NEMOCLAW_AUTORUN_APPROVAL_MENU"
    send -- "a"
  }
  timeout { abort_tui $markers "NEMOCLAW_AUTORUN_TIMEOUT_APPROVAL_MENU" 20 }
  eof { abort_tui $markers "NEMOCLAW_AUTORUN_EOF_APPROVAL_MENU" 21 }
}

expect {
  -nocase -re {enter switch to auto} {
    append_marker $markers "NEMOCLAW_AUTORUN_WARNING"
    send -- "\r"
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
    NEMOCLAW_AUTORUN_WORKFLOW_COMPLETE; do
    grep -Fxq "$marker" "$marker_file" || fail "TUI evidence marker is missing: $marker"
  done
  grep -Eq '^NEMOCLAW_AUTORUN_TUI_EXIT:(0|130)$' "$marker_file" \
    || fail "DCode TUI did not exit cleanly after the Auto workflow: $(tr '\n' ' ' <"$marker_file")"

  local file_output
  file_output="$(
    sandbox_exec \
      "{ cmp -s <(printf '%s' shell-round-1) ${SHELL_ROUND_ONE@Q} || cmp -s <(printf '%s\\n' shell-round-1) ${SHELL_ROUND_ONE@Q}; } || { printf '%s\\n' NEMOCLAW_AUTORUN_SHELL_ROUND_1_INVALID; exit 1; }; { cmp -s <(printf '%s' write-round-2) ${WRITE_ROUND@Q} || cmp -s <(printf '%s\\n' write-round-2) ${WRITE_ROUND@Q}; } || { printf '%s\\n' NEMOCLAW_AUTORUN_WRITE_ROUND_INVALID; exit 1; }; { cmp -s <(printf '%s' shell-round-3) ${SHELL_ROUND_THREE@Q} || cmp -s <(printf '%s\\n' shell-round-3) ${SHELL_ROUND_THREE@Q}; } || { printf '%s\\n' NEMOCLAW_AUTORUN_SHELL_ROUND_3_INVALID; exit 1; }; printf '%s\\n' NEMOCLAW_AUTORUN_FILES_VERIFIED"
  )" || fail "autorun output files are invalid: $file_output"
  [ "$file_output" = "NEMOCLAW_AUTORUN_FILES_VERIFIED" ] \
    || fail "autorun file verification marker is missing"
}

capture_autorun_diagnostics() {
  # The pinned DCode runtime writes per-thread streaming/tool events. Capture a
  # bounded redacted tail before failure recovery rebuilds the sandbox.
  timeout 20 openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c \
    "tail -c 12000 -- ${AUTORUN_DEBUG_DIR@Q}/*.log 2>/dev/null" 2>&1 \
    | node --no-warnings "${REPO}/test/e2e/fixtures/redaction.ts" || true
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
    "rm -f ${SHELL_ROUND_ONE@Q} ${WRITE_ROUND@Q} ${SHELL_ROUND_THREE@Q}; rm -rf -- ${AUTORUN_DEBUG_DIR@Q}" \
    >/dev/null 2>&1 || true
}

restore_export_baseline_on_exit() {
  local original_status=$?
  local recovery_output recovery_status
  trap - EXIT
  cleanup_probe_files
  recovery_status=0
  if [ "$EXPORT_BASELINE_RECOVERY_ARMED" -eq 1 ]; then
    info "Restoring the disabled export baseline after an interrupted thread-opt-in check" >&2
    if ! recovery_output="$(rebuild_named_sandbox disabled --no-observability)"; then
      printf '%s: FAIL: export baseline recovery rebuild failed: %s\n' \
        "$PREFIX" "$recovery_output" >&2
      recovery_status=1
    elif [ "$(export_baseline_registry_state)" != "disabled:disabled" ]; then
      printf '%s: FAIL: export baseline recovery did not restore retained approval and observability state\n' \
        "$PREFIX" >&2
      recovery_status=1
    fi
  fi
  if [ "$original_status" -ne 0 ]; then
    exit "$original_status"
  fi
  exit "$recovery_status"
}

main() {
  [ -n "$SANDBOX_NAME" ] || fail "sandbox name is required"
  [ -x "$CLI" ] || fail "NemoClaw CLI is not executable at $CLI"
  [ -x "$NETWORK_BOUNDARY_CHECK" ] || fail "network boundary check is not executable"
  [ -x "$CREDENTIAL_BOUNDARY_CHECK" ] || fail "credential boundary check is not executable"
  # The generic cloud-onboard target runs shared checks against OpenClaw. Typed
  # DCode targets reject this SKIP through the required-check wrapper.
  if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
    printf '%s: SKIP: sandbox %q is not a Deep Agents Code sandbox\n' "$PREFIX" "$SANDBOX_NAME"
    exit 0
  fi

  command -v expect >/dev/null 2>&1 || fail "expect is required for the DCode autorun TUI check"
  command -v node >/dev/null 2>&1 || fail "node is required to inspect status JSON"
  is_positive_integer "$TUI_TIMEOUT" \
    || fail "DEEPAGENTS_AUTORUN_TIMEOUT must be a positive integer"

  trap restore_export_baseline_on_exit EXIT
  cleanup_probe_files

  assert_capability_projection disabled
  assert_status_mode disabled
  assert_default_denial_ignores_ambient_override
  pass "fresh sandbox denies auto-approval by trusted default and ignores ambient overrides"

  local saved_config_digest
  saved_config_digest="$(
    openshell sandbox exec --name "$SANDBOX_NAME" -- \
      /usr/bin/env HOME=/sandbox /opt/venv/bin/python3 -I -c "$(save_preferences_source)"
  )" || fail "installed DCode could not save native preferences"
  assert_saved_identity "$saved_config_digest"
  pass "native preference save removes comments and preserves protected identity for every alias"

  local rebuild_output
  info "Enabling thread-opt-in through the named sandbox rebuild interface"
  rebuild_output="$(rebuild_named_sandbox thread-opt-in)" \
    || fail "named sandbox rebuild could not enable thread-opt-in: $rebuild_output"
  EXPORT_BASELINE_RECOVERY_ARMED=1

  assert_capability_projection thread-opt-in
  assert_status_mode thread-opt-in
  pass "named sandbox rebuild projects and reports thread-opt-in"

  assert_saved_identity "$saved_config_digest"
  pass "named rebuild restores saved preferences and preserves protected identity for every alias"

  local capture_dir marker_file
  capture_dir="$(mktemp -d "${TMPDIR:-/tmp}/${PREFIX}.XXXXXX")"
  marker_file="${capture_dir}/markers.log"
  : >"$marker_file"
  # Failure captures pass through the canonical redactor before reaching logs.
  if ! run_autorun_tui "$marker_file" \
    | node --no-warnings "${REPO}/test/e2e/fixtures/redaction.ts"; then
    capture_autorun_diagnostics
    fail "finite DCode autorun TUI harness failed: $(tr '\n' ' ' <"$marker_file")"
  fi
  capture_autorun_diagnostics
  assert_autorun_evidence "$marker_file"
  rm -rf "$capture_dir"
  pass "native Auto opt-in runs sequential shell and non-shell rounds"

  run_boundary_check "OpenShell network policy boundary" "$NETWORK_BOUNDARY_CHECK"
  run_boundary_check "managed credential boundary" "$CREDENTIAL_BOUNDARY_CHECK"

  local state_before state_after
  state_before="$(native_state_digest)" || fail "could not capture native state before revocation"
  [[ "$state_before" =~ ^[a-f0-9]{64}$ ]] || fail "native state digest is missing or malformed"
  info "Disabling thread-opt-in through the named sandbox rebuild interface"
  rebuild_output="$(rebuild_named_sandbox disabled --no-observability)" \
    || fail "named sandbox rebuild could not restore the export baseline: $rebuild_output"

  state_after="$(native_state_digest)" || fail "could not inspect native state after revocation"
  [ "$state_after" = "$state_before" ] || fail "revocation changed conversation or workspace state"
  assert_capability_projection disabled
  assert_status_mode disabled
  assert_default_denial_ignores_ambient_override
  [ "$(export_baseline_registry_state)" = "disabled:disabled" ] \
    || fail "named sandbox rebuild did not restore retained approval and observability state"
  EXPORT_BASELINE_RECOVERY_ARMED=0
  pass "named sandbox rebuild preserves native state and restores the disabled export baseline"

  printf '%s: 8 passed, 0 failed\n' "$PREFIX"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
