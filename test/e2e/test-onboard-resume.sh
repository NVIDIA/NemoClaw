#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# E2E: interrupted onboard -> resume -> verify completion.
#
# Regression test for issue #446.
# Validates that:
#   1. A non-interactive onboard run can fail after sandbox creation while leaving resumable state.
#   2. The onboard session file records the interrupted state safely.
#   3. `nemoclaw onboard --resume --non-interactive` skips cached preflight,
#      gateway, and sandbox work, then completes by hydrating the stored credential.
#
# Prerequisites:
#   - Docker running
#   - openshell CLI installed
#   - Node.js available
#   - local fake OpenAI-compatible endpoint reachable from host and sandbox
#
# Usage:
#   bash test/e2e/test-onboard-resume.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=600
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

run_nemoclaw() {
  node "$REPO/bin/nemoclaw.js" "$@"
}

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-resume}"

# Shim so the teardown helper's trap can call `nemoclaw destroy` even when
# this repo-local test run has no globally-installed `nemoclaw` on PATH (it
# drives the CLI via `node "$REPO/bin/nemoclaw.js"` via run_nemoclaw).
if ! command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw() { node "$REPO/bin/nemoclaw.js" "$@"; }
fi

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
# shellcheck source=test/e2e/lib/hermetic-compatible-inference.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/hermetic-compatible-inference.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

cleanup_on_exit() {
  nemoclaw_e2e_stop_hermetic_compatible_inference
  _nemoclaw_sandbox_teardown
}
trap cleanup_on_exit EXIT

SESSION_FILE="$HOME/.nemoclaw/onboard-session.json"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
EXPECTED_PROVIDER="compatible-endpoint"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Pre-cleanup"
info "Destroying any leftover sandbox/gateway from previous runs..."
run_nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
openshell forward stop 18789 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true
rm -f "$SESSION_FILE"
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell CLI installed"
else
  fail "openshell CLI not found — cannot continue"
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  pass "Node.js available"
else
  fail "Node.js not found — cannot continue"
  exit 1
fi

if nemoclaw_e2e_start_hermetic_compatible_inference; then
  pass "Configured onboard resume test for hermetic compatible-endpoint inference at ${FAKE_OPENAI_BASE_URL}"
else
  fail "Fake OpenAI-compatible endpoint failed to start"
  sed 's/^/    /' "${FAKE_OPENAI_LOG:-/dev/null}" 2>/dev/null || true
  exit 1
fi

if curl -sf "${FAKE_OPENAI_BASE_URL}/models" >/dev/null 2>&1; then
  pass "Network access to fake OpenAI-compatible endpoint"
else
  fail "Cannot reach fake OpenAI-compatible endpoint at ${FAKE_OPENAI_BASE_URL}"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: First onboard (forced failure after sandbox creation)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: First onboard (interrupted)"
info "Running onboard with E2E failure injection at the policy step..."

# Force a deterministic interruption after the sandbox and OpenClaw setup
# complete, but before policy setup completes. This keeps resume coverage
# independent of product validation behavior such as policy-mode parsing.
FIRST_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_POLICY_MODE=suggested \
  NEMOCLAW_E2E_FAILURE_INJECTION=1 \
  NEMOCLAW_E2E_FORCE_FAIL_AT_STEP=policies \
  node "$REPO/bin/nemoclaw.js" onboard --non-interactive >"$FIRST_LOG" 2>&1
first_exit=$?
first_output="$(cat "$FIRST_LOG")"
rm -f "$FIRST_LOG"

if [ $first_exit -eq 1 ]; then
  pass "First onboard exited 1 (expected interrupted run)"
else
  fail "First onboard exited $first_exit (expected 1)"
  echo "$first_output"
  exit 1
fi

if echo "$first_output" | grep -q "Sandbox '${SANDBOX_NAME}' created"; then
  pass "Sandbox '$SANDBOX_NAME' created before interruption"
else
  fail "Sandbox creation not confirmed in first run output"
fi

if echo "$first_output" | grep -q "\[e2e\] Forced onboarding failure at step 'policies'."; then
  pass "First run failed at policy setup as intended"
else
  fail "First run did not fail at the expected policy step"
fi

if openshell sandbox get "$SANDBOX_NAME" >/dev/null 2>&1; then
  pass "Sandbox '$SANDBOX_NAME' exists after interrupted run"
else
  fail "Sandbox '$SANDBOX_NAME' not found after interrupted run"
fi

if [ -f "$SESSION_FILE" ]; then
  pass "Onboard session file created"
else
  fail "Onboard session file missing after interrupted run"
fi

node -e '
const fs = require("fs");
const file = process.argv[1];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (data.status !== "failed") process.exit(1);
if (data.lastCompletedStep !== "openclaw") process.exit(2);
if (!data.failure || data.failure.step !== "policies") process.exit(3);
' "$SESSION_FILE"
case $? in
  0) pass "Session file recorded openclaw completion and policy failure" ;;
  *) fail "Session file did not record the expected interrupted state" ;;
esac

if nemoclaw_e2e_assert_hermetic_compatible_inference_used; then
  pass "Fake OpenAI-compatible endpoint handled authenticated inference"
else
  fail "Fake OpenAI-compatible endpoint did not record authenticated inference"
  sed 's/^/    /' "$FAKE_OPENAI_REQUESTS_FILE" 2>/dev/null || true
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Resume and complete
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Resume"
info "Running onboard --resume with NVIDIA_INFERENCE_API_KEY removed from env..."

RESUME_LOG="$(mktemp)"
env -u NVIDIA_INFERENCE_API_KEY -u COMPATIBLE_API_KEY \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_POLICY_MODE=skip \
  node "$REPO/bin/nemoclaw.js" onboard --resume --non-interactive >"$RESUME_LOG" 2>&1
resume_exit=$?
resume_output="$(cat "$RESUME_LOG")"
rm -f "$RESUME_LOG"

if [ $resume_exit -eq 0 ]; then
  pass "Resume completed successfully"
else
  fail "Resume exited $resume_exit (expected 0)"
  echo "$resume_output"
  exit 1
fi

if echo "$resume_output" | grep -q "\[resume\] Skipping preflight (cached)"; then
  pass "Resume skipped preflight"
else
  fail "Resume did not skip preflight"
fi

if echo "$resume_output" | grep -q "\[resume\] Skipping gateway (running)"; then
  pass "Resume skipped gateway"
else
  fail "Resume did not skip gateway"
fi

if echo "$resume_output" | grep -q "\[resume\] Skipping sandbox (${SANDBOX_NAME})"; then
  pass "Resume skipped sandbox"
else
  fail "Resume did not skip sandbox"
fi

if echo "$resume_output" | grep -q "\[1/7\] Preflight checks"; then
  fail "Resume reran preflight unexpectedly"
else
  pass "Resume did not rerun preflight"
fi

if echo "$resume_output" | grep -q "\[2/7\] Starting OpenShell gateway"; then
  fail "Resume reran gateway startup unexpectedly"
else
  pass "Resume did not rerun gateway startup"
fi

if echo "$resume_output" | grep -q "\[5/7\] Creating sandbox"; then
  fail "Resume reran sandbox creation unexpectedly"
else
  pass "Resume did not rerun sandbox creation"
fi

# The first onboard completed through openclaw (step 7) before failing at
# policies (step 8). Inference was already configured during that run, so
# the resume path detects it is ready (isInferenceRouteReady) and skips it.
if echo "$resume_output" | grep -q "\[4/7\] Setting up inference provider"; then
  pass "Resume re-ran inference setup"
elif echo "$resume_output" | grep -q "\[resume\] Skipping inference\|\[reuse\] Skipping inference"; then
  pass "Resume skipped inference (already configured)"
else
  fail "Resume neither ran nor skipped inference setup"
fi

if run_nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1; then
  pass "Sandbox '$SANDBOX_NAME' is manageable after resume"
else
  fail "Sandbox '$SANDBOX_NAME' status failed after resume"
fi

node -e '
const fs = require("fs");
const file = process.argv[1];
const expectedProvider = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (data.status !== "complete") process.exit(1);
if (data.provider !== expectedProvider) process.exit(2);
if (data.steps.preflight.status !== "complete") process.exit(3);
if (data.steps.gateway.status !== "complete") process.exit(4);
if (data.steps.sandbox.status !== "complete") process.exit(5);
if (data.steps.provider_selection.status !== "complete") process.exit(6);
if (data.steps.inference.status !== "complete") process.exit(7);
if (data.steps.openclaw.status !== "complete") process.exit(8);
if (data.steps.policies.status !== "complete") process.exit(9);
' "$SESSION_FILE" "$EXPECTED_PROVIDER"
case $? in
  0) pass "Session file recorded full completion after resume" ;;
  *) fail "Session file did not record the expected completed state after resume" ;;
esac

if [ -f "$REGISTRY" ] && grep -q "$SANDBOX_NAME" "$REGISTRY"; then
  pass "Registry contains resumed sandbox entry"
else
  fail "Registry does not contain resumed sandbox entry"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3.5: Implicit resume (plain `onboard`, no --resume flag) — #5470
# ══════════════════════════════════════════════════════════════════
# The fix auto-detects resume from a persisted in_progress session. The
# section above proves explicit `--resume`; this proves a plain `onboard`
# rerun resumes on its own, and that `--fresh` suppresses it.
section "Phase 3.5: Implicit resume from in_progress session"

# Re-mark the now-complete session as in_progress so a plain `onboard` has
# something to auto-resume. Everything is already provisioned, so the resume
# skips every cached step and finishes fast.
# Mimic an interrupted-but-resumable session: status "in_progress" AND
# resumable !== false. Phase 3 marks the completed session `resumable: false`,
# so flipping status alone would (correctly) be rejected as "no resumable
# session"; resetting resumable reconstructs the interrupted shape the resume
# machine accepts (session-bootstrap.ts:140).
set_session_in_progress() {
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.status = "in_progress";
    data.resumable = true;
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  ' "$SESSION_FILE"
}

set_session_in_progress
info "Running plain onboard (no --resume) on an in_progress session..."
IMPLICIT_LOG="$(mktemp)"
env -u NVIDIA_INFERENCE_API_KEY -u COMPATIBLE_API_KEY \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_POLICY_MODE=skip \
  node "$REPO/bin/nemoclaw.js" onboard --non-interactive >"$IMPLICIT_LOG" 2>&1
implicit_exit=$?
implicit_output="$(cat "$IMPLICIT_LOG")"
rm -f "$IMPLICIT_LOG"

if [ $implicit_exit -eq 0 ]; then
  pass "Implicit resume (plain onboard) completed successfully"
else
  fail "Implicit resume exited $implicit_exit (expected 0)"
  echo "$implicit_output"
fi

if echo "$implicit_output" | grep -q "(resume mode)"; then
  pass "Plain onboard auto-detected resume mode from in_progress session"
else
  fail "Plain onboard did not show '(resume mode)' for an in_progress session"
fi

if echo "$implicit_output" | grep -q "\[resume\] Skipping\|\[reuse\] Skipping"; then
  pass "Implicit resume skipped cached steps"
else
  fail "Implicit resume did not skip any cached steps"
fi

# --fresh must suppress the auto-resume even with an in_progress session.
# Fail-fast at preflight (step 1, before sandbox recreation) so this stays
# cheap and non-destructive; the banner is emitted before that step.
set_session_in_progress
info "Running onboard --fresh on the same in_progress session (fail-fast)..."
FRESH_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_POLICY_MODE=skip \
  NEMOCLAW_E2E_FAILURE_INJECTION=1 \
  NEMOCLAW_E2E_FORCE_FAIL_AT_STEP=preflight \
  node "$REPO/bin/nemoclaw.js" onboard --fresh --non-interactive >"$FRESH_LOG" 2>&1
fresh_exit=$?
fresh_output="$(cat "$FRESH_LOG")"
rm -f "$FRESH_LOG"

# Confirm the run actually executed and aborted at preflight, so the
# banner-absence assertion below is meaningful (not a vacuous pass from an
# unrelated early failure).
if [ $fresh_exit -ne 0 ] && echo "$fresh_output" | grep -q "\[e2e\] Forced onboarding failure at step 'preflight'."; then
  pass "--fresh run failed fast at preflight as intended"
else
  fail "--fresh run did not fail at preflight as expected (exit $fresh_exit)"
  echo "$fresh_output"
fi

if echo "$fresh_output" | grep -q "(resume mode)"; then
  fail "--fresh did not suppress auto-resume (unexpected '(resume mode)')"
else
  pass "--fresh suppressed auto-resume despite an in_progress session"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Final cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Final cleanup"

[[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || run_nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
openshell forward stop 18789 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true
rm -f "$SESSION_FILE"

if openshell sandbox get "$SANDBOX_NAME" >/dev/null 2>&1; then
  fail "Sandbox '$SANDBOX_NAME' still exists after cleanup"
else
  pass "Sandbox '$SANDBOX_NAME' cleaned up"
fi

if [ -f "$SESSION_FILE" ]; then
  fail "Onboard session file still exists after cleanup"
else
  pass "Onboard session file cleaned up"
fi

pass "Final cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP"
echo " TOTAL: $TOTAL"
echo "========================================"
echo ""

if [ $FAIL -ne 0 ]; then
  exit 1
fi
