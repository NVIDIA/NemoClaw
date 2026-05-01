#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Landlock filesystem enforcement (#804).
#
# These checks run INSIDE a real OpenShell sandbox where Landlock is active.
# They verify that the kernel enforces the filesystem policy: /sandbox and
# /sandbox/.openclaw are writable (mutable default), trusted shell startup
# files remain read-only, system paths are read-only, and /tmp is writable.
#
# The Docker-only e2e tests (test/e2e-gateway-isolation.sh) cover DAC
# enforcement but cannot exercise Landlock. This script closes that gap.
#
# Prerequisites:
#   - openshell on PATH, sandbox exists and is Ready
#   - SANDBOX_NAME set (default: e2e-cloud-experimental)

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-experimental}}"

die() {
  printf '%s\n' "04-landlock-readonly: FAIL: $*" >&2
  exit 1
}
ok() { printf '%s\n' "04-landlock-readonly: OK ($*)"; }
info() { printf '%s\n' "04-landlock-readonly: $*"; }

PASSED=0
FAILED=0

pass() {
  ok "$1"
  PASSED=$((PASSED + 1))
}
fail_test() {
  printf '%s\n' "04-landlock-readonly: FAIL: $1" >&2
  FAILED=$((FAILED + 1))
}

# Helper: run a command inside the sandbox via openshell
sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c "$1" 2>&1
}

info "Running Landlock filesystem checks in sandbox: $SANDBOX_NAME"

# ── 1: CAN create files in /sandbox (include_workdir: true) ───────
info "1. Can create files in /sandbox (home is writable)"
OUT=$(sandbox_exec "touch /sandbox/landlock-test && echo OK || echo FAILED" || true)
if echo "$OUT" | grep -q "OK"; then
  pass "sandbox home is Landlock writable"
else
  fail_test "/sandbox is NOT writable under Landlock: $OUT"
fi

# ── 2: Cannot modify trusted shell startup files ─────────────────
info "2. Cannot modify .bashrc/.profile (trusted startup snippets)"
OUT=$(sandbox_exec "echo '# test' >> /sandbox/.bashrc 2>&1 || echo BASHRC_BLOCKED; sed -i '/^# test$/d' /sandbox/.bashrc 2>/dev/null || true; echo '# test' >> /sandbox/.profile 2>&1 || echo PROFILE_BLOCKED; sed -i '/^# test$/d' /sandbox/.profile 2>/dev/null || true" || true)
if echo "$OUT" | grep -q "BASHRC_BLOCKED" && echo "$OUT" | grep -q "PROFILE_BLOCKED"; then
  pass ".bashrc/.profile remain read-only while home is mutable"
else
  fail_test ".bashrc/.profile should be read-only trusted startup files: $OUT"
fi

# ── 3: CAN write to .openclaw (mutable default) ──────────────────
info "3. Can create files in .openclaw (mutable default)"
OUT=$(sandbox_exec "touch /sandbox/.openclaw/landlock-test && echo OK || echo FAILED" || true)
if echo "$OUT" | grep -q "OK"; then
  pass ".openclaw dir is writable in mutable-default mode"
else
  fail_test ".openclaw dir is NOT writable under Landlock: $OUT"
fi

# ── 4: Cannot write to /usr (system path read-only) ──────────────
info "4. Cannot write to /usr (system path read-only)"
OUT=$(sandbox_exec "touch /usr/landlock-test 2>&1 || echo BLOCKED" || true)
if echo "$OUT" | grep -qi "BLOCKED\|Permission denied\|Read-only\|EACCES"; then
  pass "/usr is Landlock read-only"
else
  fail_test "/usr is writable under Landlock: $OUT"
fi

# ── 5: Cannot write to /etc (system path read-only) ──────────────
info "5. Cannot write to /etc (system path read-only)"
OUT=$(sandbox_exec "touch /etc/landlock-test 2>&1 || echo BLOCKED" || true)
if echo "$OUT" | grep -qi "BLOCKED\|Permission denied\|Read-only\|EACCES"; then
  pass "/etc is Landlock read-only"
else
  fail_test "/etc is writable under Landlock: $OUT"
fi

# ── 6: CAN write to .nemoclaw/state (Landlock read_write via parent) ─
info "6. Can write to .nemoclaw/state (Landlock read_write)"
OUT=$(sandbox_exec "touch /sandbox/.nemoclaw/state/landlock-test && echo OK || echo FAILED" || true)
if echo "$OUT" | grep -q "OK"; then
  pass ".nemoclaw/state is writable under Landlock"
else
  fail_test ".nemoclaw/state is NOT writable under Landlock: $OUT"
fi

# ── 7: CAN write to /tmp (Landlock read_write) ───────────────────
info "7. Can write to /tmp (Landlock read_write)"
OUT=$(sandbox_exec "touch /tmp/landlock-test && echo OK || echo FAILED" || true)
if echo "$OUT" | grep -q "OK"; then
  pass "/tmp is writable under Landlock"
else
  fail_test "/tmp is NOT writable under Landlock: $OUT"
fi

# ── Cleanup test artifacts ────────────────────────────────────────
sandbox_exec "sed -i '/^# test$/d' /sandbox/.bashrc /sandbox/.profile 2>/dev/null || true; rm -f /sandbox/landlock-test /sandbox/.openclaw/landlock-test /sandbox/.nemoclaw/state/landlock-test /usr/landlock-test /etc/landlock-test /tmp/landlock-test 2>/dev/null" || true

# ── Summary ───────────────────────────────────────────────────────
printf '%s\n' "04-landlock-readonly: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
