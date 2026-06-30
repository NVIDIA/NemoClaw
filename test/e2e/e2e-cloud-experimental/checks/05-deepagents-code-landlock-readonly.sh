#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Deep Agents Code Landlock policy behavior (#4861).
#
# These checks run INSIDE a real OpenShell sandbox where Landlock is active.
# They are intentionally skipped for non-Deep Agents Code sandboxes so the
# shared cloud checks can continue to validate OpenClaw/Hermes sandboxes.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-onboard}}"
PREFIX="05-deepagents-code-landlock-readonly"

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

PASSED=0
FAILED=0

if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
  info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
  exit 0
fi

info "Running Deep Agents Code Landlock checks in sandbox: $SANDBOX_NAME"

OUT=$(sandbox_exec "touch /sandbox/.deepagents/deepagents-landlock-test && echo OK || echo FAILED" || true)
if echo "$OUT" | grep -q "OK"; then
  pass "/sandbox/.deepagents is writable for Deep Agents state"
else
  fail_test "/sandbox/.deepagents is NOT writable under Landlock: $OUT"
fi

OUT=$(sandbox_exec "touch /usr/deepagents-landlock-test 2>&1 || echo BLOCKED" || true)
if echo "$OUT" | grep -qi "BLOCKED\|Permission denied\|Read-only\|EACCES"; then
  pass "/usr is Landlock read-only for Deep Agents Code"
else
  fail_test "/usr is writable under the Deep Agents Code policy: $OUT"
fi

OUT=$(sandbox_exec "touch /opt/venv/deepagents-landlock-test 2>&1 || echo BLOCKED" || true)
if echo "$OUT" | grep -qi "BLOCKED\|Permission denied\|Read-only\|EACCES"; then
  pass "/opt/venv is Landlock read-only for Deep Agents Code"
else
  fail_test "/opt/venv is writable under the Deep Agents Code policy: $OUT"
fi

OUT=$(sandbox_exec "touch /etc/deepagents-landlock-test 2>&1 || echo BLOCKED" || true)
if echo "$OUT" | grep -qi "BLOCKED\|Permission denied\|Read-only\|EACCES"; then
  pass "/etc is Landlock read-only for Deep Agents Code"
else
  fail_test "/etc is writable under the Deep Agents Code policy: $OUT"
fi

OUT=$(sandbox_exec "touch /tmp/deepagents-landlock-test && echo OK || echo FAILED" || true)
if echo "$OUT" | grep -q "OK"; then
  pass "/tmp is writable for Deep Agents temporary files"
else
  fail_test "/tmp is NOT writable under Landlock: $OUT"
fi

sandbox_exec "rm -f /sandbox/.deepagents/deepagents-landlock-test /usr/deepagents-landlock-test /opt/venv/deepagents-landlock-test /etc/deepagents-landlock-test /tmp/deepagents-landlock-test 2>/dev/null || true" || true

printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
