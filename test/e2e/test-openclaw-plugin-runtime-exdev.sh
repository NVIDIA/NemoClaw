#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Coverage guard for #3513 / #3127 — a fresh sandbox must be able to run the
# first OpenClaw CLI invocation without bundled plugin runtime-deps failing on
# EXDEV cross-device rename.

set -uo pipefail

PASS=0
FAIL=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  echo "  OK: $1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  echo "  ERROR: $1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-openclaw-plugin-exdev}"
ONBOARD_LOG="${E2E_OPENCLAW_PLUGIN_EXDEV_ONBOARD_LOG:-/tmp/nemoclaw-e2e-openclaw-plugin-exdev-onboard.log}"
AGENT_LOG="${E2E_OPENCLAW_PLUGIN_EXDEV_AGENT_LOG:-/tmp/nemoclaw-e2e-openclaw-plugin-exdev-agent.log}"
DF_LOG="${E2E_OPENCLAW_PLUGIN_EXDEV_DF_LOG:-/tmp/nemoclaw-e2e-openclaw-plugin-exdev-df.log}"
TIMEOUT_CMD="${TIMEOUT_CMD:-timeout}"

# shellcheck source=test/e2e/lib/install-path-refresh.sh
. "${SCRIPT_DIR}/lib/install-path-refresh.sh"
# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "${SCRIPT_DIR}/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

redact_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  python3 - "$file" <<'PY'
import os, sys
path = sys.argv[1]
secrets = [os.environ.get("NVIDIA_API_KEY", ""), os.environ.get("NEMOCLAW_PROVIDER_KEY", "")]
text = open(path, "r", errors="replace").read()
for secret in filter(None, secrets):
    text = text.replace(secret, "<REDACTED>")
open(path, "w").write(text)
PY
}

redact_logs() {
  redact_file "$ONBOARD_LOG"
  redact_file "$AGENT_LOG"
  redact_file "$DF_LOG"
}
trap redact_logs EXIT

section "Prerequisites"
if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set"
else
  fail "NVIDIA_API_KEY is required and must start with nvapi-"
  exit 1
fi

section "Install NemoClaw from checkout"
if ! command -v nemoclaw >/dev/null 2>&1; then
  NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    bash "${REPO}/install.sh" --non-interactive --yes-i-accept-third-party-software >"$ONBOARD_LOG" 2>&1 || true
  nemoclaw_refresh_install_env
fi

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw is available: $(nemoclaw --version 2>/dev/null || echo unknown)"
else
  fail "nemoclaw not found after install"
  exit 1
fi

section "Fresh sandbox onboard"
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true

python3 - "${REPO}" <<'PY'
import sys
from pathlib import Path
repo = Path(sys.argv[1])
policy_paths = [
    repo / "agents/openclaw/policy-permissive.yaml",
    repo / "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
    repo / "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
]
for path in policy_paths:
    text = path.read_text()
    needle = "  read_write:\n    - /tmp\n"
    if needle not in text:
        raise SystemExit(f"could not find read_write /tmp anchor in {path}")
    additions = ""
    for entry in ["/dev", "/dev/shm"]:
        if f"    - {entry}\n" not in text:
            additions += f"    - {entry}\n"
    if additions:
        path.write_text(text.replace(needle, needle + additions, 1))
PY
env \
  NEMOCLAW_PROVIDER_KEY="$NVIDIA_API_KEY" \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_POLICY_MODE="skip" \
  NEMOCLAW_PROVIDER="build" \
  NVIDIA_API_KEY="$NVIDIA_API_KEY" \
  "$TIMEOUT_CMD" 1500 nemoclaw onboard --fresh --non-interactive --yes-i-accept-third-party-software --agent openclaw --from "$REPO/Dockerfile" \
  >"$ONBOARD_LOG" 2>&1
onboard_rc=$?
redact_logs
if [ "$onboard_rc" -eq 0 ]; then
  pass "fresh sandbox onboard completed"
else
  fail "fresh sandbox onboard failed (exit ${onboard_rc}); see ${ONBOARD_LOG}"
  exit 1
fi

section "Filesystem layout evidence"
openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc 'df -PT / /tmp /dev/shm /sandbox /sandbox/.openclaw/plugin-runtime-deps 2>&1' \
  >"$DF_LOG" 2>&1 || true
redact_logs
info "Filesystem layout captured in ${DF_LOG}"

section "Bundled plugin runtime-deps cross-device replacement"
agent_rc=0
# Reproduce the precise #3513 failure mode without depending on OpenClaw's
# broader CLI temp/log initialization: the vulnerable helper copies dependency
# contents into a staging dir adjacent to the source and then renameSyncs that
# staged node_modules dir into the final plugin-runtime-deps target. When source
# is on tmpfs (/dev/shm) and target is under /sandbox, unfixed code throws EXDEV.
remote_script_b64=$(
  cat <<'REMOTE' | base64 | tr -d '\n'
set -eu
rm -rf /sandbox/.openclaw/plugin-runtime-deps/exdev-guard 2>/dev/null || true
rm -rf /dev/shm/nemoclaw-exdev-source 2>/dev/null || true
mkdir -p /dev/shm/nemoclaw-exdev-source
printf 'ok\n' >/dev/shm/nemoclaw-exdev-source/package.txt
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
function replaceNodeModulesDir(targetDir, sourceDir) {
  const parentDir = path.dirname(sourceDir);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(parentDir, '.openclaw-runtime-deps-copy-'));
  const stagedDir = path.join(tempDir, 'node_modules');
  try {
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}
replaceNodeModulesDir('/sandbox/.openclaw/plugin-runtime-deps/exdev-guard/node_modules', '/dev/shm/nemoclaw-exdev-source');
console.log('runtime deps replacement completed');
NODE
REMOTE
)
remote_cmd="printf '%s' '${remote_script_b64}' | base64 -d > /tmp/nemoclaw-exdev-guard.sh && sh /tmp/nemoclaw-exdev-guard.sh"
"$TIMEOUT_CMD" 60 openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$remote_cmd" \
  >"$AGENT_LOG" 2>&1 || agent_rc=$?
redact_logs

if grep -qiE 'EXDEV: cross-device link not permitted|cross-device link not permitted' "$AGENT_LOG"; then
  fail "OpenClaw-style plugin runtime deps replacement hit #3513 EXDEV failure"
  info "Runtime-deps log excerpt: $(grep -iE 'EXDEV|cross-device link not permitted' "$AGENT_LOG" | head -5 | tr '\n' ' ')"
  exit 1
fi

if [ "$agent_rc" -ne 0 ]; then
  fail "runtime deps replacement exited ${agent_rc}; see ${AGENT_LOG}"
  exit 1
fi

if grep -q 'runtime deps replacement completed' "$AGENT_LOG"; then
  pass "OpenClaw-style plugin runtime-deps replacement completed across filesystems"
else
  fail "runtime deps replacement exited 0 but success marker was missing; see ${AGENT_LOG}"
  exit 1
fi

section "Summary"
if [ "$FAIL" -eq 0 ]; then
  pass "OpenClaw plugin runtime-deps EXDEV guard passed"
  exit 0
fi
exit 1
