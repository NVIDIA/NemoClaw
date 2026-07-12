#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# E2E smoke test for non-root sandbox execution under
# --security-opt no-new-privileges (issue #2571).
#
# Replicates Brev Launchable / DGX Spark's PR_SET_NO_NEW_PRIVS constraint
# in CI to catch regressions of:
#
#   - #2472 (2026-04-25): non-root entrypoint crashed when install_configure_guard
#     wrote to ~/.bashrc/.profile under Landlock + `set -e` — 5-day outage
#     invisible to CI. Architecturally gone after #2741 (rc files are now
#     root:root 444 static shims); this test guards the symptom — entrypoint
#     exits non-zero under no-new-privileges.
#
# (#2482-class detection — `openclaw tui` "Missing gateway auth token" — is
# deferred to a follow-up PR after #2485 merges, since current main has no
# token-generation code path in the standalone container.)
#
# CAVEAT: no-new-privileges ≠ Landlock. We catch #2472-class bugs only
# when they manifest as a non-zero entrypoint exit; the original ~/.bashrc
# write under Landlock is not reproduced. A real Landlock ruleset is future
# work (#2571).
#
# How: ENTRYPOINT=`nemoclaw-start`, CMD=`["/bin/bash"]`. Passing a command
# to `docker run` overrides CMD; the entrypoint captures it into NEMOCLAW_CMD
# and exec's it *after* setup (nemoclaw-start.sh:1508 non-root / :1613 root).
# We pass `true` (Test 1) so setup runs end-to-end without entering the
# gateway-launch path (which needs OpenShell).
#
# Requires: docker

set -euo pipefail

IMAGE="${NEMOCLAW_TEST_IMAGE:-nemoclaw-production}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
  echo -e "${GREEN}PASS${NC}: $1"
  PASSED=$((PASSED + 1))
}
fail() {
  echo -e "${RED}FAIL${NC}: $1"
  FAILED=$((FAILED + 1))
}
info() { echo -e "${YELLOW}TEST${NC}: $1"; }

PASSED=0
FAILED=0

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  fail "Image $IMAGE not found — load it before running this test"
  exit 1
fi

# Helper: run the entrypoint under --security-opt no-new-privileges with
# a final command of the caller's choice. The command is captured by
# nemoclaw-start as NEMOCLAW_CMD and exec'd after entrypoint setup.
# Returns combined stdout+stderr; caller checks $? and/or output.
run_under_nnp() {
  docker run --rm --security-opt no-new-privileges "$IMAGE" "$@" 2>&1 || return $?
}

# ── Test 1: Entrypoint setup completes under no-new-privileges (#2472) ──

info "1. Entrypoint setup chain completes under --security-opt no-new-privileges"
RC=0
OUT=$(run_under_nnp true) || RC=$?
if [ "$RC" -eq 0 ]; then
  pass "entrypoint exited 0 under no-new-privileges (#2472 setup chain healthy)"
else
  fail "entrypoint exited $RC under no-new-privileges — likely #2472-class regression"
  echo "$OUT" | tail -20 | sed 's/^/  /'
fi

# ── Test 2: Kernel confirms PR_SET_NO_NEW_PRIVS is applied (sanity) ──

info "2. Kernel confirms NoNewPrivs=1 inside container (defends against silent flag typos)"
NNP=$(docker run --rm --security-opt no-new-privileges --entrypoint "" "$IMAGE" \
  sh -c 'grep ^NoNewPrivs /proc/self/status' 2>/dev/null \
  | awk '{print $2}' || echo "")
if [ "$NNP" = "1" ]; then
  pass "kernel confirms NoNewPrivs=1"
else
  fail "expected NoNewPrivs=1 inside container, got '${NNP:-<empty>}'"
fi

# ── Summary ─────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "  Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
echo -e "${GREEN}========================================${NC}"

[ "$FAILED" -eq 0 ] || exit 1
