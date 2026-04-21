#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Snapshot commands E2E — validates the full snapshot create/list/restore lifecycle:
#
#   1. Install NemoClaw (install.sh)
#   2. Write marker files into sandbox workspace
#   3. nemoclaw <name> snapshot create — verify snapshot created
#   4. nemoclaw <name> snapshot list — verify snapshot appears in list
#   5. Delete marker files from sandbox (simulate data loss)
#   6. nemoclaw <name> snapshot restore — verify markers restored
#   7. nemoclaw <name> snapshot restore <timestamp> — verify targeted restore
#   8. No credentials in snapshot directory
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required

set -euo pipefail

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-snapshot}"
MARKER_FILE="/sandbox/.openclaw-data/workspace/snapshot-marker.txt"
MARKER_CONTENT="SNAPSHOT_E2E_$(date +%s)"
SECOND_MARKER="/sandbox/.openclaw-data/workspace/snapshot-marker-2.txt"
SECOND_CONTENT="SNAPSHOT_E2E_SECOND_$(date +%s)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  echo -e "${YELLOW}[DIAG]${NC} --- Failure diagnostics ---" >&2
  echo -e "${YELLOW}[DIAG]${NC} Sandboxes: $(openshell sandbox list 2>&1 || echo 'unavailable')" >&2
  echo -e "${YELLOW}[DIAG]${NC} Backup dir: $(ls -la "$HOME/.nemoclaw/rebuild-backups/${SANDBOX_NAME}/" 2>&1 || echo 'not found')" >&2
  echo -e "${YELLOW}[DIAG]${NC} --- End diagnostics ---" >&2
  exit 1
}
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

# ── Preflight ───────────────────────────────────────────────────────
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY is required"
[ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || fail "NEMOCLAW_NON_INTERACTIVE=1 is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

info "Snapshot commands E2E (sandbox: ${SANDBOX_NAME})"

# ── Phase 1: Install NemoClaw ───────────────────────────────────────
info "Phase 1: Installing NemoClaw via install.sh..."

export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME="${SANDBOX_NAME}"
export NEMOCLAW_RECREATE_SANDBOX=1

INSTALL_LOG="/tmp/nemoclaw-e2e-install.log"
if ! bash "${REPO_ROOT}/install.sh" --non-interactive >"$INSTALL_LOG" 2>&1; then
  info "install.sh exited non-zero (may be expected on re-install). Checking for nemoclaw..."
fi

# Source shell profile to pick up nvm/PATH changes
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

command -v nemoclaw >/dev/null 2>&1 || fail "nemoclaw not found on PATH after install"
command -v openshell >/dev/null 2>&1 || fail "openshell not found on PATH after install"
pass "NemoClaw installed"

# ── Phase 2: Write marker files ────────────────────────────────────
info "Phase 2: Writing marker files into sandbox..."

openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  sh -c "mkdir -p /sandbox/.openclaw-data/workspace && echo '${MARKER_CONTENT}' > ${MARKER_FILE}" \
  || fail "Failed to write marker file"

VERIFY=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat "${MARKER_FILE}" 2>/dev/null || true)
[ "$VERIFY" = "${MARKER_CONTENT}" ] || fail "Marker verification failed: got '${VERIFY}'"

pass "Marker file written"

# ── Phase 3: snapshot create ────────────────────────────────────────
info "Phase 3: Creating snapshot..."

SNAPSHOT_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" snapshot create 2>&1)
echo "$SNAPSHOT_OUTPUT"

if echo "$SNAPSHOT_OUTPUT" | grep -q "Snapshot created"; then
  pass "snapshot create succeeded"
else
  fail "snapshot create did not report success: ${SNAPSHOT_OUTPUT}"
fi

# Extract the snapshot path from output
SNAPSHOT_PATH=$(echo "$SNAPSHOT_OUTPUT" | grep -oE "/[^ ]*rebuild-backups/[^ ]+" || true)
info "Snapshot path: ${SNAPSHOT_PATH:-unknown}"

# ── Phase 4: snapshot list ──────────────────────────────────────────
info "Phase 4: Listing snapshots..."

LIST_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" snapshot list 2>&1)
echo "$LIST_OUTPUT"

if echo "$LIST_OUTPUT" | grep -q "snapshot(s)"; then
  pass "snapshot list shows snapshots"
else
  fail "snapshot list shows no snapshots: ${LIST_OUTPUT}"
fi

# Extract the timestamp from list output for targeted restore later
SNAPSHOT_TIMESTAMP=$(echo "$LIST_OUTPUT" | grep -oE "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]+Z" | head -1 || true)
[ -n "${SNAPSHOT_TIMESTAMP}" ] || fail "Failed to parse a snapshot timestamp from list output: ${LIST_OUTPUT}"
info "Snapshot timestamp: ${SNAPSHOT_TIMESTAMP}"

# ── Phase 5: Delete marker + write second marker, create 2nd snapshot
info "Phase 5: Modifying sandbox state and creating second snapshot..."

openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  sh -c "rm -f ${MARKER_FILE} && echo '${SECOND_CONTENT}' > ${SECOND_MARKER}" \
  || fail "Failed to modify sandbox state"

# Verify first marker is gone
GONE=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat "${MARKER_FILE}" 2>/dev/null || echo "GONE")
[ "$GONE" = "GONE" ] || fail "First marker should be deleted but got: ${GONE}"

nemoclaw "${SANDBOX_NAME}" snapshot create >/dev/null 2>&1 || fail "Second snapshot create failed"
pass "State modified, second snapshot created"

# Perturb workspace so restore has to do real work
openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  sh -c "rm -f ${SECOND_MARKER} && echo 'BROKEN' > ${MARKER_FILE}" \
  || fail "Failed to perturb sandbox before latest restore"

# ── Phase 6: snapshot restore (latest) ──────────────────────────────
info "Phase 6: Restoring latest snapshot..."

RESTORE_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" snapshot restore 2>&1)
echo "$RESTORE_OUTPUT"

if ! echo "$RESTORE_OUTPUT" | grep -q "Restored"; then
  fail "snapshot restore failed: ${RESTORE_OUTPUT}"
fi

SECOND_CHECK=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat "${SECOND_MARKER}" 2>/dev/null || echo "MISSING")
[ "$SECOND_CHECK" = "${SECOND_CONTENT}" ] || fail "Latest restore did not recover the second marker: ${SECOND_CHECK}"
pass "Latest snapshot restored expected state"

# ── Phase 7: snapshot restore with timestamp (first snapshot) ───────
info "Phase 7: Restoring first snapshot by timestamp..."

TARGETED_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" snapshot restore "${SNAPSHOT_TIMESTAMP}" 2>&1)
echo "$TARGETED_OUTPUT"

if ! echo "$TARGETED_OUTPUT" | grep -q "Restored"; then
  fail "Targeted snapshot restore failed: ${TARGETED_OUTPUT}"
fi

FIRST_CHECK=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat "${MARKER_FILE}" 2>/dev/null || echo "MISSING")
[ "$FIRST_CHECK" = "${MARKER_CONTENT}" ] || fail "First snapshot did not restore the original marker: ${FIRST_CHECK}"
SECOND_AFTER_TARGETED=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat "${SECOND_MARKER}" 2>/dev/null || echo "MISSING")
[ "$SECOND_AFTER_TARGETED" = "MISSING" ] || fail "First snapshot should not contain the second marker"
pass "First snapshot restored expected state"

# ── Phase 8: No credentials in snapshots ────────────────────────────
info "Phase 8: Checking snapshots for leaked credentials..."

BACKUP_DIR="$HOME/.nemoclaw/rebuild-backups/${SANDBOX_NAME}"
if [ -d "$BACKUP_DIR" ]; then
  CRED_LEAKS=$(find "$BACKUP_DIR" \( -name "*.json" -o -name "*.env" -o -name ".env" \) -exec grep -l "nvapi-\|sk-\|Bearer " {} \; 2>/dev/null || true)
  if [ -z "$CRED_LEAKS" ]; then
    pass "No credentials in snapshot directories"
  else
    fail "Credentials found: $CRED_LEAKS"
  fi
else
  fail "Backup directory missing: $BACKUP_DIR"
fi

# ── Phase 9: snapshot help ──────────────────────────────────────────
info "Phase 9: Verifying snapshot help output..."

HELP_OUTPUT=$(nemoclaw "${SANDBOX_NAME}" snapshot 2>&1)
if echo "$HELP_OUTPUT" | grep -q "snapshot create" \
  && echo "$HELP_OUTPUT" | grep -q "snapshot list" \
  && echo "$HELP_OUTPUT" | grep -q "snapshot restore"; then
  pass "snapshot help shows create/list/restore"
else
  fail "snapshot help incomplete: ${HELP_OUTPUT}"
fi

# ── Cleanup ─────────────────────────────────────────────────────────
info "Cleaning up..."
nemoclaw "${SANDBOX_NAME}" destroy --yes 2>/dev/null || true

echo ""
echo -e "${GREEN}Snapshot commands E2E passed.${NC}"
