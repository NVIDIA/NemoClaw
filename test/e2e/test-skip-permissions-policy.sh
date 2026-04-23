#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# E2E: --dangerously-skip-permissions policy activation
#
# Validates the exact scenario from the bug report:
#   1. Onboard with --dangerously-skip-permissions (via env var)
#   2. Verify policy is Active (not stuck in Pending)
#   3. Verify outbound HTTPS from inside the sandbox succeeds (not 403)
#   4. Verify the permissive policy contains access: full endpoints
#
# Without the fix, the permissive base policy from sandbox creation stays
# in Pending status because no `openshell policy set --wait` is called.
# All outbound requests return 403 Forbidden.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required for NVIDIA Endpoints inference
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-skip-perms)
#   NEMOCLAW_E2E_TIMEOUT_SECONDS           — overall timeout (default: 900)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 \
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#   NVIDIA_API_KEY=nvapi-... \
#     bash test/e2e/test-skip-permissions-policy.sh

set -uo pipefail

TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
fi

if [ "${NEMOCLAW_E2E_NO_TIMEOUT:-0}" != "1" ] && [ "${NEMOCLAW_E2E_TIMEOUT_WRAPPED:-0}" != "1" ]; then
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-900}"
  if [ -n "$TIMEOUT_CMD" ]; then
    export NEMOCLAW_E2E_TIMEOUT_WRAPPED=1
    exec "$TIMEOUT_CMD" -s TERM "$TIMEOUT_SECONDS" "$0" "$@"
  else
    echo "ERROR: 'timeout' not found. Install coreutils (macOS: 'brew install coreutils')" >&2
    echo "       or bypass with NEMOCLAW_E2E_NO_TIMEOUT=1" >&2
    exit 127
  fi
fi

# Run with $TIMEOUT_CMD if set; run directly if empty (NEMOCLAW_E2E_NO_TIMEOUT bypass).
# Avoids `$TIMEOUT_CMD 60 ssh …` becoming `60 ssh …` → "60: command not found".
# Usage: run_with_timeout <seconds> <command> [args...]
# shellcheck disable=SC2329
run_with_timeout() {
  local seconds="$1"
  shift
  if [ "${NEMOCLAW_E2E_NO_TIMEOUT:-0}" != "1" ] && [ -n "$TIMEOUT_CMD" ]; then
    "$TIMEOUT_CMD" "$seconds" "$@"
  else
    "$@"
  fi
}

PASS=0
FAIL=0
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
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-skip-perms}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set (starts with nvapi-)"
else
  fail "NVIDIA_API_KEY not set or invalid — required for NVIDIA Endpoints inference"
  exit 1
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  exit 1
fi

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  exit 1
fi

if [ ! -f "$REPO_ROOT/install.sh" ]; then
  fail "Cannot find install.sh at $REPO_ROOT/install.sh"
  exit 1
fi
pass "Repo root found: $REPO_ROOT"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Pre-cleanup"

info "Destroying any leftover sandbox/gateway from previous runs..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Install with --dangerously-skip-permissions
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Install NemoClaw with --dangerously-skip-permissions"

info "Running install.sh --non-interactive with NEMOCLAW_DANGEROUSLY_SKIP_PERMISSIONS=1..."
info "This is the exact flag that caused the Pending policy bug."

cd "$REPO_ROOT" || {
  fail "Could not cd to repo root: $REPO_ROOT"
  exit 1
}

INSTALL_LOG="${NEMOCLAW_E2E_INSTALL_LOG:-/tmp/nemoclaw-e2e-install.log}"
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_DANGEROUSLY_SKIP_PERMISSIONS=1 \
  bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true
# Keep install log for CI artifact upload on failure

# Source shell profile to pick up nvm/PATH changes from install.sh
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ $install_exit -eq 0 ]; then
  pass "install.sh completed (exit 0)"
else
  fail "install.sh failed (exit $install_exit)"
  exit 1
fi

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH: $(command -v nemoclaw)"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell on PATH"
else
  fail "openshell not found on PATH after install"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Verify policy is Active (THE bug report's core check)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Verify policy activation (the bug report)"

# 3a: openshell policy list — must NOT show "Pending" as the latest version
info "Checking openshell policy list..."
policy_list=$(openshell policy list "$SANDBOX_NAME" 2>&1) || true
info "Policy list output:"
echo "$policy_list" | while IFS= read -r line; do info "  $line"; done

# The latest (highest) policy version must not be Pending.
# Policy list is sorted descending — first data row is the effective version.
latest_status=$(echo "$policy_list" | grep -E '^\s*[0-9]' | head -1 | awk '{print $3}')
if [ "$latest_status" = "Pending" ]; then
  fail "Latest policy version is Pending — the bug is NOT fixed"
  info "This is the exact symptom from the bug report: policy never activates"
elif [ "$latest_status" = "Loaded" ]; then
  pass "Latest policy version is Loaded (active)"
else
  pass "Latest policy version status: $latest_status (not Pending)"
fi

# 3b: openshell policy get --full — must contain network_policies with access: full
info "Checking openshell policy get --full..."
policy_full=$(openshell policy get --full "$SANDBOX_NAME" 2>&1) || true
if echo "$policy_full" | grep -qi "network_policies"; then
  pass "Policy contains network_policies section"
else
  fail "Policy missing network_policies section"
fi

if echo "$policy_full" | grep -qi "access: full"; then
  pass "Policy contains 'access: full' endpoints (permissive mode active)"
else
  fail "Policy does not contain 'access: full' — permissive policy was not applied"
fi

# 3c: nemoclaw status must show dangerously-skip-permissions
if status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1); then
  if echo "$status_output" | grep -qi "dangerously-skip-permissions"; then
    pass "nemoclaw status shows dangerously-skip-permissions mode"
  else
    fail "nemoclaw status does not indicate dangerously-skip-permissions mode"
  fi
else
  fail "nemoclaw status failed: ${status_output:0:200}"
fi

# 3d: shields status must show DOWN (permanent)
info "Checking shields status..."
shields_output=$(nemoclaw "$SANDBOX_NAME" shields status 2>&1)
echo "$shields_output" | while IFS= read -r line; do info "  $line"; done

if echo "$shields_output" | grep -q "Shields: DOWN"; then
  pass "shields status reports DOWN"
else
  fail "shields status should show DOWN when --dangerously-skip-permissions is active"
fi

if echo "$shields_output" | grep -qi "permanent"; then
  pass "shields status shows permanent mode"
else
  fail "shields status should show permanent mode"
fi

# 3e: Config file permissions must be sandbox:sandbox 0600 (doctor-aligned)
info "Checking config file permissions inside sandbox..."
PERMS_OUTPUT=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a %U:%G' /sandbox/.openclaw/openclaw.json 2>/dev/null || true)
info "Config perms: ${PERMS_OUTPUT}"

if [ "$(echo "$PERMS_OUTPUT" | awk '{print $1}')" = "600" ]; then
  pass "Config file mode is 600 (matches openclaw doctor expectations)"
else
  fail "Config file mode should be 600 (got: ${PERMS_OUTPUT})"
fi

if [ "$(echo "$PERMS_OUTPUT" | awk '{print $2}')" = "sandbox:sandbox" ]; then
  pass "Config file owned by sandbox:sandbox"
else
  fail "Config file should be owned by sandbox:sandbox (got: ${PERMS_OUTPUT})"
fi

# 3f: Config directory permissions must be sandbox:sandbox 0700
DIR_PERMS=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a %U:%G' /sandbox/.openclaw 2>/dev/null || true)
info "Config dir perms: ${DIR_PERMS}"

if [ "$(echo "$DIR_PERMS" | awk '{print $1}')" = "700" ]; then
  pass "Config directory mode is 700"
else
  fail "Config directory mode should be 700 (got: ${DIR_PERMS})"
fi

if [ "$(echo "$DIR_PERMS" | awk '{print $2}')" = "sandbox:sandbox" ]; then
  pass "Config directory owned by sandbox:sandbox"
else
  fail "Config directory should be owned by sandbox:sandbox (got: ${DIR_PERMS})"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Verify outbound HTTPS from inside sandbox
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Verify sandbox egress"

# All sandbox traffic routes through the OpenShell proxy (HTTPS_PROXY).
# When the policy is Pending (the bug), the proxy rejects everything
# with 403 Forbidden. When Active, it allows CONNECT tunnels for
# `access: full` endpoints.
#
# Uses `openshell sandbox exec` — the same command the bug reporter used.

# 4a: npm ping — application-level proof that egress works through the proxy
info "[EGRESS] Testing npm ping from inside sandbox..."
if npm_result=$(openshell sandbox exec -n "$SANDBOX_NAME" -- \
  npm ping --silent 2>&1); then
  pass "[EGRESS] npm ping succeeded (registry.npmjs.org reachable through proxy)"
elif echo "$npm_result" | grep -qi "403\|BLOCKED\|ECONNREFUSED"; then
  fail "[EGRESS] npm ping failed — proxy rejected traffic: ${npm_result:0:200}"
else
  info "npm ping failed: ${npm_result:0:200}"
  fail "[EGRESS] npm ping failed"
fi

# 4b: curl api.github.com — bug reporter's exact repro command
# api.github.com can return 403 for unauthenticated rate limiting, so
# treat any non-000 response (including 403) as proof that egress works.
# Code 000 means curl could not connect at all (policy/proxy blocking).
info "[EGRESS] Testing curl https://api.github.com/ via openshell sandbox exec..."
egress_response=$(openshell sandbox exec -n "$SANDBOX_NAME" -- \
  curl -s --connect-timeout 15 -o /dev/null -w '%{http_code}' \
  https://api.github.com/ 2>&1) || true

egress_code=$(echo "$egress_response" | tr -d '\r' | tail -1)
if echo "$egress_code" | grep -qE '^[2-5][0-9][0-9]$'; then
  pass "[EGRESS] curl https://api.github.com/ returned HTTP $egress_code (egress works)"
elif [ "$egress_code" = "000" ]; then
  fail "[EGRESS] curl https://api.github.com/ could not connect (code 000 — policy/proxy blocked)"
else
  info "curl returned code '$egress_code': ${egress_response:0:500}"
  fail "[EGRESS] curl https://api.github.com/ failed (code $egress_code)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Cleanup"

[[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

registry_file="${HOME}/.nemoclaw/sandboxes.json"
if [ -f "$registry_file" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$registry_file"; then
  fail "Sandbox ${SANDBOX_NAME} still in registry after destroy"
else
  pass "Sandbox ${SANDBOX_NAME} cleaned up"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Skip-Permissions Policy E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo ""
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Skip-permissions policy PASSED — policy activates and sandbox egress works.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
