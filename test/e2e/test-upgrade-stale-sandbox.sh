#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Issue #1904 reproduction — "sandbox OpenClaw version is not upgraded
# after NemoClaw upgrade".
#
#   1. Install current NemoClaw via install.sh (sets up gateway + OpenShell)
#   2. Delete the sandbox install.sh created (keep the gateway)
#   3. Build a base image with an OLDER OpenClaw version (2026.3.11)
#   4. Create a sandbox from that old image via openshell directly
#   5. Register it in NemoClaw's registry with the old agentVersion
#   6. Run `nemoclaw upgrade-sandboxes --check`
#   7. Verify it detects the sandbox as stale
#   8. Run `nemoclaw <name> rebuild --yes` to upgrade
#   9. Verify the sandbox now runs the current OpenClaw version
#  10. Verify `upgrade-sandboxes --check` reports clean
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)

set -euo pipefail

OLD_OPENCLAW_VERSION="2026.3.11"
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-upgrade-stale}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"
SESSION_FILE="$HOME/.nemoclaw/onboard-session.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  echo -e "${YELLOW}[DIAG]${NC} --- Failure diagnostics ---" >&2
  echo -e "${YELLOW}[DIAG]${NC} Registry: $(cat "${REGISTRY_FILE}" 2>/dev/null || echo 'not found')" >&2
  echo -e "${YELLOW}[DIAG]${NC} Sandboxes: $(openshell sandbox list 2>&1 || echo 'openshell unavailable')" >&2
  echo -e "${YELLOW}[DIAG]${NC} Docker images: $(docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -Ei 'sandbox|nemoclaw|openclaw' | head -10 || true)" >&2
  echo -e "${YELLOW}[DIAG]${NC} --- End diagnostics ---" >&2
  exit 1
}
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
diag() { echo -e "${YELLOW}[DIAG]${NC} $1"; }

# ── Preflight ───────────────────────────────────────────────────────
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY is required"
[ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || fail "NEMOCLAW_NON_INTERACTIVE=1 is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

export NEMOCLAW_REBUILD_VERBOSE=1

info "Issue #1904 reproduction (old OpenClaw: ${OLD_OPENCLAW_VERSION}, sandbox: ${SANDBOX_NAME})"

# ── Phase 1: Install current NemoClaw ────────────────────────────────
info "Phase 1: Installing current NemoClaw via install.sh..."

export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME="${SANDBOX_NAME}"
export NEMOCLAW_RECREATE_SANDBOX=1

INSTALL_LOG="/tmp/nemoclaw-e2e-upgrade-install.log"
if ! bash "${REPO_ROOT}/install.sh" --non-interactive >"$INSTALL_LOG" 2>&1; then
  info "install.sh exited non-zero (may be expected). Checking..."
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

# ── Phase 2: Delete sandbox, build old base image ────────────────────
info "Phase 2: Replacing sandbox with old OpenClaw ${OLD_OPENCLAW_VERSION}..."

# Delete the sandbox that install.sh created — we'll make our own old one.
openshell sandbox delete "${SANDBOX_NAME}" 2>/dev/null || true
diag "Deleted Phase 1 sandbox, gateway preserved"

OLD_BASE_TAG="nemoclaw-old-base:e2e-upgrade-stale"
BLUEPRINT="${REPO_ROOT}/nemoclaw-blueprint/blueprint.yaml"
BLUEPRINT_BAK="${BLUEPRINT}.bak"

# Temporarily lower min_openclaw_version so the old version builds.
cp "${BLUEPRINT}" "${BLUEPRINT_BAK}"
sed "s/min_openclaw_version:.*/min_openclaw_version: \"${OLD_OPENCLAW_VERSION}\"/" "${BLUEPRINT}" >"${BLUEPRINT}.tmp"
mv "${BLUEPRINT}.tmp" "${BLUEPRINT}"

docker build \
  --build-arg "OPENCLAW_VERSION=${OLD_OPENCLAW_VERSION}" \
  -f "${REPO_ROOT}/Dockerfile.base" \
  -t "${OLD_BASE_TAG}" \
  "${REPO_ROOT}"
BUILD_RC=$?

mv "${BLUEPRINT_BAK}" "${BLUEPRINT}"
[ "$BUILD_RC" -eq 0 ] || fail "Failed to build old base image"

pass "Old base image built (OpenClaw ${OLD_OPENCLAW_VERSION})"

# ── Phase 3: Create old sandbox via openshell ────────────────────────
info "Phase 3: Creating sandbox with old OpenClaw..."

TESTDIR=$(mktemp -d)
cat >"${TESTDIR}/Dockerfile" <<DOCKERFILE
FROM ${OLD_BASE_TAG}
USER sandbox
WORKDIR /sandbox
RUN mkdir -p /sandbox/.openclaw-data/workspace /sandbox/.openclaw && echo '{}' > /sandbox/.openclaw/openclaw.json
CMD ["/bin/bash"]
DOCKERFILE

openshell sandbox create --name "${SANDBOX_NAME}" --from "${TESTDIR}/Dockerfile" --gateway nemoclaw --no-tty -- true
rm -rf "${TESTDIR}"

# Wait for Ready
for _i in $(seq 1 30); do
  if openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready"; then
    break
  fi
  sleep 5
done
openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready" \
  || fail "Sandbox did not become Ready"

SANDBOX_VERSION=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- openclaw --version 2>&1) \
  || fail "Failed to read OpenClaw version from old sandbox"
info "Old sandbox OpenClaw version: ${SANDBOX_VERSION}"

pass "Old sandbox created (OpenClaw ${OLD_OPENCLAW_VERSION})"

# ── Phase 4: Register with old agentVersion ──────────────────────────
info "Phase 4: Registering sandbox with old agentVersion..."

python3 -c "
import json
reg = {'sandboxes': {'${SANDBOX_NAME}': {
    'name': '${SANDBOX_NAME}',
    'createdAt': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'model': 'nvidia/nemotron-3-super-120b-a12b',
    'provider': 'nvidia-prod',
    'gpuEnabled': False,
    'policies': [],
    'policyTier': None,
    'agent': None,
    'agentVersion': '${OLD_OPENCLAW_VERSION}'
}}, 'defaultSandbox': '${SANDBOX_NAME}'}
with open('${REGISTRY_FILE}', 'w') as f:
    json.dump(reg, f, indent=2)

sess_path = '${SESSION_FILE}'
try:
    with open(sess_path) as f:
        sess = json.load(f)
except Exception:
    sess = {}
sess['sandboxName'] = '${SANDBOX_NAME}'
sess['status'] = 'complete'
with open(sess_path, 'w') as f:
    json.dump(sess, f, indent=2)
print('Registry and session updated')
"

pass "Sandbox registered with agentVersion=${OLD_OPENCLAW_VERSION}"

# ── Phase 5: Verify upgrade-sandboxes detects the stale sandbox ──────
info "Phase 5: Running upgrade-sandboxes --check..."

CHECK_OUTPUT=$(nemoclaw upgrade-sandboxes --check 2>&1 || true)
echo "$CHECK_OUTPUT"

if echo "$CHECK_OUTPUT" | grep -qi "stale\|need upgrading"; then
  pass "Phase 5: upgrade-sandboxes --check detected stale sandbox"
elif echo "$CHECK_OUTPUT" | grep -qi "up to date"; then
  fail "upgrade-sandboxes --check says all up to date — stale sandbox NOT detected (#1904)"
else
  fail "upgrade-sandboxes --check produced unexpected output"
fi

# ── Phase 6: Rebuild and verify new version ──────────────────────────
info "Phase 6: Rebuilding sandbox..."

nemoclaw "${SANDBOX_NAME}" rebuild --yes 2>&1 || fail "Sandbox rebuild failed"

for _i in $(seq 1 30); do
  if openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready"; then
    break
  fi
  sleep 5
done

NEW_OPENCLAW_VERSION=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- openclaw --version 2>&1) \
  || fail "Failed to read OpenClaw version after rebuild"
info "New sandbox OpenClaw version: ${NEW_OPENCLAW_VERSION}"

if echo "${NEW_OPENCLAW_VERSION}" | grep -q "${OLD_OPENCLAW_VERSION}"; then
  fail "Sandbox still running old OpenClaw ${OLD_OPENCLAW_VERSION} after rebuild — #1904 NOT fixed"
fi

pass "Phase 6: Sandbox upgraded from OpenClaw ${OLD_OPENCLAW_VERSION} to ${NEW_OPENCLAW_VERSION}"

# ── Phase 7: Verify clean ────────────────────────────────────────────
info "Phase 7: Verifying upgrade-sandboxes --check is clean..."

RECHECK_OUTPUT=$(nemoclaw upgrade-sandboxes --check 2>&1 || true)
echo "$RECHECK_OUTPUT"

if echo "$RECHECK_OUTPUT" | grep -qi "up to date"; then
  pass "Phase 7: All sandboxes up to date after rebuild"
else
  fail "Phase 7: upgrade-sandboxes --check did not report 'up to date' after rebuild"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Issue #1904 E2E PASSED${NC}"
echo -e "${GREEN}  Old: OpenClaw ${OLD_OPENCLAW_VERSION}${NC}"
echo -e "${GREEN}  New: OpenClaw ${NEW_OPENCLAW_VERSION}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
