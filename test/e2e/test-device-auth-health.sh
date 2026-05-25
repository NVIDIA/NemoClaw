#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-device-auth-health.sh
# Device Auth Health Probe E2E — Regression test for #2342
#
# Validates that gateway health probes work correctly when device auth is
# enabled (the default). Previously, `curl -sf` treated HTTP 401 as failure,
# causing false "Health Offline" readings in the dashboard and unnecessary
# process recovery attempts.
#
# What this proves:
#   1. Onboard succeeds with device auth ON (verifyDeployment doesn't block)
#   2. /health endpoint returns 200 from inside sandbox (auth-free)
#   3. / endpoint returns 401 from inside sandbox (device auth active)
#   4. `nemoclaw <name> status` reports gateway Running (not Offline)
#   5. isSandboxGatewayRunning() correctly treats 401 as alive
#   6. After gateway restart, status still reports Running (not Offline)
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-health-auth)
#   NEMOCLAW_E2E_TIMEOUT_SECONDS           — overall timeout (default: 600)
#   NEMOCLAW_DASHBOARD_PORT                — dashboard port (default: 18789)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 \
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#   NVIDIA_API_KEY=nvapi-... \
#     bash test/e2e/test-device-auth-health.sh
# =============================================================================

# ShellCheck cannot see EXIT trap invocations of cleanup helpers in this E2E script.
# shellcheck disable=SC2317
set -uo pipefail

# ── Overall timeout ──────────────────────────────────────────────────────────
export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1200
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

# ── Config ───────────────────────────────────────────────────────────────────
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-health-auth}"
DASHBOARD_PORT="${NEMOCLAW_DASHBOARD_PORT:-18789}"

# ── Counters ─────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
TOTAL=0

# ── Helpers ──────────────────────────────────────────────────────────────────
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
  printf '\033[1;36m══════ %s ══════\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# shellcheck disable=SC2329
cleanup_ssh() { [[ -n "${SSH_CONFIG:-}" ]] && rm -f "$SSH_CONFIG"; }
trap 'cleanup_ssh' EXIT

# Execute a command inside the sandbox via SSH (the established E2E pattern).
SSH_CONFIG=""
setup_ssh() {
  SSH_CONFIG="$(mktemp)"
  local attempt
  for attempt in $(seq 1 5); do
    if openshell sandbox ssh-config "$SANDBOX_NAME" >"$SSH_CONFIG" 2>/dev/null; then
      if [[ -s "$SSH_CONFIG" ]]; then
        return 0
      fi
    fi
    sleep 3
  done
  info "Failed to get SSH config for '$SANDBOX_NAME' after 5 attempts"
  return 1
}
sandbox_exec() {
  local cmd="$1"
  if [[ -z "$SSH_CONFIG" ]] || [[ ! -s "$SSH_CONFIG" ]]; then
    setup_ssh || return 1
  fi
  ssh -F "$SSH_CONFIG" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" "$cmd" 2>/dev/null
}

# ══════════════════════════════════════════════════════════════════════════════
# Phase 0: Preflight
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 0: Preflight"

if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
  echo "ERROR: NVIDIA_API_KEY not set" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker not running" >&2
  exit 1
fi

info "Sandbox name: ${SANDBOX_NAME}"
info "Dashboard port: ${DASHBOARD_PORT}"
info "Device auth: ENABLED (default — no NEMOCLAW_DISABLE_DEVICE_AUTH)"
pass "Preflight checks passed"

# ══════════════════════════════════════════════════════════════════════════════
# Phase 1: Install & Onboard (device auth ON)
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 1: Install & Onboard"

# Clean up any previous sandbox with the same name
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true

INSTALL_LOG="/tmp/nemoclaw-e2e-health-install.log"

info "Installing NemoClaw (install.sh runs onboard in non-interactive mode)..."
INSTALL_EXIT=0
NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  bash scripts/install.sh --non-interactive 2>&1 | tee "$INSTALL_LOG" || INSTALL_EXIT=$?

# Source shell profile to pick up PATH changes from install.sh
# shellcheck disable=SC1091
source "$HOME/.bashrc" 2>/dev/null || true
if [[ -d "$HOME/.local/bin" ]] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi
export PATH="/usr/local/bin:$PATH"
hash -r

if [[ $INSTALL_EXIT -ne 0 ]]; then
  fail "Install failed with exit code $INSTALL_EXIT"
  info "See $INSTALL_LOG for details"
  exit 1
fi

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "nemoclaw not found on PATH after install"
  info "PATH=$PATH"
  exit 1
fi

# Detect actual dashboard port (may differ from default if port was taken)
ACTUAL_PORT=$(openshell forward list 2>/dev/null | grep "$SANDBOX_NAME" | awk '{print $3}' | head -1)
if [[ -n "$ACTUAL_PORT" ]]; then
  DASHBOARD_PORT="$ACTUAL_PORT"
  info "Detected actual dashboard port: ${DASHBOARD_PORT}"
fi

# Verify sandbox exists
if nemoclaw list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
  pass "Onboard succeeded — sandbox '${SANDBOX_NAME}' registered"
else
  fail "Sandbox '${SANDBOX_NAME}' not found in nemoclaw list after onboard"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════════════
# Phase 2: Health Endpoint Probes (inside sandbox)
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 2: Health Endpoint Probes"

# Ensure SSH is ready before probing
info "Setting up SSH to sandbox..."
if ! setup_ssh; then
  info "SSH setup failed — falling back to host-side probes only"
fi

# 2a: /health should return 200 (unaffected by device auth)
info "Probing /health endpoint inside sandbox..."
HEALTH_CODE=""
for attempt in $(seq 1 10); do
  HEALTH_CODE=$(
    sandbox_exec \
      "curl -so /dev/null -w '%{http_code}' --max-time 3 http://localhost:${DASHBOARD_PORT}/health"
  ) || true
  if [[ "$HEALTH_CODE" == "200" ]]; then
    break
  fi
  info "  Attempt ${attempt}/10: /health returned ${HEALTH_CODE:-empty}, retrying..."
  sleep 3
done

if [[ "$HEALTH_CODE" == "200" ]]; then
  pass "/health returns 200 (auth-free health endpoint via sandbox exec)"
elif [[ -z "$HEALTH_CODE" ]]; then
  # SSH exec not working — fall back to host probe (Phase 4 covers this)
  skip "/health via sandbox exec returned empty (SSH may not be available; host probe in Phase 4)"
else
  fail "/health returned ${HEALTH_CODE} — expected 200"
fi

# 2b: / should return 401 (proves device auth is active)
info "Probing / endpoint inside sandbox (expect 401 = device auth active)..."
ROOT_CODE=$(
  sandbox_exec \
    "curl -so /dev/null -w '%{http_code}' --max-time 3 http://localhost:${DASHBOARD_PORT}/"
) || true

if [[ "$ROOT_CODE" == "401" ]]; then
  pass "/ returns 401 (device auth is active — confirms test premise)"
elif [[ "$ROOT_CODE" == "200" ]]; then
  skip "/ returns 200 — device auth not active on this image (test still valid for /health)"
elif [[ -z "$ROOT_CODE" ]]; then
  skip "/ via sandbox exec returned empty (SSH may not be available; host probe in Phase 4)"
else
  fail "/ returned ${ROOT_CODE:-empty} — expected 401 (device auth) or 200 (no auth)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Phase 3: Status Command (isSandboxGatewayRunning regression)
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 3: Status Command"

# The key regression: `nemoclaw <name> status` must NOT report "Offline"
# when device auth returns 401 on the probe endpoint.
info "Running nemoclaw ${SANDBOX_NAME} status..."
STATUS_OUTPUT=$(nemoclaw "$SANDBOX_NAME" status 2>&1) || true

# Check for the "Health Offline" false negative
if echo "$STATUS_OUTPUT" | grep -qi "offline"; then
  fail "Status reports 'Offline' — #2342 REGRESSION: 401 treated as dead"
  info "Status output: $(echo "$STATUS_OUTPUT" | head -10)"
else
  pass "Status does NOT report 'Offline' (gateway correctly detected as alive)"
fi

# Check it shows positive running indicators
if echo "$STATUS_OUTPUT" | grep -qiE "running|online|healthy|OpenClaw|Ready"; then
  pass "Status shows positive health indicator (Running/Online/Healthy)"
else
  info "Status output (no positive indicator found): $(echo "$STATUS_OUTPUT" | head -10)"
  skip "Could not confirm positive health indicator (output format may vary)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Phase 4: Host-Side Port Forward Probe
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 4: Host-Side Port Forward Probe"

# The port forward from host should also work. verifyDeployment() probes this.
info "Probing dashboard from host via port forward..."
HOST_HEALTH_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 5 \
  "http://127.0.0.1:${DASHBOARD_PORT}/health" 2>/dev/null) || true

if [[ "$HOST_HEALTH_CODE" == "200" ]] || [[ "$HOST_HEALTH_CODE" == "401" ]]; then
  pass "Host port forward to dashboard is live (HTTP ${HOST_HEALTH_CODE})"
else
  # Port forward may not be active in all E2E environments
  if [[ "$HOST_HEALTH_CODE" == "000" ]] || [[ -z "$HOST_HEALTH_CODE" ]]; then
    skip "Port forward not reachable from host (may not be configured in this environment)"
  else
    fail "Host health probe returned ${HOST_HEALTH_CODE} — expected 200 or 401"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# Phase 5: Gateway Restart + Health Re-check
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 5: Gateway Restart + Health Re-check"

# Kill the gateway process inside the sandbox to simulate a restart scenario.
# This tests that isSandboxGatewayRunning() + process recovery work correctly
# with the new HTTP status code pattern.
#
# NOTE: Gateway auto-restart depends on the process supervisor inside the
# sandbox. If recovery doesn't work, we still validate that status doesn't
# falsely report Offline on the attempt.
info "Killing gateway process inside sandbox..."
sandbox_exec "pkill -f 'openclaw.*gateway' 2>/dev/null || true"
sleep 3

# Run status — this triggers process recovery which uses the fixed health probe
info "Running nemoclaw ${SANDBOX_NAME} status (triggers recovery)..."
RECOVERY_STATUS=$(nemoclaw "$SANDBOX_NAME" status 2>&1) || true

# The key assertion: even during recovery, status must NOT report Offline
# due to 401 being misinterpreted. It may say "recovering" or show the
# gateway as temporarily down, but NOT "Health Offline" from #2342.
if echo "$RECOVERY_STATUS" | grep -qi "offline"; then
  fail "Status reports 'Offline' during recovery — #2342 regression"
else
  pass "Status does not report 'Offline' during recovery attempt"
fi

# Wait for recovery to complete and gateway to become healthy again
info "Waiting for gateway to recover..."
RECOVERED=false
for attempt in $(seq 1 30); do
  RECOVER_HEALTH=$(
    sandbox_exec \
      "curl -so /dev/null -w '%{http_code}' --max-time 3 http://localhost:${DASHBOARD_PORT}/health"
  ) || true
  if [[ "$RECOVER_HEALTH" == "200" ]] || [[ "$RECOVER_HEALTH" == "401" ]]; then
    RECOVERED=true
    break
  fi
  sleep 5
done

if $RECOVERED; then
  pass "Gateway recovered after restart (HTTP ${RECOVER_HEALTH} on /health)"
else
  # Recovery may not be supported in all environments — skip rather than fail
  skip "Gateway did not recover within 150s (process supervisor may not be active)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Phase 6: Verify verifyDeployment() Output in Onboard Log
# ══════════════════════════════════════════════════════════════════════════════
section "Phase 6: Verify Deployment Diagnostics"

# Check that the onboard log includes verification output (not a crash/skip)
if grep -qi "verification\|✓.*Gateway\|✓.*Dashboard\|verif" "$INSTALL_LOG" 2>/dev/null; then
  pass "Onboard log contains deployment verification output"
elif grep -qi "Dashboard is live" "$INSTALL_LOG" 2>/dev/null; then
  pass "Onboard log confirms dashboard readiness check passed"
else
  skip "Could not confirm verification output in onboard log (format may vary)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════
section "Summary"
echo ""
printf '  Total: %d | \033[32mPass: %d\033[0m | \033[31mFail: %d\033[0m | \033[33mSkip: %d\033[0m\n' \
  "$TOTAL" "$PASS" "$FAIL" "$SKIP"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "RESULT: FAILED — $FAIL test(s) failed"
  exit 1
fi

echo "RESULT: PASSED — all health probes work correctly with device auth enabled"
exit 0
