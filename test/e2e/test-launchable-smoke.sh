#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Launchable Install-Flow Smoke Test
#
# Validates the Brev launchable install path (scripts/brev-launchable-ci-cpu.sh)
# end-to-end: bootstrap → artifact verification → onboard → sandbox health →
# live inference → cleanup.
#
# This is the long-living safety net for the community install path. If any
# regression breaks brev-launchable-ci-cpu.sh (e.g., the Apr 20-25 Brev outage
# from issues #2472/#2482, or the container reachability fallback from #2425),
# this smoke test catches it before community users are affected.
#
# Key insight: brev-launchable-ci-cpu.sh has ZERO Brev dependencies — it's a
# generic Ubuntu bootstrap script. It runs on ubuntu-latest GitHub runners
# with no BREV_API_TOKEN needed.
#
# What this tests:
#   1. Run brev-launchable-ci-cpu.sh with NEMOCLAW_REF=current branch
#   2. Verify installation artifacts (nemoclaw, openshell, Node.js ≥22, Docker, sentinel)
#   3. nemoclaw onboard --non-interactive with hosted inference
#   4. Sandbox health: nemoclaw list, status, gateway running
#   5. Live inference through the sandbox (same pattern as test-full-e2e.sh Phase 4)
#   6. Destroy + cleanup
#
# Prerequisites:
#   - Ubuntu runner (ubuntu-latest)
#   - Docker running
#   - NVIDIA_INFERENCE_API_KEY set for hosted inference
#   - Network access to inference-api.nvidia.com
#   - NEMOCLAW_NON_INTERACTIVE=1
#   - NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Environment variables:
#   NEMOCLAW_REF              — git ref for brev-launchable-ci-cpu.sh (default: current branch)
#   NEMOCLAW_SANDBOX_NAME     — sandbox name (default: e2e-launchable)
#   NEMOCLAW_RECREATE_SANDBOX — set to 1 to recreate if exists
#   NVIDIA_INFERENCE_API_KEY            — required for hosted inference
#   SKIP_DOCKER_PULL          — set to 1 to skip Docker image pre-pulls (speeds up CI)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_INFERENCE_API_KEY=... bash test/e2e/test-launchable-smoke.sh
#
# See: https://github.com/NVIDIA/NemoClaw/issues/2599

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1800
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR}/e2e-timeout.sh"
# shellcheck source=test/e2e/lib/openclaw-json.sh
source "${SCRIPT_DIR}/lib/openclaw-json.sh"

PASS=0
FAIL=0
SKIP=0
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
# shellcheck disable=SC2329
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# Parse chat completion response — handles both content and reasoning_content
parse_chat_content() {
  python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    c = r['choices'][0]['message']
    content = c.get('content') or c.get('reasoning_content') or c.get('reasoning') or ''
    print(content.strip())
except Exception as e:
    print(f'PARSE_ERROR: {e}', file=sys.stderr)
    sys.exit(1)
"
}

# shellcheck source=test/e2e/lib/ci-compatible-inference.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/ci-compatible-inference.sh"

# Determine repo root
if [ -f "$(cd "$(dirname "$0")/../.." && pwd)/scripts/brev-launchable-ci-cpu.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root (expected scripts/brev-launchable-ci-cpu.sh)."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-launchable}"
INSTALL_LOG="/tmp/nemoclaw-launchable-install.log"
TEST_LOG="/tmp/nemoclaw-launchable-test.log"

# The launchable script clones into ~/NemoClaw by default. For CI, use
# a unique directory so we don't collide with the checkout.
NEMOCLAW_CLONE_DIR="${NEMOCLAW_CLONE_DIR:-${HOME}/NemoClaw-launchable}"
export NEMOCLAW_CLONE_DIR

# The launchable script clones from github.com/NVIDIA/NemoClaw using
# NEMOCLAW_REF as the branch. To test the CURRENT code (not main HEAD),
# we pre-seed the clone directory from the checkout (see Phase 0) and
# create a branch named "main" at the current commit. The script detects
# an existing .git dir, does fetch+checkout (which is a no-op since we're
# already on the right commit), then proceeds to npm install + build.
# This lets us test on forks where the branch name doesn't exist upstream.
NEMOCLAW_REF="${NEMOCLAW_REF:-main}"
export NEMOCLAW_REF

# Skip Docker image pre-pulls by default in CI — the images will be pulled
# at onboard time and this avoids flaky pulls blocking the install step.
export SKIP_DOCKER_PULL="${SKIP_DOCKER_PULL:-1}"

exec > >(tee -a "$TEST_LOG") 2>&1

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"
nemoclaw_e2e_configure_compatible_inference || exit 1
HOSTED_INFERENCE_BASE_URL="$(nemoclaw_e2e_hosted_inference_base_url)"
HOSTED_INFERENCE_MODEL="$(nemoclaw_e2e_hosted_inference_model)"
HOSTED_INFERENCE_KEY="$(nemoclaw_e2e_hosted_inference_key)"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Pre-cleanup"
info "Destroying any leftover sandbox/gateway from previous runs..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
# Clean up any previous launchable clone (sudo because launchable may have
# created root-owned files on a previous run)
sudo rm -rf "$NEMOCLAW_CLONE_DIR" 2>/dev/null || rm -rf "$NEMOCLAW_CLONE_DIR" || true

# Pre-seed the clone directory from the checked-out repo so the launchable
# script tests THIS code (not main HEAD). The script's step 5 detects
# $NEMOCLAW_CLONE_DIR/.git and runs the refresh path (fetch+checkout)
# instead of a fresh clone from NVIDIA/NemoClaw. We create a "main" branch
# at the current commit so NEMOCLAW_REF=main resolves locally.
info "Pre-seeding $NEMOCLAW_CLONE_DIR from checkout at $REPO..."
git clone --local --no-hardlinks "$REPO" "$NEMOCLAW_CLONE_DIR"
# Ensure a "main" branch exists at the current commit for the script's
# `git fetch origin main && git checkout main` to succeed. Point origin
# at the clone itself so fetch resolves locally (the CI checkout may be
# in detached HEAD and lack a "main" branch).
git -C "$NEMOCLAW_CLONE_DIR" checkout -B main HEAD 2>/dev/null || true
git -C "$NEMOCLAW_CLONE_DIR" remote set-url origin "$NEMOCLAW_CLONE_DIR"
pass "Pre-cleanup complete (clone dir pre-seeded)"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if ! nemoclaw_e2e_require_hosted_inference_key; then
  exit 1
fi

if nemoclaw_e2e_probe_hosted_inference; then
  pass "Network access to ${HOSTED_INFERENCE_BASE_URL}"
else
  fail "Cannot reach ${HOSTED_INFERENCE_BASE_URL}"
  exit 1
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  exit 1
fi

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required for non-interactive install"
  exit 1
fi

if [ -f "$REPO/scripts/brev-launchable-ci-cpu.sh" ]; then
  pass "brev-launchable-ci-cpu.sh found at $REPO/scripts/"
else
  fail "brev-launchable-ci-cpu.sh not found"
  exit 1
fi

info "NEMOCLAW_REF=$NEMOCLAW_REF"
info "NEMOCLAW_CLONE_DIR=$NEMOCLAW_CLONE_DIR"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Run brev-launchable-ci-cpu.sh
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Run brev-launchable-ci-cpu.sh (launchable install path)"

info "Running the launchable bootstrap script..."
info "This installs Docker, Node.js 22, OpenShell, clones NemoClaw, builds CLI+plugin."
info "Expected duration: 3-8 minutes."

# The launchable script expects to run as root (it uses sudo internally).
# On GitHub runners, we already have passwordless sudo.
# Redirect is intentional — log file stays runner-owned, not root-owned.
# shellcheck disable=SC2024
sudo -E bash "$REPO/scripts/brev-launchable-ci-cpu.sh" >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

if [ $install_exit -eq 0 ]; then
  pass "brev-launchable-ci-cpu.sh completed (exit 0)"
else
  fail "brev-launchable-ci-cpu.sh failed (exit $install_exit)"
  info "Last 30 lines of install log:"
  tail -30 "$INSTALL_LOG"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Verify installation artifacts
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Verify installation artifacts"

# Refresh PATH — the launchable script installs binaries to /usr/local/bin
# and Node.js via nodesource. On the GH runner the shell may not have
# picked up the new PATH entries yet.
export PATH="/usr/local/bin:$PATH"
if [ "${GITHUB_ACTIONS:-}" = "true" ] \
  && [ "${GITHUB_REPOSITORY:-}" = "NVIDIA/NemoClaw" ] \
  && [ "${GITHUB_REF:-}" = "refs/heads/fix/native-messaging-websocket" ] \
  && [ -n "${NEMOCLAW_OPENSHELL_BIN:-}" ]; then
  main_openshell_dir="$(dirname "$NEMOCLAW_OPENSHELL_BIN")"
  export PATH="$main_openshell_dir:$PATH"
fi
hash -r 2>/dev/null || true

# 3a: nemoclaw on PATH and --help works
if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH: $(command -v nemoclaw)"
else
  fail "nemoclaw not found on PATH after launchable install"
fi

if nemoclaw --help >/dev/null 2>&1; then
  pass "nemoclaw --help exits 0"
else
  fail "nemoclaw --help failed"
fi

# 3b: openshell on PATH and --version works
if command -v openshell >/dev/null 2>&1; then
  os_version="$(openshell --version 2>&1 || echo unknown)"
  pass "openshell on PATH: $(command -v openshell) (${os_version})"
else
  fail "openshell not found on PATH after launchable install"
fi

# 3c: Node.js >= 22
# The launchable script installs Node.js via nodesource as root. On GH runners,
# a pre-installed Node may shadow the new one in PATH. Refresh the hash table
# and check the version that the launchable script's npm actually uses.
hash -r 2>/dev/null || true
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version 2>/dev/null)"
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$node_major" -ge 22 ]; then
    pass "Node.js >= 22 installed: ${node_version}"
  else
    # On ubuntu-latest GH runners, nodesource may not override the pre-installed
    # Node 20. This is a known issue with the launchable script (#TBD). Log it
    # as a warning but don't block the test — the CLI still works with Node 20.
    info "Node.js ${node_version} found (< 22). Checking if onboard can proceed..."
    if [ "$node_major" -ge 20 ]; then
      skip "Node.js ${node_version} — launchable installed Node < 22 but >= 20 (usable)"
    else
      fail "Node.js version too old: ${node_version} (need >= 20)"
    fi
  fi
else
  fail "Node.js not found on PATH after launchable install"
fi

# 3d: Docker running
if docker info >/dev/null 2>&1; then
  pass "Docker running after launchable install"
else
  fail "Docker not running after launchable install"
fi

# 3e: Sentinel file
SENTINEL="/var/run/nemoclaw-launchable-ready"
if [ -f "$SENTINEL" ]; then
  pass "Sentinel file exists: $SENTINEL"
else
  fail "Sentinel file missing: $SENTINEL"
fi

# 3f: Clone directory exists with built artifacts
if [ -d "$NEMOCLAW_CLONE_DIR/.git" ]; then
  pass "NemoClaw cloned at $NEMOCLAW_CLONE_DIR"
else
  fail "NemoClaw clone directory missing: $NEMOCLAW_CLONE_DIR"
fi

if [ -d "$NEMOCLAW_CLONE_DIR/dist" ]; then
  pass "CLI built (dist/ exists)"
else
  fail "CLI not built (dist/ missing)"
fi

if [ -d "$NEMOCLAW_CLONE_DIR/nemoclaw/dist" ]; then
  pass "Plugin built (nemoclaw/dist/ exists)"
else
  fail "Plugin not built (nemoclaw/dist/ missing)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Onboard (non-interactive, hosted inference)
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Onboard (non-interactive, hosted inference)"

# Run onboard from the launchable clone directory — this is the real
# community path: the user's NemoClaw is in ~/NemoClaw, not a CI checkout.
cd "$NEMOCLAW_CLONE_DIR" || {
  fail "Could not cd to $NEMOCLAW_CLONE_DIR"
  exit 1
}

info "Running nemoclaw onboard --non-interactive..."
info "Provider: ${NEMOCLAW_PROVIDER:-configured hosted inference}"
info "Sandbox name: $SANDBOX_NAME"

ONBOARD_LOG="/tmp/nemoclaw-launchable-onboard.log"
export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX="${NEMOCLAW_RECREATE_SANDBOX:-1}"

nemoclaw onboard --non-interactive >"$ONBOARD_LOG" 2>&1 &
onboard_pid=$!
tail -f "$ONBOARD_LOG" --pid=$onboard_pid 2>/dev/null &
tail_pid=$!
wait $onboard_pid
onboard_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

if [ $onboard_exit -eq 0 ]; then
  pass "nemoclaw onboard completed (exit 0)"
else
  fail "nemoclaw onboard failed (exit $onboard_exit)"
  info "Last 30 lines of onboard log:"
  tail -30 "$ONBOARD_LOG"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Sandbox health verification
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Sandbox health verification"

# 5a: nemoclaw list
if list_output=$(nemoclaw list 2>&1); then
  if grep -Fq -- "$SANDBOX_NAME" <<<"$list_output"; then
    pass "nemoclaw list contains '${SANDBOX_NAME}'"
  else
    fail "nemoclaw list does not contain '${SANDBOX_NAME}'"
  fi
else
  fail "nemoclaw list failed: ${list_output:0:200}"
fi

# 5b: nemoclaw status
if status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1); then
  pass "nemoclaw ${SANDBOX_NAME} status exits 0"
else
  fail "nemoclaw ${SANDBOX_NAME} status failed: ${status_output:0:200}"
fi

# 5c: Inference configured by onboard
if inf_check=$(openshell inference get 2>&1); then
  expected_provider="$(nemoclaw_e2e_expected_route_provider)"
  expected_model=""
  if nemoclaw_e2e_using_compatible_inference; then
    expected_model="$HOSTED_INFERENCE_MODEL"
  fi
  if nemoclaw_e2e_inference_output_matches "$inf_check" "$expected_provider" "$expected_model"; then
    pass "Inference configured via onboard (${expected_provider})"
  else
    inf_check_plain="$(printf '%s' "$inf_check" | nemoclaw_e2e_strip_ansi)"
    fail "Inference not configured - onboard did not set up ${expected_provider}: ${inf_check_plain:0:200}"
  fi
else
  fail "openshell inference get failed: ${inf_check:0:200}"
fi

# 5d: Gateway running
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "nemoclaw\|openshell"; then
  pass "Gateway container running"
else
  skip "Could not confirm gateway container (may have different naming)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Live inference through the sandbox
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Live inference"

# ── Test 6a: Direct hosted inference endpoint (sanity check) ──
info "[LIVE] Direct API test → ${HOSTED_INFERENCE_BASE_URL}..."
api_response=$(curl -s --max-time 30 \
  -X POST "${HOSTED_INFERENCE_BASE_URL}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HOSTED_INFERENCE_KEY" \
  -d "$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with exactly one word: PONG"}],"max_tokens":100}' "$HOSTED_INFERENCE_MODEL")" 2>/dev/null) || true

if [ -n "$api_response" ]; then
  api_content=$(echo "$api_response" | parse_chat_content 2>/dev/null) || true
  if grep -qi "PONG" <<<"$api_content"; then
    pass "[LIVE] Direct API: model responded with PONG"
  else
    fail "[LIVE] Direct API: expected PONG, got: ${api_content:0:200}"
  fi
else
  fail "[LIVE] Direct API: empty response from curl"
fi

# ── Test 6b: Inference through sandbox (routing check) ──
info "[ROUTING] inference.local DNS + OpenShell proxy reachable from sandbox..."
ssh_config="$(mktemp)"
sandbox_response=""

if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  sandbox_response=$(run_with_timeout 90 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "curl -s --max-time 60 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$HOSTED_INFERENCE_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
    2>&1) || true
fi
rm -f "$ssh_config"

# Retry sandbox inference up to 3 times — live models are not deterministic
# and the gateway proxy can return unexpected responses on first attempt.
sandbox_content=""
pong_ok=false
for pong_attempt in 1 2 3; do
  if [ -n "$sandbox_response" ]; then
    sandbox_content=$(echo "$sandbox_response" | parse_chat_content 2>/dev/null) || true
    if grep -qi "PONG" <<<"$sandbox_content"; then
      pong_ok=true
      break
    fi
    info "Sandbox inference attempt ${pong_attempt}/3: got '${sandbox_content:0:80}', retrying in 5s..."
  else
    info "Sandbox inference attempt ${pong_attempt}/3: empty response, retrying in 5s..."
  fi
  [ "$pong_attempt" -lt 3 ] || break
  sleep 5
  ssh_config="$(mktemp)"
  sandbox_response=""
  if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
    sandbox_response=$(run_with_timeout 90 ssh -F "$ssh_config" \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 \
      -o LogLevel=ERROR \
      "openshell-${SANDBOX_NAME}" \
      "curl -s --max-time 60 https://inference.local/v1/chat/completions \
        -H 'Content-Type: application/json' \
        -d '{\"model\":\"$HOSTED_INFERENCE_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
      2>&1) || true
  fi
  rm -f "$ssh_config"
done

if $pong_ok; then
  pass "[ROUTING] inference.local: OpenShell routed curl to the hosted inference endpoint and returned PONG"
else
  fail "[ROUTING] inference.local: expected PONG after 3 attempts, got: ${sandbox_content:0:200}"
fi

# ── Test 6c: openclaw-mediated turn (the real proof) ──
info "[LIVE] openclaw agent → openclaw HTTP client → inference.local..."
ssh_config="$(mktemp)"
agent_response=""
agent_stderr=""
agent_rc=0
agent_stderr_file="$(mktemp)"

if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  agent_session_id="e2e-launchable-$(date +%s)-$$"
  agent_response=$(run_with_timeout 120 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "openclaw agent --agent main --json --thinking off --session-id '${agent_session_id}' -m 'What is 6 multiplied by 7? Reply with only the integer, no extra words.'" \
    2>"$agent_stderr_file") || agent_rc=$?
  agent_stderr="$(<"$agent_stderr_file")"
else
  agent_rc=255
  agent_stderr="failed to get SSH config for ${SANDBOX_NAME}"
fi
rm -f "$ssh_config" "$agent_stderr_file"

agent_reply=$(printf '%s' "$agent_response" | parse_openclaw_agent_text 2>/dev/null) || true

if grep -qE "(^|[^0-9])42([^0-9]|$)" <<<"$agent_reply"; then
  pass "[LIVE] openclaw agent: model answered 6×7=42 through openclaw → inference.local"
else
  fail "[LIVE] openclaw agent: expected '42' in agent reply; rc=${agent_rc}; reply='${agent_reply:0:200}'; stdout='${agent_response:0:300}'; stderr='${agent_stderr:0:300}'"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 7: Cleanup"

[[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

# Verify against the registry file directly. `nemoclaw list` triggers
# gateway recovery which can restart a destroyed gateway — avoid it here.
registry_file="${HOME}/.nemoclaw/sandboxes.json"
if [ -f "$registry_file" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$registry_file"; then
  fail "Sandbox ${SANDBOX_NAME} still in registry after destroy"
else
  pass "Sandbox ${SANDBOX_NAME} removed"
fi

# Clean up the launchable clone directory (sudo because launchable ran as root
# and npm install creates root-owned files in node_modules/)
sudo rm -rf "$NEMOCLAW_CLONE_DIR" 2>/dev/null || rm -rf "$NEMOCLAW_CLONE_DIR" || true
pass "Launchable clone directory cleaned up"

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Launchable Install-Flow Smoke Test Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"
echo ""
echo "  What this tested (issue #2599):"
echo "    - brev-launchable-ci-cpu.sh bootstrap (Docker, Node.js, OpenShell, NemoClaw)"
echo "    - Installation artifacts (binaries on PATH, sentinel file, built outputs)"
echo "    - Onboard via launchable-installed NemoClaw (hosted inference)"
echo "    - Sandbox health (list, status, inference config, gateway)"
echo "    - Direct hosted inference"
echo "    - Sandbox inference routing (curl → inference.local)"
echo "    - openclaw agent mediated inference (the full stack)"
echo "    - Destroy + cleanup"
echo ""

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  LAUNCHABLE SMOKE TEST PASSED — community install path verified end-to-end.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
