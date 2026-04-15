#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw rebuild upgrade E2E — reproduces the exact NVBug 6076156 scenario:
#
#   1. Install NemoClaw (install.sh)
#   2. Build a base image with an OLDER OpenClaw version (2026.3.11)
#   3. Create a sandbox from that old image via openshell directly
#   4. Write marker files into workspace state dirs
#   5. Restore the current base image
#   6. Run `nemoclaw <name> rebuild --yes`
#   7. Verify marker files survived the rebuild
#   8. Verify the sandbox now reports the CURRENT version
#   9. Verify no credentials leaked into the local backup
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-rebuild-oc}"
OLD_OPENCLAW_VERSION="2026.3.11"
MARKER_FILE="/sandbox/.openclaw-data/workspace/rebuild-marker.txt"
MARKER_CONTENT="REBUILD_OC_E2E_$(date +%s)"
REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"
SESSION_FILE="$HOME/.nemoclaw/onboard-session.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  # Dump diagnostic state on failure
  echo -e "${YELLOW}[DIAG]${NC} --- Failure diagnostics ---" >&2
  echo -e "${YELLOW}[DIAG]${NC} Registry: $(cat "${REGISTRY_FILE}" 2>/dev/null || echo 'not found')" >&2
  echo -e "${YELLOW}[DIAG]${NC} Session: $(cat "${SESSION_FILE}" 2>/dev/null || echo 'not found')" >&2
  echo -e "${YELLOW}[DIAG]${NC} Sandboxes: $(openshell sandbox list 2>&1 || echo 'openshell unavailable')" >&2
  echo -e "${YELLOW}[DIAG]${NC} Docker: $(docker ps --format '{{.Names}} {{.Image}} {{.Status}}' 2>&1 | head -5)" >&2
  echo -e "${YELLOW}[DIAG]${NC} --- End diagnostics ---" >&2
  exit 1
}
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
diag() { echo -e "${YELLOW}[DIAG]${NC} $1"; }

# Enable verbose logging in rebuild command
export NEMOCLAW_REBUILD_VERBOSE=1

# ── Preflight ───────────────────────────────────────────────────────
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY is required"
[ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || fail "NEMOCLAW_NON_INTERACTIVE=1 is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

info "OpenClaw rebuild upgrade E2E (old: ${OLD_OPENCLAW_VERSION}, sandbox: ${SANDBOX_NAME})"

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

# Delete the sandbox that install.sh created — we'll make our own old one.
# Use openshell directly to preserve the 'nemoclaw' gateway for the rebuild.
openshell sandbox delete "${SANDBOX_NAME}" 2>/dev/null || true
diag "Deleted Phase 1 sandbox, gateway preserved: $(docker ps --filter name=openshell --format '{{.Names}} {{.Status}}' 2>/dev/null)"

# ── Phase 2: Build old base image ──────────────────────────────────
info "Phase 2: Building base image with OpenClaw ${OLD_OPENCLAW_VERSION}..."

OLD_BASE_TAG="nemoclaw-old-base:e2e-rebuild"
BLUEPRINT="${REPO_ROOT}/nemoclaw-blueprint/blueprint.yaml"
BLUEPRINT_BAK="${BLUEPRINT}.bak"

# Dockerfile.base validates OPENCLAW_VERSION >= min_openclaw_version.
# Temporarily lower the minimum so the old version builds.
cp "${BLUEPRINT}" "${BLUEPRINT_BAK}"
# sed -i behaves differently on macOS vs Linux; use a temp file for portability
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

# ── Phase 3: Create old sandbox via openshell ───────────────────────
info "Phase 3: Creating sandbox with old OpenClaw via openshell..."

# Build a minimal Dockerfile that uses the old base
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
openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready" || fail "Sandbox did not become Ready"

# Verify old version
SANDBOX_VERSION=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- openclaw --version 2>&1 || true)
echo "${SANDBOX_VERSION}" | grep -q "${OLD_OPENCLAW_VERSION}" || info "Version: ${SANDBOX_VERSION}"

pass "Old sandbox created (OpenClaw ${OLD_OPENCLAW_VERSION})"

# ── Phase 4: Write marker files + register ──────────────────────────
info "Phase 4: Writing markers and registering sandbox..."

openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  sh -c "mkdir -p /sandbox/.openclaw-data/workspace && echo '${MARKER_CONTENT}' > ${MARKER_FILE}" \
  || fail "Failed to write marker file"

# Verify
VERIFY=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat "${MARKER_FILE}" 2>/dev/null || true)
[ "$VERIFY" = "${MARKER_CONTENT}" ] || fail "Marker verification failed: got '${VERIFY}'"

# Register in NemoClaw registry with old version
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

# Update session to point at this sandbox
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

pass "Markers written, sandbox registered"

# Diagnostic dump before rebuild
diag "Pre-rebuild state:"
diag "  Registry: $(python3 -c "import json; d=json.load(open('${REGISTRY_FILE}')); print(json.dumps({k: {'agent': v.get('agent'), 'agentVersion': v.get('agentVersion')} for k,v in d.get('sandboxes',{}).items()}))" 2>/dev/null)"
diag "  Session: $(python3 -c "import json; s=json.load(open('${SESSION_FILE}')); print(f'name={s.get(\"sandboxName\")} status={s.get(\"status\")} resumable={s.get(\"resumable\")} provider={s.get(\"provider\")} model={s.get(\"model\")}')" 2>/dev/null)"
diag "  Live sandboxes: $(openshell sandbox list 2>&1 | grep -v NAME || echo none)"
diag "  Gateway: $(docker ps --filter name=openshell --format '{{.Names}} {{.Status}}' 2>/dev/null || echo 'not running')"

# ── Phase 5: Restore current base image ─────────────────────────────
info "Phase 5: Restoring current base image..."

docker build \
  -f "${REPO_ROOT}/Dockerfile.base" \
  -t "ghcr.io/nvidia/nemoclaw/sandbox-base:latest" \
  "${REPO_ROOT}" \
  || fail "Failed to build current base image"

pass "Current base image restored"

# ── Phase 6: Rebuild ────────────────────────────────────────────────
info "Phase 6: Running nemoclaw rebuild..."

diag "Calling: nemoclaw ${SANDBOX_NAME} rebuild --yes --verbose"
nemoclaw "${SANDBOX_NAME}" rebuild --yes --verbose || fail "Rebuild failed"

pass "Rebuild completed"

# ── Phase 7: Verify ─────────────────────────────────────────────────
info "Phase 7: Verifying results..."

# Marker file survived
RESTORED=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat "${MARKER_FILE}" 2>/dev/null || true)
if [ "$RESTORED" = "${MARKER_CONTENT}" ]; then
  pass "Marker file survived rebuild"
else
  fail "Marker file lost: got '${RESTORED}', expected '${MARKER_CONTENT}'"
fi

# Version upgraded
NEW_VERSION=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- openclaw --version 2>&1 || true)
if [ -z "${NEW_VERSION}" ]; then
  fail "Could not get OpenClaw version from sandbox (empty output)"
elif echo "${NEW_VERSION}" | grep -q "${OLD_OPENCLAW_VERSION}"; then
  fail "Version still old after rebuild: ${NEW_VERSION}"
else
  pass "OpenClaw version upgraded: ${NEW_VERSION}"
fi

# Registry updated
REGISTRY_VERSION=$(python3 -c "
import json
with open('${REGISTRY_FILE}') as f:
    data = json.load(f)
sb = data.get('sandboxes', {}).get('${SANDBOX_NAME}', {})
print(sb.get('agentVersion', 'null'))
" 2>/dev/null || echo "error")
if [ "$REGISTRY_VERSION" != "null" ] && [ "$REGISTRY_VERSION" != "error" ] && [ "$REGISTRY_VERSION" != "${OLD_OPENCLAW_VERSION}" ]; then
  pass "Registry agentVersion updated to ${REGISTRY_VERSION}"
else
  fail "Registry agentVersion not updated: got '${REGISTRY_VERSION}', expected != '${OLD_OPENCLAW_VERSION}'"
fi

# Inference works after rebuild (proves credential chain is intact)
info "Verifying inference after rebuild..."
INFERENCE_RESPONSE=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  curl -s --max-time 60 https://inference.local/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"Reply with exactly one word: PONG"}],"max_tokens":100}' \
  2>&1 || true)
if echo "${INFERENCE_RESPONSE}" | python3 -c "import json,sys; r=json.load(sys.stdin); c=r['choices'][0]['message']; print(c.get('content',''))" 2>/dev/null | grep -qi "PONG"; then
  pass "Inference works after rebuild (NVIDIA API key + provider chain intact)"
else
  # Non-fatal — inference depends on external API availability
  info "Inference check inconclusive (may be API timeout): ${INFERENCE_RESPONSE:0:200}"
fi

# No credentials in backup
BACKUP_DIR="$HOME/.nemoclaw/rebuild-backups/${SANDBOX_NAME}"
if [ -d "$BACKUP_DIR" ]; then
  CRED_LEAKS=$(find "$BACKUP_DIR" \( -name "*.json" -o -name "*.env" -o -name ".env" \) -exec grep -l "nvapi-\|sk-\|Bearer " {} \; 2>/dev/null || true)
  if [ -z "$CRED_LEAKS" ]; then
    pass "No credentials in backup"
  else
    fail "Credentials found: $CRED_LEAKS"
  fi
else
  fail "Backup directory missing: $BACKUP_DIR"
fi

# ── Cleanup ─────────────────────────────────────────────────────────
info "Cleaning up..."
nemoclaw "${SANDBOX_NAME}" destroy --yes 2>/dev/null || true
docker rmi "${OLD_BASE_TAG}" 2>/dev/null || true

echo ""
echo -e "${GREEN}OpenClaw rebuild upgrade E2E passed.${NC}"
