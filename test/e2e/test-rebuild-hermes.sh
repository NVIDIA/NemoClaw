#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes rebuild upgrade E2E — same upgrade scenario as OpenClaw but for Hermes:
#
#   1. Install NemoClaw (install.sh)
#   2. Build a Hermes base image with an OLDER version (v2026.4.13)
#   3. Build a minimal Hermes sandbox image (no current-Dockerfile patches)
#   4. Create sandbox via openshell directly
#   5. Write marker files into Hermes state dirs
#   6. Restore the current Hermes base image
#   7. Run `nemoclaw <name> rebuild --yes`
#   8. Verify marker files survived + version upgraded
#
# Set NEMOCLAW_HERMES_STALE_BASE_REBUILD_E2E=1 to leave the cached
# ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest tag on the older Hermes
# base before rebuild. That mode is the regression coverage for issue #3025.
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-rebuild-hm}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

OLD_HERMES_VERSION="v2026.4.13"
OLD_HERMES_REGISTRY_VERSION="${OLD_HERMES_VERSION#v}"
OLD_HERMES_TARBALL_SHA256="5e4529b8cb6e4821eb916b81517e48125109b1764d6d1e68a204a9f0ddf2d98c"
STALE_BASE_REBUILD="${NEMOCLAW_HERMES_STALE_BASE_REBUILD_E2E:-0}"
MARKER_FILE="/sandbox/.hermes/memories/rebuild-marker.txt"
MARKER_CONTENT="REBUILD_HM_E2E_$(date +%s)"
DISCORD_PLACEHOLDER="openshell:resolve:env:DISCORD_BOT_TOKEN"
DISCORD_FAKE_TOKEN="test-fake-discord-token-rebuild-e2e"
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
  echo -e "${YELLOW}[DIAG]${NC} Session: $(cat "${SESSION_FILE}" 2>/dev/null || echo 'not found')" >&2
  echo -e "${YELLOW}[DIAG]${NC} Sandboxes: $(openshell sandbox list 2>&1 || echo 'openshell unavailable')" >&2
  echo -e "${YELLOW}[DIAG]${NC} Docker: $(docker ps --format '{{.Names}} {{.Image}} {{.Status}}' 2>&1 | head -5)" >&2
  dump_hermes_sandbox_logs >&2 || true
  echo -e "${YELLOW}[DIAG]${NC} --- End diagnostics ---" >&2
  exit 1
}
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
diag() { echo -e "${YELLOW}[DIAG]${NC} $1"; }

dump_hermes_sandbox_logs() {
  command -v openshell >/dev/null 2>&1 || {
    diag "openshell is not available for sandbox log diagnostics"
    return
  }
  openshell sandbox list 2>&1 | grep -Fq -- "$SANDBOX_NAME" || {
    diag "sandbox '${SANDBOX_NAME}' is not visible to openshell"
    return
  }

  local diag_script
  diag_script='set +e'
  diag_script+='; echo "== identity =="; id 2>&1 || true'
  diag_script+='; echo "== listening sockets =="; ss -tlnp 2>&1 || ss -tln 2>&1 || true'
  diag_script+='; echo "== log and state paths =="; ls -ld /tmp /sandbox/.hermes /sandbox/.hermes/logs 2>&1 || true; ls -l /tmp/nemoclaw-start.log /tmp/gateway.log 2>&1 || true'
  diag_script+='; echo "== hermes-related processes =="'
  # shellcheck disable=SC2016  # script is intentionally evaluated inside the sandbox
  diag_script+='; for p in /proc/[0-9]*; do cmd=$(tr "\000" " " < "$p/cmdline" 2>/dev/null || true); case "$cmd" in *hermes*|*socat*|*nemoclaw-decode-proxy*) echo "$(basename "$p") $cmd" ;; esac; done'
  diag_script+='; echo "== /tmp/nemoclaw-start.log tail =="; tail -n 80 /tmp/nemoclaw-start.log 2>&1 || true'
  diag_script+='; echo "== /tmp/gateway.log tail =="; tail -n 120 /tmp/gateway.log 2>&1 || true'

  diag "Hermes sandbox runtime logs:"
  openshell sandbox exec -n "$SANDBOX_NAME" -- sh -lc "$diag_script" 2>&1 | sed 's/^/[DIAG]   /'
}

export NEMOCLAW_REBUILD_VERBOSE=1

# ── Preflight ───────────────────────────────────────────────────────
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY is required"
[ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || fail "NEMOCLAW_NON_INTERACTIVE=1 is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXPECTED_HERMES_VERSION="$(grep -E '^expected_version:' "${REPO_ROOT}/agents/hermes/manifest.yaml" | sed -E 's/.*"([^"]+)".*/\1/')"
[ -n "${EXPECTED_HERMES_VERSION}" ] || fail "Could not parse expected Hermes version from manifest"

if [ "${STALE_BASE_REBUILD}" = "1" ]; then
  info "Hermes stale-base rebuild E2E (old: ${OLD_HERMES_VERSION}, expected: ${EXPECTED_HERMES_VERSION}, sandbox: ${SANDBOX_NAME})"
else
  info "Hermes rebuild upgrade E2E (old: ${OLD_HERMES_VERSION}, expected: ${EXPECTED_HERMES_VERSION}, sandbox: ${SANDBOX_NAME})"
fi

# ── Phase 1: Install NemoClaw ───────────────────────────────────────
info "Phase 1: Installing NemoClaw via install.sh..."

export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME="${SANDBOX_NAME}"
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_AGENT=hermes

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

# ── Phase 2: Build old Hermes base image ───────────────────────────
info "Phase 2: Building Hermes base image with ${OLD_HERMES_VERSION}..."

OLD_BASE_TAG="nemoclaw-hermes-old-base:e2e-rebuild"

docker build \
  --build-arg "HERMES_VERSION=${OLD_HERMES_VERSION}" \
  --build-arg "HERMES_TARBALL_SHA256=${OLD_HERMES_TARBALL_SHA256}" \
  --build-arg "HERMES_UV_EXTRAS=messaging" \
  -f "${REPO_ROOT}/agents/hermes/Dockerfile.base" \
  -t "${OLD_BASE_TAG}" \
  "${REPO_ROOT}" \
  || fail "Failed to build old Hermes base image"

pass "Old Hermes base image built (${OLD_HERMES_VERSION})"

if [ "${STALE_BASE_REBUILD}" = "1" ]; then
  docker tag "${OLD_BASE_TAG}" "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest"
  pass "Cached Hermes base tag now points at old version"
fi

# ── Phase 3: Create old sandbox via openshell ───────────────────────
info "Phase 3: Creating sandbox with old Hermes via openshell..."

# Build a minimal Dockerfile — NOT the full agents/hermes/Dockerfile which
# patches files that may not exist in the old Hermes version.
TESTDIR=$(mktemp -d)
cat >"${TESTDIR}/Dockerfile" <<DOCKERFILE
FROM ${OLD_BASE_TAG}
USER sandbox
WORKDIR /sandbox
RUN mkdir -p /sandbox/.hermes/memories \
             /sandbox/.hermes/sessions \
             /sandbox/.hermes/workspace \
    && printf '%s\n' \
      '_config_version: 12' \
      'platforms:' \
      '  discord:' \
      '    enabled: true' \
      '    token: "${DISCORD_PLACEHOLDER}"' \
      '  api_server:' \
      '    enabled: true' \
      '    extra:' \
      '      port: 18642' \
      '      host: 127.0.0.1' \
      > /sandbox/.hermes/config.yaml \
    && printf '%s\n' \
      'API_SERVER_PORT=18642' \
      'API_SERVER_HOST=127.0.0.1' \
      'DISCORD_BOT_TOKEN=${DISCORD_PLACEHOLDER}' \
      > /sandbox/.hermes/.env
CMD ["/bin/bash"]
DOCKERFILE

DISCORD_BOT_TOKEN="${DISCORD_FAKE_TOKEN}" \
  openshell provider create --name "${SANDBOX_NAME}-discord-bridge" --type generic --credential DISCORD_BOT_TOKEN \
  >/dev/null 2>&1 || DISCORD_BOT_TOKEN="${DISCORD_FAKE_TOKEN}" \
  openshell provider update "${SANDBOX_NAME}-discord-bridge" --credential DISCORD_BOT_TOKEN \
  >/dev/null 2>&1
openshell sandbox create \
  --name "${SANDBOX_NAME}" \
  --from "${TESTDIR}/Dockerfile" \
  --gateway nemoclaw \
  --provider "${SANDBOX_NAME}-discord-bridge" \
  --no-tty \
  -- true
rm -rf "${TESTDIR}"

# Wait for Ready
for _i in $(seq 1 30); do
  if openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready"; then
    break
  fi
  sleep 5
done
openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready" || fail "Sandbox did not become Ready"

pass "Old Hermes sandbox created"

# ── Phase 4: Write markers + register ───────────────────────────────
info "Phase 4: Writing markers and registering sandbox..."

openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  sh -c "mkdir -p /sandbox/.hermes/memories && echo '${MARKER_CONTENT}' > ${MARKER_FILE}" \
  || fail "Failed to write marker file"

VERIFY=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat "${MARKER_FILE}" 2>/dev/null || true)
[ "$VERIFY" = "${MARKER_CONTENT}" ] || fail "Marker verification failed"
PRE_REBUILD_ENV=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat /sandbox/.hermes/.env 2>/dev/null || true)
echo "$PRE_REBUILD_ENV" | grep -Fq "DISCORD_BOT_TOKEN=${DISCORD_PLACEHOLDER}" \
  || fail "Pre-rebuild Hermes .env missing Discord placeholder"
PRE_REBUILD_CONFIG=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat /sandbox/.hermes/config.yaml 2>/dev/null || true)
echo "$PRE_REBUILD_CONFIG" | grep -Fq "discord:" \
  || fail "Pre-rebuild Hermes config.yaml missing platforms.discord"

# Register in NemoClaw registry
python3 -c "
import hashlib, json
reg = {'sandboxes': {'${SANDBOX_NAME}': {
    'name': '${SANDBOX_NAME}',
    'createdAt': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'model': 'nvidia/nemotron-3-super-120b-a12b',
    'provider': 'nvidia-prod',
    'gpuEnabled': False,
    'policies': [],
    'policyTier': None,
    'agent': 'hermes',
    'agentVersion': '${OLD_HERMES_REGISTRY_VERSION}',
    'messagingChannels': ['discord'],
    'providerCredentialHashes': {
        'DISCORD_BOT_TOKEN': hashlib.sha256('${DISCORD_FAKE_TOKEN}'.encode()).hexdigest()
    }
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
sess['agent'] = 'hermes'
sess['status'] = 'complete'
sess['messagingChannels'] = ['discord']
with open(sess_path, 'w') as f:
    json.dump(sess, f, indent=2)
print('Registry and session updated')
"

pass "Markers written, sandbox registered"

# ── Phase 5: Prepare current base-image cache state ─────────────────
if [ "${STALE_BASE_REBUILD}" = "1" ]; then
  info "Phase 5: Leaving cached Hermes base image stale..."
  diag "Cached ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest intentionally points at ${OLD_HERMES_VERSION}; rebuild must refresh it from agents/hermes/Dockerfile.base."
else
  info "Phase 5: Building current Hermes base image..."

  docker build \
    -f "${REPO_ROOT}/agents/hermes/Dockerfile.base" \
    -t "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest" \
    "${REPO_ROOT}" \
    || fail "Failed to build current Hermes base image"

  pass "Current Hermes base image built"
fi

# ── Phase 6: Rebuild ────────────────────────────────────────────────
info "Phase 6: Running nemoclaw rebuild..."
unset DISCORD_BOT_TOKEN

diag "Pre-rebuild state:"
diag "  Registry: $(python3 -c "import json; d=json.load(open('${REGISTRY_FILE}')); print(json.dumps({k: {'agent': v.get('agent'), 'agentVersion': v.get('agentVersion')} for k,v in d.get('sandboxes',{}).items()}))" 2>/dev/null)"
diag "  Session: $(python3 -c "import json; s=json.load(open('${SESSION_FILE}')); print(f'name={s.get(\"sandboxName\")} status={s.get(\"status\")} resumable={s.get(\"resumable\")} agent={s.get(\"agent\")} provider={s.get(\"provider\")}')" 2>/dev/null)"
diag "  Live sandboxes: $(openshell sandbox list 2>&1 | grep -v NAME || echo none)"
diag "  Gateway: $(docker ps --filter name=openshell --format '{{.Names}} {{.Status}}' 2>/dev/null || echo 'not running')"

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

# Actual Hermes binary version updated
HERMES_VERSION_OUTPUT=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- hermes --version 2>&1 || true)
diag "Hermes version after rebuild: ${HERMES_VERSION_OUTPUT//$'\n'/ | }"
if echo "${HERMES_VERSION_OUTPUT}" | grep -Fq "${OLD_HERMES_REGISTRY_VERSION}"; then
  fail "Hermes binary still reports old version ${OLD_HERMES_REGISTRY_VERSION}"
fi
if echo "${HERMES_VERSION_OUTPUT}" | grep -Fq "${EXPECTED_HERMES_VERSION}"; then
  pass "Hermes binary reports expected version ${EXPECTED_HERMES_VERSION}"
else
  fail "Hermes binary version mismatch: expected output to contain '${EXPECTED_HERMES_VERSION}'"
fi

# Hermes messaging config survived through non-interactive rebuild without
# requiring the Discord token to be re-exported on the host.
RESTORED_ENV=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat /sandbox/.hermes/.env 2>/dev/null || true)
if echo "$RESTORED_ENV" | grep -Fq "DISCORD_BOT_TOKEN=${DISCORD_PLACEHOLDER}"; then
  pass "Hermes .env preserved Discord token placeholder"
else
  fail "Hermes .env lost Discord placeholder after rebuild: ${RESTORED_ENV}"
fi

RESTORED_CONFIG=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat /sandbox/.hermes/config.yaml 2>/dev/null || true)
if echo "$RESTORED_CONFIG" | grep -Fq "discord:"; then
  pass "Hermes config.yaml preserved platforms.discord"
else
  fail "Hermes config.yaml lost platforms.discord after rebuild: ${RESTORED_CONFIG}"
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
  # Non-fatal — inference depends on external API availability and Hermes gateway being up
  info "Inference check inconclusive (may be API timeout or gateway not started): ${INFERENCE_RESPONSE:0:200}"
fi

# Registry updated
REGISTRY_VERSION=$(python3 -c "
import json
with open('${REGISTRY_FILE}') as f:
    data = json.load(f)
sb = data.get('sandboxes', {}).get('${SANDBOX_NAME}', {})
print(sb.get('agentVersion', 'null'))
" 2>/dev/null || echo "error")
if [ "$REGISTRY_VERSION" != "null" ] && [ "$REGISTRY_VERSION" != "error" ] && [ "$REGISTRY_VERSION" != "$OLD_HERMES_REGISTRY_VERSION" ]; then
  pass "Registry agentVersion updated to ${REGISTRY_VERSION}"
else
  fail "Registry agentVersion not updated: got '${REGISTRY_VERSION}', expected != '${OLD_HERMES_REGISTRY_VERSION}'"
fi

# No credentials in backup
BACKUP_DIR="$HOME/.nemoclaw/rebuild-backups/${SANDBOX_NAME}"
if [ -d "$BACKUP_DIR" ]; then
  CRED_LEAKS=$(find "$BACKUP_DIR" \( -name "*.json" -o -name "*.yaml" -o -name "*.env" -o -name ".env" \) -exec grep -l "nvapi-\|sk-\|Bearer " {} \; 2>/dev/null || true)
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
[[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || nemoclaw "${SANDBOX_NAME}" destroy --yes 2>/dev/null || true
docker rmi "${OLD_BASE_TAG}" 2>/dev/null || true

echo ""
if [ "${STALE_BASE_REBUILD}" = "1" ]; then
  echo -e "${GREEN}Hermes stale-base rebuild E2E passed.${NC}"
else
  echo -e "${GREEN}Hermes rebuild upgrade E2E passed.${NC}"
fi
