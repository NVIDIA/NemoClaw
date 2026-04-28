#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Credential Migration E2E
#
# Validates the host-side credential storage hardening:
#
#   1. A pre-existing plaintext ~/.nemoclaw/credentials.json from an earlier
#      release is staged into process.env at onboard time and the value is
#      registered with the OpenShell gateway. The legacy file is then
#      securely removed (zero-filled, then unlinked) — only after a
#      successful onboard, so an interrupted run can be retried without
#      losing the user's only copy.
#
#   2. The migration loop is gated on KNOWN_CREDENTIAL_ENV_KEYS so a stale
#      or tampered credentials.json cannot inject unrelated variables (PATH,
#      NODE_OPTIONS, OPENSHELL_GATEWAY) into the onboard process.
#
#   3. After a normal env-var-driven onboard, no plaintext credentials.json
#      exists under ~/.nemoclaw/.
#
#   4. `nemoclaw credentials list` reports providers from the OpenShell
#      gateway, not from disk.
#
#   5. If ~/.nemoclaw/credentials.json exists as a symlink to an unrelated
#      file, the secure-unlink path removes the symlink without touching
#      the target.
#
# This test deliberately lays down legacy state under the runner's HOME, so
# it should run on an ephemeral CI runner. Local dev runs are destructive
# to ~/.nemoclaw/ — set NEMOCLAW_E2E_KEEP_SANDBOX=1 to skip the teardown
# and inspect post-mortem.
#
# Prerequisites:
#   - Docker running
#   - openshell + nemoclaw on PATH
#   - NVIDIA_API_KEY set (used as the migrated value)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-credential-migration.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=2400
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
indent() { awk '{print "    " $0}'; }

# Resolve repo root the same way the other E2E scripts do.
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-cred-migration}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if [ -z "${NVIDIA_API_KEY:-}" ]; then
  fail "NVIDIA_API_KEY not set"
  exit 1
fi
pass "NVIDIA_API_KEY is set"

if ! command -v openshell >/dev/null 2>&1; then
  info "openshell not found; running install"
  bash "$REPO/install.sh" --yes-i-accept-third-party-software \
    >/tmp/nemoclaw-e2e-install.log 2>&1 || {
    fail "install.sh failed; see /tmp/nemoclaw-e2e-install.log"
    exit 1
  }
fi

command -v openshell >/dev/null 2>&1 || {
  fail "openshell still missing after install"
  exit 1
}
command -v nemoclaw >/dev/null 2>&1 || {
  fail "nemoclaw still missing after install"
  exit 1
}
pass "openshell + nemoclaw on PATH"

REAL_API_KEY="$NVIDIA_API_KEY"
NEMOCLAW_DIR="$HOME/.nemoclaw"
LEGACY_FILE="$NEMOCLAW_DIR/credentials.json"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Pre-seed a legacy credentials.json and verify migration
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Legacy credentials.json migration"

# Start from a clean ~/.nemoclaw to avoid interference from prior runs.
rm -rf "$NEMOCLAW_DIR"
mkdir -p "$NEMOCLAW_DIR"
chmod 700 "$NEMOCLAW_DIR"

# Tampered fixture: includes an unrelated key the migrator must ignore.
cat >"$LEGACY_FILE" <<EOF
{
  "NVIDIA_API_KEY": "$REAL_API_KEY",
  "OPENSHELL_GATEWAY": "evil-gw-from-tampered-file",
  "NODE_OPTIONS": "--require=/tmp/evil.js"
}
EOF
chmod 600 "$LEGACY_FILE"

LEGACY_INODE_BEFORE=$(stat -c '%i' "$LEGACY_FILE" 2>/dev/null || stat -f '%i' "$LEGACY_FILE" 2>/dev/null || echo "")
[ -n "$LEGACY_INODE_BEFORE" ] && info "Legacy file inode before onboard: $LEGACY_INODE_BEFORE"

# Run onboard WITHOUT NVIDIA_API_KEY in the env. The only place the value
# can come from is the legacy credentials.json — exactly the migration
# path we want to exercise.
ONBOARD_LOG="$(mktemp)"
(
  unset NVIDIA_API_KEY
  NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_RECREATE_SANDBOX=1 \
    nemoclaw onboard --non-interactive >"$ONBOARD_LOG" 2>&1
) &
ONBOARD_PID=$!
wait "$ONBOARD_PID"
ONBOARD_EXIT=$?

if [ "$ONBOARD_EXIT" -eq 0 ]; then
  pass "nemoclaw onboard succeeded with only the legacy file as the credential source"
else
  fail "nemoclaw onboard failed (exit $ONBOARD_EXIT); see log below"
  tail -50 "$ONBOARD_LOG" || true
  rm -f "$ONBOARD_LOG"
  exit 1
fi

if grep -q "Staged .* legacy credential" "$ONBOARD_LOG"; then
  pass "Migration notice was emitted to stderr"
else
  fail "Expected migration notice on stderr; not found in onboard log"
  tail -30 "$ONBOARD_LOG" || true
fi
rm -f "$ONBOARD_LOG"

# After a successful onboard, the legacy file must be gone.
if [ -e "$LEGACY_FILE" ]; then
  fail "Legacy credentials.json still exists after successful onboard"
else
  pass "Legacy credentials.json was removed after onboard"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: Verify the value reached the OpenShell gateway
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Gateway provider registration"

if ! PROVIDERS_OUT=$(openshell -g nemoclaw provider list --names 2>&1); then
  fail "openshell -g nemoclaw provider list --names failed"
  printf '%s\n' "$PROVIDERS_OUT" | indent
  exit 1
fi
info "Providers in nemoclaw gateway:"
printf '%s\n' "$PROVIDERS_OUT" | indent

# The legacy NVIDIA_API_KEY should have been registered as one of the
# inference providers (nvidia-prod, nvidia-nim, etc. — the exact name
# depends on what onboarding chose). Just assert that at least one
# provider was registered.
PROVIDER_COUNT=$(echo "$PROVIDERS_OUT" | grep -E -c '^[a-zA-Z][a-zA-Z0-9_-]*$' || true)
if [ "$PROVIDER_COUNT" -ge 1 ]; then
  pass "At least one provider is registered with the gateway ($PROVIDER_COUNT total)"
else
  fail "No providers registered with the gateway after migration"
fi

# Negative assertion: the unrelated keys from the tampered file must not
# have leaked anywhere observable. The strongest check available without
# spawning another nemoclaw process is to verify they are NOT registered
# as gateway provider names — since `openshell provider create
# --credential KEY` would have failed for non-allowlisted keys, but a bug
# could conceivably push them through.
if echo "$PROVIDERS_OUT" | grep -q "OPENSHELL_GATEWAY\|NODE_OPTIONS"; then
  fail "A non-allowlisted key from the tampered file appears as a gateway provider"
else
  pass "Non-allowlisted keys from the tampered file did not become providers"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: nemoclaw credentials list reads from the gateway, not disk
# ══════════════════════════════════════════════════════════════════
section "Phase 3: nemoclaw credentials list"

if ! CREDS_LIST_OUT=$(nemoclaw credentials list 2>&1); then
  fail "nemoclaw credentials list failed"
  printf '%s\n' "$CREDS_LIST_OUT" | indent
  exit 1
fi
info "Output:"
printf '%s\n' "$CREDS_LIST_OUT" | indent

if echo "$CREDS_LIST_OUT" | grep -q "Providers registered with the OpenShell gateway"; then
  pass "credentials list surfaces gateway-registered providers"
else
  fail "credentials list did not produce the expected gateway header"
fi

# The disk should still have NO plaintext credentials.json regardless of
# what the gateway holds.
if [ -e "$LEGACY_FILE" ]; then
  fail "credentials.json reappeared on disk after credentials list"
else
  pass "No plaintext credentials.json on disk after credentials list"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Symlink-safe secure unlink
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Symlink-safe secure unlink"

# Plant a symlink at the credentials path pointing at an unrelated victim
# file. A naive secureUnlink would zero-fill and unlink the target; the
# hardened path must remove the symlink itself and leave the target
# intact.
VICTIM_FILE="$(mktemp)"
VICTIM_PAYLOAD="important data the attacker should not touch"
printf '%s' "$VICTIM_PAYLOAD" >"$VICTIM_FILE"
ln -s "$VICTIM_FILE" "$LEGACY_FILE"

# Drive removeLegacyCredentialsFile() directly via a tiny node one-liner.
# Using the compiled module from dist/ matches what the CLI imports.
node -e "
const { removeLegacyCredentialsFile } = require('${REPO}/dist/lib/credentials.js');
removeLegacyCredentialsFile();
" >/dev/null 2>&1 || {
  fail "node invocation of removeLegacyCredentialsFile failed"
}

if [ -L "$LEGACY_FILE" ] || [ -e "$LEGACY_FILE" ]; then
  fail "Symlink at credentials path was not removed"
else
  pass "Symlink at credentials path was removed"
fi

if [ ! -e "$VICTIM_FILE" ]; then
  fail "Victim file was deleted; secureUnlink followed the symlink"
elif [ "$(cat "$VICTIM_FILE")" != "$VICTIM_PAYLOAD" ]; then
  fail "Victim file contents were modified; secureUnlink wrote through the symlink"
else
  pass "Victim file is untouched (link removed without following the target)"
fi
rm -f "$VICTIM_FILE"

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
section "Summary"
echo "  Total:   $TOTAL"
echo "  Passed:  $PASS"
echo "  Failed:  $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
