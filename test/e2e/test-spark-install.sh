#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# DGX Spark install smoke: standard install.sh path on a Spark-class Linux host.
#
# Prerequisites:
#   - Linux (DGX Spark or similar); other OS exits immediately (fail)
#   - Docker running
#   - Same env your non-interactive install needs (e.g. NEMOCLAW_NON_INTERACTIVE=1, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1, API keys, …)
#
# Environment:
#   NEMOCLAW_NON_INTERACTIVE=1             — required (matches full-e2e install phase)
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required for non-interactive install/onboard
#   NEMOCLAW_E2E_PUBLIC_INSTALL=1          — use curl|bash instead of repo install.sh
#   NEMOCLAW_INSTALL_SCRIPT_URL            — URL when using public install (default: nemoclaw.sh)
#   INSTALL_LOG                            — log file (default: /tmp/nemoclaw-e2e-spark-install.log)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash test/e2e/test-spark-install.sh
#
# See: spark-install.md

set -uo pipefail

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

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root (install.sh)."
  exit 1
fi

INSTALL_LOG="${INSTALL_LOG:-/tmp/nemoclaw-e2e-spark-install.log}"

section "Phase 0: Platform"
if [ "$(uname -s)" = "Linux" ]; then
  pass "Running on Linux"
else
  fail "This script is for DGX Spark (Linux). On other OS use Vitest: NEMOCLAW_E2E_SPARK_INSTALL=1 --project spark-install-cli (skipped there on non-Linux)."
  exit 1
fi

section "Phase 1: Prerequisites"
if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  exit 1
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ]; then
  pass "NEMOCLAW_NON_INTERACTIVE=1"
else
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  exit 1
fi

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
  pass "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1"
else
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required for non-interactive install"
  exit 1
fi

section "Phase 2: Standard installer path"
cd "$REPO" || {
  fail "cd to repo: $REPO"
  exit 1
}

pass "Using generic installer flow without Spark-specific setup"

section "Phase 3: Install NemoClaw (non-interactive)"
info "Log: $INSTALL_LOG"
if [ "${NEMOCLAW_E2E_PUBLIC_INSTALL:-0}" = "1" ]; then
  url="${NEMOCLAW_INSTALL_SCRIPT_URL:-https://www.nvidia.com/nemoclaw.sh}"
  info "Running: curl -fsSL ... | bash (url=$url)"
  curl -fsSL "$url" | NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash >"$INSTALL_LOG" 2>&1 &
else
  info "Running: bash install.sh --non-interactive"
  NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
fi
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait "$install_pid"
install_exit=$?
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true

if [ "$install_exit" -ne 0 ]; then
  fail "install failed (exit $install_exit); last 80 lines of log:"
  tail -n 80 "$INSTALL_LOG" >&2 || true
  exit 1
fi
pass "install completed (exit 0)"

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

section "Phase 4: Verify CLI"
if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH ($(command -v nemoclaw))"
else
  fail "nemoclaw not on PATH"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell on PATH"
else
  fail "openshell not on PATH"
  exit 1
fi

if nemoclaw --help >/dev/null 2>&1; then
  pass "nemoclaw --help exits 0"
else
  fail "nemoclaw --help failed"
  exit 1
fi

section "Summary"
printf '\033[1;32mOK: spark-install bash smoke (%d checks passed)\033[0m\n' "$PASS"
echo "  Log: $INSTALL_LOG"
