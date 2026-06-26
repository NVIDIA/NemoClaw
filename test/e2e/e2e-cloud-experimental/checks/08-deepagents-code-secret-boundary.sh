#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Deep Agents Code dcode secret boundary (#5741, #5742).
#
# These checks run against a real Deep Agents Code sandbox. They verify the
# managed wrapper refuses secret-shaped runtime and .env values before launching
# upstream dcode, without echoing the raw secret or mutating the env file.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-onboard}}"
PREFIX="08-deepagents-code-secret-boundary"
DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"
FAKE_SECRET="sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000"
ENV_BACKUP="/tmp/${PREFIX}.env.backup.$$"
ENV_EXISTED=0
NETWORK_LOG_PATTERN="NET:OPEN|inference\\.local|pypi\\.org|api\\.openai\\.com|integrate\\.api\\.nvidia\\.com|Server ready|Task completed|PING"
AUDIT_NETWORK_LOG_PATTERN="NET:OPEN|inference\\.local|pypi\\.org|api\\.openai\\.com|integrate\\.api\\.nvidia\\.com"

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

dcode_secret_probe() {
  local command="$1"
  sandbox_exec "
tmp=\$(mktemp /tmp/dcode-secret-boundary.XXXXXX)
${command} >\"\$tmp\" 2>&1
status=\$?
cat \"\$tmp\"
rm -f \"\$tmp\"
printf 'DCODE_EXIT:%s\n' \"\$status\"
exit 0
"
}

make_log_marker() {
  local label="$1"
  printf '%s-%s-%s-%s' "$PREFIX" "$label" "$(date +%s%N)" "$$" | tr -c 'A-Za-z0-9_.-' '-'
}

mark_sandbox_logs() {
  local marker="$1"
  sandbox_exec "
for log in /tmp/gateway.log /tmp/nemoclaw-start.log; do
  if [ ! -e \"\$log\" ]; then
    : > \"\$log\" 2>/dev/null || true
  fi
  printf '%s\n' ${marker@Q} >> \"\$log\" 2>/dev/null || true
done
" >/dev/null || true
}

sandbox_logs_since_marker() {
  local marker="$1"
  sandbox_exec "
found=0
for log in /tmp/gateway.log /tmp/nemoclaw-start.log; do
  [ -r \"\$log\" ] || continue
  if grep -Fq ${marker@Q} \"\$log\" 2>/dev/null; then
    found=1
    printf '== %s ==\n' \"\$log\"
    awk -v marker=${marker@Q} 'found { print } index(\$0, marker) { found=1; next }' \"\$log\" 2>/dev/null || true
  fi
done
printf 'LOG_MARKER_FOUND:%s\n' \"\$found\"
"
}

enable_openshell_audit_logs() {
  if openshell settings set "$SANDBOX_NAME" --key ocsf_json_enabled --value true >/dev/null 2>&1; then
    pass "OpenShell audit logs enabled"
  else
    fail_test "could not enable OpenShell audit logs for ${SANDBOX_NAME}"
  fi
}

openshell_audit_logs_since_epoch() {
  local start_epoch="$1"
  local output=""

  if ! output="$(openshell logs "$SANDBOX_NAME" -n 500 --source all --since 2m 2>&1)"; then
    printf 'AUDIT_LOG_READ:0\n%s\n' "$output"
    return 0
  fi

  printf 'AUDIT_LOG_READ:1\n'
  printf '%s\n' "$output" | awk -v start="$start_epoch" '
    /^\[[0-9]+(\.[0-9]+)?\]/ {
      close = index($0, "]");
      ts = substr($0, 2, close - 2) + 0;
      keep = ts >= start;
      if (keep) print;
      next;
    }
    keep { print; }
  '
}

restore_env_file() {
  if [ "$ENV_EXISTED" -eq 1 ]; then
    sandbox_exec "cp ${ENV_BACKUP@Q} ${DEEPAGENTS_ENV_FILE@Q} 2>/dev/null || true; rm -f ${ENV_BACKUP@Q}" >/dev/null || true
  else
    sandbox_exec "rm -f ${DEEPAGENTS_ENV_FILE@Q} ${ENV_BACKUP@Q}" >/dev/null || true
  fi
}

assert_secret_rejected() {
  local label="$1"
  local output="$2"
  local expected_name="$3"

  if echo "$output" | grep -q "DCODE_EXIT:0"; then
    fail_test "${label}: dcode exited 0 instead of refusing the secret"
    return
  fi
  if ! echo "$output" | grep -q "DCODE_EXIT:"; then
    fail_test "${label}: probe did not capture a dcode exit status: $output"
    return
  fi
  if ! echo "$output" | grep -qi "refusing to start"; then
    fail_test "${label}: rejection message missing: $output"
    return
  fi
  if ! echo "$output" | grep -q "$expected_name"; then
    fail_test "${label}: rejection did not name ${expected_name}: $output"
    return
  fi
  if echo "$output" | grep -q "$FAKE_SECRET"; then
    fail_test "${label}: raw fake secret leaked into output"
    return
  fi
  if echo "$output" | grep -Eq "$NETWORK_LOG_PATTERN"; then
    fail_test "${label}: output shows dcode/network path ran before rejection: $output"
    return
  fi
  pass "${label}: secret rejected before dcode/network path"
}

assert_no_rejected_interval_network_logs() {
  local label="$1"
  local logs="$2"

  if ! echo "$logs" | grep -q "LOG_MARKER_FOUND:1"; then
    fail_test "${label}: sandbox logs did not preserve the rejection-time marker: $logs"
    return
  fi
  if echo "$logs" | grep -q "$FAKE_SECRET"; then
    fail_test "${label}: raw fake secret leaked into sandbox logs"
    return
  fi
  if echo "$logs" | grep -Eq "$NETWORK_LOG_PATTERN"; then
    fail_test "${label}: sandbox logs show network or dcode execution after rejection: $logs"
    return
  fi
  pass "${label}: sandbox logs show no network path after rejection"
}

assert_no_rejected_interval_audit_logs() {
  local label="$1"
  local logs="$2"

  if ! echo "$logs" | grep -q "AUDIT_LOG_READ:1"; then
    fail_test "${label}: OpenShell audit logs could not be read: $logs"
    return
  fi
  if echo "$logs" | grep -q "$FAKE_SECRET"; then
    fail_test "${label}: raw fake secret leaked into OpenShell audit logs"
    return
  fi
  if echo "$logs" | grep -Eq "$AUDIT_NETWORK_LOG_PATTERN"; then
    fail_test "${label}: OpenShell audit logs show network path after rejection: $logs"
    return
  fi
  pass "${label}: OpenShell audit logs show no network path after rejection"
}

PASSED=0
FAILED=0

if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
  info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
  exit 0
fi

info "Running Deep Agents Code secret-boundary checks in sandbox: $SANDBOX_NAME"
enable_openshell_audit_logs

runtime_log_marker="$(make_log_marker runtime-env)"
runtime_audit_start="$(($(date +%s) - 1))"
mark_sandbox_logs "$runtime_log_marker"
runtime_output="$(dcode_secret_probe "env OPENAI_API_KEY=${FAKE_SECRET@Q} dcode -n 'Reply with the single word PING'" || true)"
runtime_logs="$(sandbox_logs_since_marker "$runtime_log_marker" || true)"
runtime_audit_logs="$(openshell_audit_logs_since_epoch "$runtime_audit_start" || true)"
assert_secret_rejected "runtime environment injection" "$runtime_output" "OPENAI_API_KEY"
assert_no_rejected_interval_network_logs "runtime environment injection" "$runtime_logs"
assert_no_rejected_interval_audit_logs "runtime environment injection" "$runtime_audit_logs"

if sandbox_exec "test -f ${DEEPAGENTS_ENV_FILE@Q}" >/dev/null; then
  ENV_EXISTED=1
fi
sandbox_exec "mkdir -p /sandbox/.deepagents && cp ${DEEPAGENTS_ENV_FILE@Q} ${ENV_BACKUP@Q} 2>/dev/null || : > ${ENV_BACKUP@Q}" >/dev/null || true
trap restore_env_file EXIT

sandbox_exec "printf '%s\n' OPENAI_API_KEY=${FAKE_SECRET@Q} >> ${DEEPAGENTS_ENV_FILE@Q}" >/dev/null
env_before_hash="$(sandbox_exec "sha256sum ${DEEPAGENTS_ENV_FILE@Q} | awk '{print \$1}'" || true)"
env_log_marker="$(make_log_marker env-file)"
env_audit_start="$(($(date +%s) - 1))"
mark_sandbox_logs "$env_log_marker"
env_output="$(dcode_secret_probe "dcode -n 'Reply with the single word PING'" || true)"
env_logs="$(sandbox_logs_since_marker "$env_log_marker" || true)"
env_audit_logs="$(openshell_audit_logs_since_epoch "$env_audit_start" || true)"
env_after_hash="$(sandbox_exec "sha256sum ${DEEPAGENTS_ENV_FILE@Q} | awk '{print \$1}'" || true)"

assert_secret_rejected "deepagents env file" "$env_output" "OPENAI_API_KEY"
assert_no_rejected_interval_network_logs "deepagents env file" "$env_logs"
assert_no_rejected_interval_audit_logs "deepagents env file" "$env_audit_logs"
if [ -n "$env_before_hash" ] && [ "$env_before_hash" = "$env_after_hash" ]; then
  pass "env file is unchanged after rejection"
else
  fail_test "env file changed during rejection: before=${env_before_hash:-missing} after=${env_after_hash:-missing}"
fi

printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
