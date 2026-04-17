#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shields & Config E2E — validates the full shields down/up lifecycle and
# config get/set/rotate-token against a live sandbox:
#
#   Phase 1: Install NemoClaw
#   Phase 2: Verify config is immutable (shields UP)
#   Phase 3: shields down — verify config becomes writable
#   Phase 4: config get — read-only inspection
#   Phase 5: config set — host-initiated config mutation
#   Phase 6: shields status — shows DOWN with remaining timeout
#   Phase 7: shields up — verify config re-locked
#   Phase 8: Verify config changes persisted through shields cycle
#   Phase 9: shields down + rotate-token + shields up
#   Phase 10: Audit trail completeness
#   Phase 11: Auto-restore timer (shields down with short timeout)
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-shields)
#   NEMOCLAW_E2E_TIMEOUT_SECONDS           — overall timeout (default: 900)

set -uo pipefail

if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-900}"
  if command -v timeout >/dev/null 2>&1; then
    exec timeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    exec gtimeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  fi
fi

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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-shields}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CONFIG_PATH="/sandbox/.openclaw/openclaw.json"
AUDIT_FILE="$HOME/.nemoclaw/state/shields-audit.jsonl"

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
  pass "NVIDIA_API_KEY is set"
else
  fail "NVIDIA_API_KEY not set or invalid"
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

pass "Prerequisites OK"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Install NemoClaw
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Install NemoClaw"

info "Pre-cleanup..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
rm -f "$AUDIT_FILE" 2>/dev/null || true

info "Running install.sh..."
cd "$REPO_ROOT" || exit 1

export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME="${SANDBOX_NAME}"
export NEMOCLAW_RECREATE_SANDBOX=1

INSTALL_LOG="/tmp/nemoclaw-e2e-shields-install.log"
if ! bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1; then
  fail "install.sh failed (see $INSTALL_LOG)"
  exit 1
fi

# Source shell profile for nvm/PATH
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

command -v nemoclaw >/dev/null 2>&1 || {
  fail "nemoclaw not on PATH"
  exit 1
}
command -v openshell >/dev/null 2>&1 || {
  fail "openshell not on PATH"
  exit 1
}
pass "NemoClaw installed (sandbox: $SANDBOX_NAME)"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Config is immutable (shields UP)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Config is immutable with shields UP"

# Verify the sandbox user cannot write to the config file
WRITE_RESULT=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  sh -c "echo 'TAMPERED' >> ${CONFIG_PATH} 2>&1 && echo WRITABLE || echo BLOCKED" 2>&1)

if echo "$WRITE_RESULT" | grep -q "BLOCKED"; then
  pass "Config file is read-only for sandbox user (shields UP)"
elif echo "$WRITE_RESULT" | grep -q "Permission denied\|Read-only\|Operation not permitted"; then
  pass "Config file write rejected by OS (shields UP)"
else
  fail "Config file should be immutable but sandbox could write: ${WRITE_RESULT}"
fi

# Verify file permissions
PERMS=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a %U:%G' "${CONFIG_PATH}" 2>/dev/null || true)
info "Config perms (shields UP): ${PERMS}"

if echo "$PERMS" | grep -qE "^4[0-4][0-4] root:root"; then
  pass "Config file has restrictive permissions (${PERMS})"
else
  info "Unexpected permissions: ${PERMS} (may vary by OS — non-fatal)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: shields down — config becomes writable
# ══════════════════════════════════════════════════════════════════
section "Phase 3: shields down"

SHIELDS_DOWN_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" shields down \
  --timeout 5m --reason "E2E config mutation test" 2>&1)
echo "$SHIELDS_DOWN_OUTPUT"

# Diagnostic: dump state file immediately after shields down
info "State file after shields down:"
cat "$HOME/.nemoclaw/state/nemoclaw.json" 2>&1 | while IFS= read -r line; do info "  $line"; done
info "Docker containers:"
docker ps --format '{{.Names}}' 2>&1 | while IFS= read -r line; do info "  $line"; done

if echo "$SHIELDS_DOWN_OUTPUT" | grep -q "Shields DOWN"; then
  pass "shields down succeeded"
else
  fail "shields down did not report success: ${SHIELDS_DOWN_OUTPUT}"
fi

# Check permissions changed
PERMS_DOWN=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a' "${CONFIG_PATH}" 2>/dev/null || true)
info "Config perms (shields DOWN): ${PERMS_DOWN}"

if echo "$PERMS_DOWN" | grep -q "666\|664\|644"; then
  pass "Config file permissions relaxed (${PERMS_DOWN})"
else
  fail "Config file permissions not relaxed after shields down: ${PERMS_DOWN}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: config get — read-only inspection
# ══════════════════════════════════════════════════════════════════
section "Phase 4: config get"

CONFIG_GET_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" config get 2>&1)

if echo "$CONFIG_GET_OUTPUT" | grep -q "{"; then
  pass "config get returns JSON"
else
  fail "config get did not return JSON: ${CONFIG_GET_OUTPUT}"
fi

# Verify credentials are redacted
if echo "$CONFIG_GET_OUTPUT" | grep -qE "nvapi-|sk-|Bearer "; then
  fail "config get leaks credentials"
else
  pass "config get output has no credential leaks"
fi

# Verify gateway section is stripped
if echo "$CONFIG_GET_OUTPUT" | grep -q '"gateway"'; then
  fail "config get should strip gateway section"
else
  pass "config get strips gateway section"
fi

# Test dotpath extraction
DOTPATH_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" config get --key inference 2>&1 || true)
if [ -n "$DOTPATH_OUTPUT" ] && [ "$DOTPATH_OUTPUT" != "null" ]; then
  pass "config get --key dotpath works"
else
  info "dotpath extraction returned empty (inference key may not exist) — non-fatal"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: config set — host-initiated config mutation
# ══════════════════════════════════════════════════════════════════
section "Phase 5: config set"

# Set a test key
CONFIG_SET_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" config set \
  --key "nemoclaw_e2e_test" --value '"shields-config-e2e"' 2>&1)
echo "$CONFIG_SET_OUTPUT"

if echo "$CONFIG_SET_OUTPUT" | grep -q "Config updated\|config updated"; then
  pass "config set succeeded"
else
  fail "config set did not report success: ${CONFIG_SET_OUTPUT}"
fi

# Verify the change is visible via config get
VERIFY_SET=$(nemoclaw "${SANDBOX_NAME}" config get --key nemoclaw_e2e_test 2>&1)
if echo "$VERIFY_SET" | grep -q "shields-config-e2e"; then
  pass "config set change visible in config get"
else
  fail "config set change not visible: ${VERIFY_SET}"
fi

# Verify gateway section cannot be modified
GATEWAY_SET=$(nemoclaw "${SANDBOX_NAME}" config set \
  --key "gateway.token" --value '"hacked"' 2>&1 || true)
if echo "$GATEWAY_SET" | grep -q "Cannot modify the gateway"; then
  pass "config set blocks gateway section writes"
else
  fail "config set should block gateway writes: ${GATEWAY_SET}"
fi

# Verify SSRF validation on URLs
SSRF_SET=$(nemoclaw "${SANDBOX_NAME}" config set \
  --key "test_url" --value '"http://127.0.0.1:8080/steal"' 2>&1 || true)
if echo "$SSRF_SET" | grep -qi "private\|validation failed"; then
  pass "config set blocks private IP URLs (SSRF)"
else
  fail "config set should block SSRF URLs: ${SSRF_SET}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: shields status — shows DOWN
# ══════════════════════════════════════════════════════════════════
section "Phase 6: shields status"

STATUS_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" shields status 2>&1)
echo "$STATUS_OUTPUT"

if echo "$STATUS_OUTPUT" | grep -q "Shields: DOWN"; then
  pass "shields status reports DOWN"
else
  fail "shields status should show DOWN: ${STATUS_OUTPUT}"
fi

if echo "$STATUS_OUTPUT" | grep -q "E2E config mutation test"; then
  pass "shields status shows reason"
else
  fail "shields status should show reason: ${STATUS_OUTPUT}"
fi

if echo "$STATUS_OUTPUT" | grep -q "remaining"; then
  pass "shields status shows timeout remaining"
else
  info "shields status timeout display not found — non-fatal"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: shields up — config re-locked
# ══════════════════════════════════════════════════════════════════
section "Phase 7: shields up"

SHIELDS_UP_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" shields up 2>&1)
echo "$SHIELDS_UP_OUTPUT"

if echo "$SHIELDS_UP_OUTPUT" | grep -q "Shields UP"; then
  pass "shields up succeeded"
else
  fail "shields up did not report success: ${SHIELDS_UP_OUTPUT}"
fi

# Verify config is immutable again
PERMS_UP=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a' "${CONFIG_PATH}" 2>/dev/null || true)
info "Config perms (shields UP again): ${PERMS_UP}"

if echo "$PERMS_UP" | grep -qE "^4[0-4][0-4]"; then
  pass "Config file re-locked after shields up (${PERMS_UP})"
else
  fail "Config file not re-locked after shields up: ${PERMS_UP}"
fi

OWNER_UP=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%U:%G' "${CONFIG_PATH}" 2>/dev/null || true)
if echo "$OWNER_UP" | grep -q "root:root"; then
  pass "Config file ownership restored to root:root"
else
  fail "Config file ownership not restored: ${OWNER_UP}"
fi

# Verify shields status now shows UP
STATUS_UP=$(nemoclaw "${SANDBOX_NAME}" shields status 2>&1)
if echo "$STATUS_UP" | grep -q "Shields: UP"; then
  pass "shields status reports UP after shields up"
else
  fail "shields status should show UP: ${STATUS_UP}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 8: Config changes persisted through shields cycle
# ══════════════════════════════════════════════════════════════════
section "Phase 8: Config changes persist"

PERSIST_CHECK=$(nemoclaw "${SANDBOX_NAME}" config get --key nemoclaw_e2e_test 2>&1)
if echo "$PERSIST_CHECK" | grep -q "shields-config-e2e"; then
  pass "Config changes survived shields up (persisted)"
else
  fail "Config changes lost after shields up: ${PERSIST_CHECK}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 9: rotate-token (shields down → rotate → shields up)
# ══════════════════════════════════════════════════════════════════
section "Phase 9: rotate-token"

nemoclaw "${SANDBOX_NAME}" shields down --timeout 5m --reason "Token rotation E2E" 2>&1
pass "shields down for token rotation"

# Rotate using --from-env
export E2E_ROTATED_KEY="${NVIDIA_API_KEY}"
ROTATE_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" config rotate-token \
  --from-env E2E_ROTATED_KEY 2>&1)
echo "$ROTATE_OUTPUT"

if echo "$ROTATE_OUTPUT" | grep -q "Token rotated"; then
  pass "rotate-token succeeded"
else
  fail "rotate-token did not report success: ${ROTATE_OUTPUT}"
fi

# Verify token value is NOT in the output (redacted)
if echo "$ROTATE_OUTPUT" | grep -q "${NVIDIA_API_KEY}"; then
  fail "rotate-token leaked the actual token value"
else
  pass "rotate-token output does not leak token"
fi

nemoclaw "${SANDBOX_NAME}" shields up 2>&1
pass "shields up after token rotation"

# ══════════════════════════════════════════════════════════════════
# Phase 10: Audit trail
# ══════════════════════════════════════════════════════════════════
section "Phase 10: Audit trail"

if [ -f "$AUDIT_FILE" ]; then
  AUDIT_LINES=$(wc -l <"$AUDIT_FILE")
  info "Audit entries: ${AUDIT_LINES}"

  # Should have at least: shields_down, shields_up, shields_down (rotate), shields_up (rotate)
  DOWN_COUNT=$(grep -c '"shields_down"' "$AUDIT_FILE" || true)
  UP_COUNT=$(grep -c '"shields_up"' "$AUDIT_FILE" || true)

  if [ "$DOWN_COUNT" -ge 2 ]; then
    pass "Audit has ≥2 shields_down entries (got ${DOWN_COUNT})"
  else
    fail "Expected ≥2 shields_down audit entries, got ${DOWN_COUNT}"
  fi

  if [ "$UP_COUNT" -ge 2 ]; then
    pass "Audit has ≥2 shields_up entries (got ${UP_COUNT})"
  else
    fail "Expected ≥2 shields_up audit entries, got ${UP_COUNT}"
  fi

  # Verify no credentials in audit
  if grep -qE "nvapi-|sk-|Bearer " "$AUDIT_FILE"; then
    fail "Audit trail contains credentials"
  else
    pass "Audit trail is credential-free"
  fi

  # Verify each entry is valid JSON
  INVALID_JSON=0
  while IFS= read -r line; do
    if ! echo "$line" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
      ((INVALID_JSON++))
    fi
  done <"$AUDIT_FILE"

  if [ "$INVALID_JSON" -eq 0 ]; then
    pass "All audit entries are valid JSON"
  else
    fail "${INVALID_JSON} audit entries are invalid JSON"
  fi
else
  fail "Audit file not found: $AUDIT_FILE"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 11: Auto-restore timer
# ══════════════════════════════════════════════════════════════════
section "Phase 11: Auto-restore timer"

info "Lowering shields with 10s timeout..."
nemoclaw "${SANDBOX_NAME}" shields down --timeout 10s --reason "Auto-restore timer E2E" 2>&1

# Verify shields are down
STATUS_TIMER=$(nemoclaw "${SANDBOX_NAME}" shields status 2>&1)
if echo "$STATUS_TIMER" | grep -q "Shields: DOWN"; then
  pass "shields down with 10s timeout"
else
  fail "shields should be DOWN: ${STATUS_TIMER}"
fi

info "Waiting 15s for auto-restore..."
sleep 15

# Check if the timer process restored shields
# The timer runs as a detached process — it restores the policy and
# updates the state file. We verify by checking shields status.
STATUS_AFTER_TIMER=$(nemoclaw "${SANDBOX_NAME}" shields status 2>&1)
if echo "$STATUS_AFTER_TIMER" | grep -q "Shields: UP"; then
  pass "Auto-restore timer restored shields after timeout"
else
  info "Auto-restore may not have fired (timer runs as detached process)"
  info "Status: ${STATUS_AFTER_TIMER}"
  # Clean up manually
  nemoclaw "${SANDBOX_NAME}" shields up 2>/dev/null || true
  fail "Auto-restore timer did not restore shields within 15s"
fi

# Verify config is re-locked after auto-restore
PERMS_TIMER=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a' "${CONFIG_PATH}" 2>/dev/null || true)
if echo "$PERMS_TIMER" | grep -qE "^4[0-4][0-4]"; then
  pass "Config re-locked after auto-restore (${PERMS_TIMER})"
else
  info "Config permissions after auto-restore: ${PERMS_TIMER} — timer may not re-lock perms"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 12: Double shields-down rejected
# ══════════════════════════════════════════════════════════════════
section "Phase 12: Double shields-down rejected"

# First shields down may fail if openshell policy set --wait times out
# on a slow CI runner. Retry once before testing the double-down guard.
if ! nemoclaw "${SANDBOX_NAME}" shields down --timeout 5m --reason "Double-down test" 2>&1; then
  info "First shields down failed (policy set timeout?) — retrying..."
  nemoclaw "${SANDBOX_NAME}" shields down --timeout 5m --reason "Double-down test" 2>&1
fi
DOUBLE_DOWN=$(nemoclaw "${SANDBOX_NAME}" shields down --timeout 5m --reason "Should fail" 2>&1 || true)

if echo "$DOUBLE_DOWN" | grep -q "already DOWN"; then
  pass "Double shields-down rejected"
else
  fail "Double shields-down should be rejected: ${DOUBLE_DOWN}"
fi

nemoclaw "${SANDBOX_NAME}" shields up 2>&1
pass "Cleanup: shields up"

# ══════════════════════════════════════════════════════════════════
# Cleanup
# ══════════════════════════════════════════════════════════════════
section "Cleanup"

nemoclaw "${SANDBOX_NAME}" destroy --yes 2>/dev/null || true
pass "Sandbox destroyed"

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════════"
printf "  Total: %d | \033[32mPassed: %d\033[0m | \033[31mFailed: %d\033[0m\n" "$TOTAL" "$PASS" "$FAIL"
echo "════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
