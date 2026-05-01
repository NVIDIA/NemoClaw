#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shields & Config E2E — validates the full shields up/down lifecycle and
# config get against a live sandbox:
#
#   Phase 1: Install NemoClaw
#   Phase 2: Verify config is writable (mutable default)
#   Phase 3: shields up — verify config becomes immutable
#   Phase 4: config get — read-only inspection
#   Phase 5: shields status — shows UP
#   Phase 6: shields down — verify config returns to writable
#   Phase 7: shields status — shows DOWN
#   Phase 8: Audit trail completeness
#   Phase 9: Auto-restore timer (shields up with short timeout)
#   Phase 10: Double shields-up rejected
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

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=900
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

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

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

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
# Phase 2: Config is writable (mutable default)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Config is writable (mutable default)"

# Verify file permissions — should start as 600 sandbox:sandbox
PERMS=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a %U:%G' "${CONFIG_PATH}" 2>/dev/null || true)
info "Config perms (default): ${PERMS}"

if [ "$(echo "$PERMS" | awk '{print $1}')" = "600" ]; then
  pass "Config file mode is 600 (mutable default)"
else
  fail "Config file should start as mode 600: ${PERMS}"
fi

if [ "$(echo "$PERMS" | awk '{print $2}')" = "sandbox:sandbox" ]; then
  pass "Config file owned by sandbox:sandbox (mutable default)"
else
  fail "Config file should be owned by sandbox:sandbox: ${PERMS}"
fi

DIR_PERMS=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a %U:%G' "$(dirname "${CONFIG_PATH}")" 2>/dev/null || true)
info "Config dir perms (default): ${DIR_PERMS}"

if [ "$(echo "$DIR_PERMS" | awk '{print $1}')" = "700" ]; then
  pass "Config directory mode is 700 (mutable default)"
else
  fail "Config directory should be mode 700: ${DIR_PERMS}"
fi

STATUS_DEFAULT=$(nemoclaw "${SANDBOX_NAME}" shields status 2>&1)
echo "$STATUS_DEFAULT"
if echo "$STATUS_DEFAULT" | grep -q "Shields: NOT CONFIGURED"; then
  pass "Fresh sandbox status reports default mutable state"
else
  fail "Fresh sandbox status should report NOT CONFIGURED mutable default: ${STATUS_DEFAULT}"
fi

# OpenShell rejects command arguments containing newlines, so keep the probe
# as a single shell argument.
# shellcheck disable=SC2016  # expanded inside the sandbox by sh -c
LAYOUT_PROBE='bad=0; if [ -e /sandbox/.openclaw-data ] || [ -L /sandbox/.openclaw-data ]; then echo "legacy data dir exists: /sandbox/.openclaw-data"; bad=1; fi; for entry in /sandbox/.openclaw/*; do [ -L "$entry" ] || continue; target="$(readlink -f "$entry" 2>/dev/null || readlink "$entry" 2>/dev/null || true)"; case "$target" in /sandbox/.openclaw-data/*) echo "legacy symlink remains: $entry -> $target"; bad=1 ;; esac; done; exit "$bad"'
LAYOUT_CHECK=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- sh -c "$LAYOUT_PROBE" 2>&1)
if [ -z "$LAYOUT_CHECK" ]; then
  pass "Unified .openclaw layout has no .openclaw-data mirror or symlink bridge"
else
  fail "Legacy .openclaw-data layout should not exist: ${LAYOUT_CHECK}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: shields up — config becomes immutable
# ══════════════════════════════════════════════════════════════════
section "Phase 3: shields up"

SHIELDS_UP_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" shields up 2>&1)
echo "$SHIELDS_UP_OUTPUT"

if echo "$SHIELDS_UP_OUTPUT" | grep -q "Lockdown active"; then
  pass "shields up succeeded"
else
  fail "shields up did not report success: ${SHIELDS_UP_OUTPUT}"
fi

# Verify config is now immutable
PERMS_UP=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a %U:%G' "${CONFIG_PATH}" 2>/dev/null || true)
info "Config perms (shields UP): ${PERMS_UP}"

if echo "$PERMS_UP" | grep -qE "^4[0-4][0-4]"; then
  pass "Config file has restrictive permissions after shields up (${PERMS_UP})"
else
  fail "Config file should be locked after shields up: ${PERMS_UP}"
fi

OWNER_UP=$(echo "$PERMS_UP" | awk '{print $2}')
if echo "$OWNER_UP" | grep -q "root:root"; then
  pass "Config file ownership changed to root:root"
else
  fail "Config file ownership not changed to root:root: ${OWNER_UP}"
fi

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

WORKSPACE_WRITE_RESULT=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  sh -c "touch /sandbox/.openclaw/workspace/.shields-up-probe 2>&1 && echo WRITABLE || echo BLOCKED" 2>&1)

if echo "$WORKSPACE_WRITE_RESULT" | grep -q "BLOCKED"; then
  pass "Workspace state is read-only for sandbox user (shields UP)"
elif echo "$WORKSPACE_WRITE_RESULT" | grep -q "Permission denied\|Read-only\|Operation not permitted"; then
  pass "Workspace write rejected by OS (shields UP)"
else
  fail "Workspace should be locked after shields up: ${WORKSPACE_WRITE_RESULT}"
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
# Phase 5: shields status — shows UP
# ══════════════════════════════════════════════════════════════════
section "Phase 5: shields status"

STATUS_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" shields status 2>&1)
echo "$STATUS_OUTPUT"

if echo "$STATUS_OUTPUT" | grep -q "Shields: UP"; then
  pass "shields status reports UP"
else
  fail "shields status should show UP: ${STATUS_OUTPUT}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: shields down — config returns to writable
# ══════════════════════════════════════════════════════════════════
section "Phase 6: shields down"

SHIELDS_DOWN_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" shields down \
  --timeout 5m --reason "E2E shields lifecycle test" 2>&1)
echo "$SHIELDS_DOWN_OUTPUT"

if echo "$SHIELDS_DOWN_OUTPUT" | grep -q "Config unlocked"; then
  pass "shields down succeeded"
else
  fail "shields down did not report success: ${SHIELDS_DOWN_OUTPUT}"
fi

# Check permissions changed — should be sandbox:sandbox 600/700 (doctor-aligned)
PERMS_DOWN=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a %U:%G' "${CONFIG_PATH}" 2>/dev/null || true)
info "Config perms (shields DOWN): ${PERMS_DOWN}"

if [ "$(echo "$PERMS_DOWN" | awk '{print $1}')" = "600" ]; then
  pass "Config file mode is 600 (restored to mutable default)"
else
  fail "Config file should be mode 600 after shields down: ${PERMS_DOWN}"
fi

if [ "$(echo "$PERMS_DOWN" | awk '{print $2}')" = "sandbox:sandbox" ]; then
  pass "Config file owned by sandbox:sandbox after shields down"
else
  fail "Config file should be owned by sandbox:sandbox: ${PERMS_DOWN}"
fi

DIR_PERMS_DOWN=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a %U:%G' "$(dirname "${CONFIG_PATH}")" 2>/dev/null || true)
info "Config dir perms (shields DOWN): ${DIR_PERMS_DOWN}"

if [ "$(echo "$DIR_PERMS_DOWN" | awk '{print $1}')" = "700" ]; then
  pass "Config directory mode is 700 (restored to mutable default)"
else
  fail "Config directory should be mode 700 after shields down: ${DIR_PERMS_DOWN}"
fi

if [ "$(echo "$DIR_PERMS_DOWN" | awk '{print $2}')" = "sandbox:sandbox" ]; then
  pass "Config directory owned by sandbox:sandbox after shields down"
else
  fail "Config directory should be owned by sandbox:sandbox: ${DIR_PERMS_DOWN}"
fi

WORKSPACE_DOWN_RESULT=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  sh -c "touch /sandbox/.openclaw/workspace/.shields-down-probe 2>&1 && rm -f /sandbox/.openclaw/workspace/.shields-down-probe && echo WRITABLE || echo BLOCKED" 2>&1)
if echo "$WORKSPACE_DOWN_RESULT" | grep -q "WRITABLE"; then
  pass "Workspace state is writable again after shields down"
else
  fail "Workspace should be writable after shields down: ${WORKSPACE_DOWN_RESULT}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: shields status — shows DOWN
# ══════════════════════════════════════════════════════════════════
section "Phase 7: shields status"

STATUS_DOWN=$(nemoclaw "${SANDBOX_NAME}" shields status 2>&1)
echo "$STATUS_DOWN"

if echo "$STATUS_DOWN" | grep -q "Shields: DOWN"; then
  pass "shields status reports DOWN"
else
  fail "shields status should show DOWN: ${STATUS_DOWN}"
fi

if echo "$STATUS_DOWN" | grep -q "E2E shields lifecycle test"; then
  pass "shields status shows reason"
else
  fail "shields status should show reason: ${STATUS_DOWN}"
fi

if echo "$STATUS_DOWN" | grep -q "remaining"; then
  pass "shields status shows timeout remaining"
else
  info "shields status timeout display not found — non-fatal"
fi

# Restore shields for the next phase
if RESTORE_UP_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" shields up 2>&1); then
  echo "$RESTORE_UP_OUTPUT"
  pass "shields up restored for audit trail test"
else
  echo "$RESTORE_UP_OUTPUT"
  fail "Failed to restore shields up before audit phase: ${RESTORE_UP_OUTPUT}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 8: Audit trail
# ══════════════════════════════════════════════════════════════════
section "Phase 8: Audit trail"

if [ -f "$AUDIT_FILE" ]; then
  AUDIT_LINES=$(wc -l <"$AUDIT_FILE")
  info "Audit entries: ${AUDIT_LINES}"

  # Should have at least: shields_up, shields_down, shields_up
  DOWN_COUNT=$(grep -c '"shields_down"' "$AUDIT_FILE" || true)
  UP_COUNT=$(grep -c '"shields_up"' "$AUDIT_FILE" || true)

  if [ "$UP_COUNT" -ge 2 ]; then
    pass "Audit has ≥2 shields_up entries (got ${UP_COUNT})"
  else
    fail "Expected ≥2 shields_up audit entries, got ${UP_COUNT}"
  fi

  if [ "$DOWN_COUNT" -ge 1 ]; then
    pass "Audit has ≥1 shields_down entries (got ${DOWN_COUNT})"
  else
    fail "Expected ≥1 shields_down audit entries, got ${DOWN_COUNT}"
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
# Phase 9: Auto-restore timer
# ══════════════════════════════════════════════════════════════════
section "Phase 9: Auto-restore timer"

# shields down with a 10s timeout starts an auto-restore timer that
# re-locks config (shields up) after the timeout expires.
nemoclaw "${SANDBOX_NAME}" shields down --timeout 10s --reason "Auto-restore timer E2E" 2>&1

# Verify shields are down
STATUS_TIMER=$(nemoclaw "${SANDBOX_NAME}" shields status 2>&1)
if echo "$STATUS_TIMER" | grep -q "Shields: DOWN"; then
  pass "shields down with 10s timeout"
else
  fail "shields should be DOWN: ${STATUS_TIMER}"
fi

info "Polling for auto-restore to shields UP (up to 60s)..."
TIMER_RESTORED=false
for _poll in $(seq 1 12); do
  sleep 5
  STATUS_AFTER_TIMER=$(nemoclaw "${SANDBOX_NAME}" shields status 2>&1)
  if echo "$STATUS_AFTER_TIMER" | grep -q "Shields: UP"; then
    TIMER_RESTORED=true
    break
  fi
done

if [ "$TIMER_RESTORED" = "true" ]; then
  pass "Auto-restore timer re-locked config after timeout"
else
  info "Auto-restore may not have fired (timer runs as detached process)"
  info "Status: ${STATUS_AFTER_TIMER}"
  fail "Auto-restore timer did not re-lock within 60s"
fi

# Verify config is locked after auto-restore
PERMS_TIMER=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  stat -c '%a' "${CONFIG_PATH}" 2>/dev/null || true)
if echo "$PERMS_TIMER" | grep -qE "^4[0-4][0-4]"; then
  pass "Config locked after auto-restore (${PERMS_TIMER})"
else
  fail "Config should be locked after auto-restore, got: ${PERMS_TIMER}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 10: Double shields-up rejected
# ══════════════════════════════════════════════════════════════════
section "Phase 10: Double shields-up rejected"

nemoclaw "${SANDBOX_NAME}" shields up 2>&1
DOUBLE_UP=$(nemoclaw "${SANDBOX_NAME}" shields up 2>&1 || true)

if echo "$DOUBLE_UP" | grep -q "already active"; then
  pass "Double shields-up rejected"
else
  fail "Double shields-up should be rejected: ${DOUBLE_UP}"
fi

nemoclaw "${SANDBOX_NAME}" shields down --timeout 5m --reason "Cleanup" 2>&1
pass "Cleanup: shields down"

# ══════════════════════════════════════════════════════════════════
# Phase 11: Double shields-down rejected
# ══════════════════════════════════════════════════════════════════
section "Phase 11: Double shields-down rejected"

DOUBLE_DOWN=$(nemoclaw "${SANDBOX_NAME}" shields down --timeout 5m --reason "Should fail" 2>&1 || true)

if echo "$DOUBLE_DOWN" | grep -q "already unlocked"; then
  pass "Double shields-down rejected"
else
  fail "Double shields-down should be rejected: ${DOUBLE_DOWN}"
fi

# ══════════════════════════════════════════════════════════════════
# Cleanup
# ══════════════════════════════════════════════════════════════════
section "Cleanup"

[[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || nemoclaw "${SANDBOX_NAME}" destroy --yes 2>/dev/null || true
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
