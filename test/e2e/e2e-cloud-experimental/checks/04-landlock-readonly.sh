#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Landlock read-only enforcement on /sandbox (#804).
#
# These checks run INSIDE a real OpenShell sandbox where Landlock is active.
# They verify that the kernel enforces read-only on paths that DAC alone
# cannot protect (e.g., sandbox-owned .bashrc/.profile in a root-owned dir).
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

info "Running Landlock read-only checks in sandbox: $SANDBOX_NAME"

# ── 1: Cannot create files in /sandbox (Landlock read_only) ───────
info "1. Cannot create files in /sandbox"
OUT=$(sandbox_exec "touch /sandbox/landlock-test 2>&1 || echo BLOCKED")
if echo "$OUT" | grep -qi "BLOCKED\|Permission denied\|Read-only\|EACCES"; then
  pass "sandbox home is Landlock read-only"
else
  fail_test "/sandbox is writable under Landlock: $OUT"
fi

# ── 2: Cannot modify .bashrc (sandbox-owned but Landlock read_only) ─
info "2. Cannot modify .bashrc (Landlock protects sandbox-owned files)"
OUT=$(sandbox_exec "echo 'malicious' >> /sandbox/.bashrc 2>&1 || echo BLOCKED")
if echo "$OUT" | grep -qi "BLOCKED\|Permission denied\|Read-only\|EACCES"; then
  pass ".bashrc is Landlock read-only despite sandbox ownership"
else
  fail_test ".bashrc is writable under Landlock: $OUT"
fi

# ── 3: Cannot modify .profile (sandbox-owned but Landlock read_only) ─
info "3. Cannot modify .profile (Landlock protects sandbox-owned files)"
OUT=$(sandbox_exec "echo 'malicious' >> /sandbox/.profile 2>&1 || echo BLOCKED")
if echo "$OUT" | grep -qi "BLOCKED\|Permission denied\|Read-only\|EACCES"; then
  pass ".profile is Landlock read-only despite sandbox ownership"
else
  fail_test ".profile is writable under Landlock: $OUT"
fi

# ── 4: Cannot write to .openclaw/openclaw.json ────────────────────
info "4. Cannot write to openclaw.json (Landlock + DAC)"
OUT=$(sandbox_exec "echo '{}' > /sandbox/.openclaw/openclaw.json 2>&1 || echo BLOCKED")
if echo "$OUT" | grep -qi "BLOCKED\|Permission denied\|Read-only\|EACCES"; then
  pass "openclaw.json is read-only under Landlock"
else
  fail_test "openclaw.json is writable under Landlock: $OUT"
fi

# ── 5: Cannot create new files in .openclaw dir ──────────────────
info "5. Cannot create files in .openclaw (Landlock read_only)"
OUT=$(sandbox_exec "touch /sandbox/.openclaw/evil 2>&1 || echo BLOCKED")
if echo "$OUT" | grep -qi "BLOCKED\|Permission denied\|Read-only\|EACCES"; then
  pass ".openclaw dir is Landlock read-only"
else
  fail_test ".openclaw dir is writable under Landlock: $OUT"
fi

# ── 6: CAN write to .openclaw-data (Landlock read_write) ─────────
info "6. Can write to .openclaw-data (Landlock read_write)"
OUT=$(sandbox_exec "touch /sandbox/.openclaw-data/landlock-test && echo OK || echo FAILED")
if echo "$OUT" | grep -q "OK"; then
  pass ".openclaw-data is writable under Landlock"
else
  fail_test ".openclaw-data is NOT writable under Landlock: $OUT"
fi

# ── 7: CAN write to .nemoclaw/state (Landlock read_write via parent) ─
info "7. Can write to .nemoclaw/state (Landlock read_write)"
OUT=$(sandbox_exec "touch /sandbox/.nemoclaw/state/landlock-test && echo OK || echo FAILED")
if echo "$OUT" | grep -q "OK"; then
  pass ".nemoclaw/state is writable under Landlock"
else
  fail_test ".nemoclaw/state is NOT writable under Landlock: $OUT"
fi

# ── 8: CAN write to /tmp (Landlock read_write) ───────────────────
info "8. Can write to /tmp (Landlock read_write)"
OUT=$(sandbox_exec "touch /tmp/landlock-test && echo OK || echo FAILED")
if echo "$OUT" | grep -q "OK"; then
  pass "/tmp is writable under Landlock"
else
  fail_test "/tmp is NOT writable under Landlock: $OUT"
fi

# ── Cleanup test artifacts ────────────────────────────────────────
sandbox_exec "rm -f /sandbox/.openclaw-data/landlock-test /sandbox/.nemoclaw/state/landlock-test /tmp/landlock-test 2>/dev/null" || true

# ── Summary ───────────────────────────────────────────────────────
printf '%s\n' "04-landlock-readonly: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
