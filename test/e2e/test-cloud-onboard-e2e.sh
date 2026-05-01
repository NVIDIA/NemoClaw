#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Cloud Onboard E2E — Install via public URL + sandbox health + security
#
# Tests the public installer flow (curl nvidia.com/nemoclaw.sh | bash),
# verifies the sandbox is healthy, checks Landlock read-only enforcement,
# API key leak detection, and inference.local HTTPS.
#
# Split from the cloud-experimental-e2e monolith (see #2644).
# Former phases: 0 (pre-cleanup), 1 (prereqs), 3 (install), 5 (checks/*.sh), 6 (cleanup).
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment:
#   NEMOCLAW_NON_INTERACTIVE=1                         — required for non-interactive install
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1             — required for non-interactive install
#   NEMOCLAW_SANDBOX_NAME                              — sandbox name (default: e2e-cloud-onboard)
#   NEMOCLAW_RECREATE_SANDBOX=1                        — recreate if exists
#   NEMOCLAW_POLICY_MODE=custom                        — custom policy mode
#   NEMOCLAW_POLICY_PRESETS=npm,pypi                   — policy presets
#   RUN_E2E_CLOUD_ONBOARD_INTERACTIVE_INSTALL=0        — set 0 for non-interactive (default), 1 for expect
#   NEMOCLAW_INSTALL_SCRIPT_URL                        — override public installer URL
#   NEMOCLAW_INSTALL_REF                               — Git ref cloned by public installer
#   NEMOCLAW_PUBLIC_INSTALL_CWD                        — override temp cwd for public install
#   E2E_CLOUD_ONBOARD_INSTALL_LOG                      — install log path
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-cloud-onboard-e2e.sh

set -uo pipefail

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

# ── Repo root ──
_script_dir="$(cd "$(dirname "$0")" && pwd)"
_candidate="$(cd "${_script_dir}/../.." && pwd)"
if [ -d /workspace ] && [ -f /workspace/package.json ] && [ -d /workspace/test/e2e ]; then
  REPO="/workspace"
elif [ -f "${_candidate}/package.json" ] && [ -d "${_candidate}/test/e2e" ]; then
  REPO="${_candidate}"
else
  echo "ERROR: Cannot find repo root (expected package.json and test/e2e at checkout root)."
  exit 1
fi
unset _script_dir _candidate

E2E_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_CHECKS_DIR="${E2E_DIR}/e2e-cloud-experimental/checks"
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-onboard}"
CLOUD_MODEL="${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
INSTALL_LOG="${E2E_CLOUD_ONBOARD_INSTALL_LOG:-/tmp/nemoclaw-e2e-cloud-onboard-install.log}"
INTERACTIVE_INSTALL="${RUN_E2E_CLOUD_ONBOARD_INTERACTIVE_INSTALL:-0}"
PUBLIC_INSTALL_CWD="${NEMOCLAW_PUBLIC_INSTALL_CWD:-}"

# Source shared teardown helper
# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "${E2E_DIR}/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# ══════════════════════════════════════════════════════════════════════
# Phase 1: Pre-cleanup
# ══════════════════════════════════════════════════════════════════════
section "Phase 1: Pre-cleanup"

info "Destroying leftover sandbox, forwards, and gateway for '${SANDBOX_NAME}'..."
SANDBOX_NAME="$SANDBOX_NAME" bash "${E2E_DIR}/e2e-cloud-experimental/cleanup.sh" 2>/dev/null || true
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════════
# Phase 2: Prerequisites
# ══════════════════════════════════════════════════════════════════════
section "Phase 2: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set (starts with nvapi-)"
else
  fail "NVIDIA_API_KEY not set or invalid — required for cloud onboard"
  exit 1
fi

if curl -sf --max-time 10 https://integrate.api.nvidia.com/v1/models >/dev/null 2>&1; then
  pass "Network access to integrate.api.nvidia.com"
else
  fail "Cannot reach integrate.api.nvidia.com"
  exit 1
fi

if [ "$INTERACTIVE_INSTALL" != "1" ]; then
  if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
    fail "NEMOCLAW_NON_INTERACTIVE=1 is required for non-interactive install"
    exit 1
  fi
  if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
    fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required for non-interactive install"
    exit 1
  fi
  pass "Non-interactive mode configured"
else
  skip "Interactive install mode not supported in split tests (use non-interactive)"
fi

if [[ "$(uname -s)" == "Linux" ]]; then
  pass "Host OS is Linux"
else
  skip "Host is not Linux — test nominally targets Ubuntu (continuing)"
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 3: Install via public URL
# ══════════════════════════════════════════════════════════════════════
section "Phase 3: Install via public URL"

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_EXPERIMENTAL=1
export NEMOCLAW_PROVIDER=cloud
export NEMOCLAW_MODEL="$CLOUD_MODEL"
export NEMOCLAW_POLICY_MODE="${NEMOCLAW_POLICY_MODE:-custom}"
export NEMOCLAW_POLICY_PRESETS="${NEMOCLAW_POLICY_PRESETS:-npm,pypi}"

PUBLIC_INSTALL_REF="${NEMOCLAW_PUBLIC_INSTALL_REF:-${GITHUB_SHA:-}}"
if [ -n "$PUBLIC_INSTALL_REF" ]; then
  export NEMOCLAW_INSTALL_REF="$PUBLIC_INSTALL_REF"
  export NEMOCLAW_INSTALL_TAG="$PUBLIC_INSTALL_REF"
fi
if [ -z "${NEMOCLAW_INSTALL_SCRIPT_URL:-}" ] && [ -n "$PUBLIC_INSTALL_REF" ]; then
  NEMOCLAW_INSTALL_SCRIPT_URL="https://raw.githubusercontent.com/NVIDIA/NemoClaw/${PUBLIC_INSTALL_REF}/install.sh"
else
  NEMOCLAW_INSTALL_SCRIPT_URL="${NEMOCLAW_INSTALL_SCRIPT_URL:-https://www.nvidia.com/nemoclaw.sh}"
fi
export NEMOCLAW_INSTALL_SCRIPT_URL

info "Model: ${CLOUD_MODEL}, Policy: ${NEMOCLAW_POLICY_MODE} ${NEMOCLAW_POLICY_PRESETS}"
if [ -n "${NEMOCLAW_INSTALL_REF:-}" ]; then
  info "Public installer will clone NemoClaw ref: ${NEMOCLAW_INSTALL_REF}"
else
  info "Public installer will clone NemoClaw ref: latest"
fi

if [ "$INTERACTIVE_INSTALL" = "1" ]; then
  # Interactive install via expect is not currently supported in the split
  # tests. The original monolith inlined the expect heredoc; the standalone
  # wrapper (expect-interactive-install.sh) was never self-contained.
  # TODO(#2644): re-implement interactive install if needed.
  fail "Interactive install (RUN_E2E_CLOUD_ONBOARD_INTERACTIVE_INSTALL=1) is not yet supported — use non-interactive mode"
  exit 1
else
  if [ -z "$PUBLIC_INSTALL_CWD" ]; then
    PUBLIC_INSTALL_CWD="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-public-install.XXXXXX")"
  else
    mkdir -p "$PUBLIC_INSTALL_CWD"
  fi
  info "Installing (non-interactive): curl -fsSL ${NEMOCLAW_INSTALL_SCRIPT_URL} | bash"
  info "Public install cwd: ${PUBLIC_INSTALL_CWD}"
  (
    cd "$PUBLIC_INSTALL_CWD" || exit 1
    curl -fsSL "$NEMOCLAW_INSTALL_SCRIPT_URL" | bash
  ) >"$INSTALL_LOG" 2>&1 &
  install_pid=$!
  tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
  tail_pid=$!
  wait "$install_pid"
  install_exit=$?
  kill "$tail_pid" 2>/dev/null || true
  wait "$tail_pid" 2>/dev/null || true
fi

# Source shell profile to pick up nvm/PATH changes
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ "$install_exit" -eq 0 ]; then
  pass "Public install completed (exit 0)"
else
  fail "Public install failed (exit $install_exit)"
  info "Last 30 lines of install log:"
  tail -30 "$INSTALL_LOG"
  exit 1
fi

if grep -q "NemoClaw package.json found in the selected source checkout" "$INSTALL_LOG"; then
  fail "Public install unexpectedly used the local source checkout"
  info "Last 30 lines of install log:"
  tail -30 "$INSTALL_LOG"
  exit 1
fi

if grep -q "Installing NemoClaw from GitHub" "$INSTALL_LOG" \
  && grep -q "Resolved install ref:" "$INSTALL_LOG" \
  && grep -q "Cloning NemoClaw source" "$INSTALL_LOG"; then
  pass "Public install used the GitHub clone path"
else
  fail "Public install did not show the GitHub clone path"
  info "Last 40 lines of install log:"
  tail -40 "$INSTALL_LOG"
  exit 1
fi

if [ -n "$PUBLIC_INSTALL_REF" ]; then
  if grep -q "Resolved install ref: ${PUBLIC_INSTALL_REF}" "$INSTALL_LOG"; then
    pass "Public install used requested ref ${PUBLIC_INSTALL_REF}"
  else
    fail "Public install did not use requested ref ${PUBLIC_INSTALL_REF}"
    info "Last 40 lines of install log:"
    tail -40 "$INSTALL_LOG"
    exit 1
  fi
fi

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH ($(command -v nemoclaw))"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell on PATH ($(openshell --version 2>&1 || echo unknown))"
else
  fail "openshell not found on PATH after install"
  exit 1
fi

if nemoclaw --help >/dev/null 2>&1; then
  pass "nemoclaw --help exits 0"
else
  fail "nemoclaw --help failed"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 4: Sandbox checks suite
# ══════════════════════════════════════════════════════════════════════
section "Phase 4: Sandbox checks (Landlock, security, inference.local)"

export SANDBOX_NAME CLOUD_EXPERIMENTAL_MODEL="$CLOUD_MODEL" REPO NVIDIA_API_KEY
export PATH="/usr/local/bin:${HOME}/.local/bin:${PATH}"

shopt -s nullglob
case_scripts=("$E2E_CHECKS_DIR"/*.sh)
shopt -u nullglob

if [ "${#case_scripts[@]}" -eq 0 ]; then
  skip "No checks scripts in ${E2E_CHECKS_DIR}"
else
  info "Running ${#case_scripts[@]} check script(s) from ${E2E_CHECKS_DIR}"
  for case_script in "${case_scripts[@]}"; do
    info "Running $(basename "$case_script")..."
    set +e
    bash "$case_script"
    c_rc=$?
    set -uo pipefail
    if [ "$c_rc" -eq 0 ]; then
      pass "$(basename "$case_script" .sh)"
    else
      fail "$(basename "$case_script" .sh) exited ${c_rc}"
      exit 1
    fi
  done
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5: Cleanup
# ══════════════════════════════════════════════════════════════════════
section "Phase 5: Cleanup"

if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]; then
  skip "Cleanup skipped (NEMOCLAW_E2E_KEEP_SANDBOX=1)"
else
  info "Destroying sandbox '${SANDBOX_NAME}'..."
  if ! SANDBOX_NAME="$SANDBOX_NAME" bash "${E2E_DIR}/e2e-cloud-experimental/cleanup.sh" --verify; then
    fail "Cleanup or verification failed"
    exit 1
  fi
  pass "Cleanup complete"
fi

# ══════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Cloud Onboard E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\033[1;32m\n  Cloud Onboard E2E PASSED.\033[0m\n'
  exit 0
else
  printf '\033[1;31m\n  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
