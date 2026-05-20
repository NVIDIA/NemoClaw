#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-brew-command.sh
# NemoClaw `brew` subcommand E2E (#3757)
#
# Covers the first-class brew lifecycle:
#   TC-BREW-01: `brew init` bootstraps Homebrew, /home/linuxbrew/.linuxbrew/bin/brew runnable
#   TC-BREW-02: `brew install hello` lands a runnable bottled binary in the sandbox PATH
#   TC-BREW-03: `brew uninstall hello` removes the bottle
#   TC-BREW-04: `brew init` a second time is idempotent
#   TC-BREW-05: `brew install` without prior init refuses with a clear error
#   TC-BREW-06: `brew install` with shields up refuses with a clear error
#   TC-BREW-07: `brew deinit` removes /home/linuxbrew and the linuxbrew user
#
# Prerequisites:
#   - Docker running
#   - NemoClaw installed (or install.sh available)
#   - NVIDIA_API_KEY for sandbox onboard
# =============================================================================

set -euo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=5400
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"
# shellcheck source=test/e2e/lib/install-path-refresh.sh
source "${SCRIPT_DIR_TIMEOUT}/lib/install-path-refresh.sh"

SANDBOX_NAME="e2e-brew-cmd"
LOG_FILE="test-brew-command-$(date +%Y%m%d-%H%M%S).log"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
TOTAL=0

log() { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*" | tee -a "$LOG_FILE"; }
pass() {
  ((PASS += 1))
  ((TOTAL += 1))
  echo -e "${GREEN}  PASS${NC} $1" | tee -a "$LOG_FILE"
}
fail() {
  ((FAIL += 1))
  ((TOTAL += 1))
  echo -e "${RED}  FAIL${NC} $1 — $2" | tee -a "$LOG_FILE"
}
skip() {
  ((SKIP += 1))
  ((TOTAL += 1))
  echo -e "${YELLOW}  SKIP${NC} $1 — $2" | tee -a "$LOG_FILE"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

install_nemoclaw() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi
  nemoclaw_ensure_local_bin_on_path
  if command -v nemoclaw >/dev/null 2>&1; then
    log "nemoclaw already installed: $(nemoclaw --version 2>/dev/null || echo unknown)"
    return
  fi
  log "=== Installing NemoClaw via install.sh ==="
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NVIDIA_API_KEY="${NVIDIA_API_KEY:-nvapi-DUMMY-FOR-INSTALL}" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="restricted" \
    bash "$REPO_ROOT/install.sh" --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE"
  nemoclaw_refresh_install_env
  if ! command -v nemoclaw >/dev/null 2>&1; then
    log "ERROR: install.sh failed — nemoclaw not found"
    exit 1
  fi
}

preflight() {
  log "=== Pre-flight checks ==="
  if ! docker info >/dev/null 2>&1; then
    log "ERROR: Docker is not running."
    exit 1
  fi
  log "Docker is running"
  install_nemoclaw
  log "nemoclaw: $(nemoclaw --version 2>/dev/null || echo unknown)"
  log "Pre-flight complete"
}

sandbox_exec() {
  local cmd="$1"
  local ssh_cfg
  ssh_cfg="$(mktemp)"
  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_cfg" 2>/dev/null; then
    log "  [sandbox_exec] Failed to get SSH config"
    rm -f "$ssh_cfg"
    echo ""
    return 1
  fi
  local result ssh_exit=0
  result=$(run_with_timeout 120 ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" "$cmd" 2>&1) || ssh_exit=$?
  rm -f "$ssh_cfg"
  echo "$result"
  return $ssh_exit
}

setup_sandbox() {
  local api_key="${NVIDIA_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    log "ERROR: NVIDIA_API_KEY not set"
    exit 1
  fi
  log "Preflight: destroying any existing '$SANDBOX_NAME' sandbox..."
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true

  log "=== Onboarding sandbox '$SANDBOX_NAME' with restricted policy ==="
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="restricted" \
    NEMOCLAW_RECREATE_SANDBOX=1 \
    run_with_timeout 900 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || {
    log "FATAL: Onboard failed"
    exit 1
  }
  log "Sandbox '$SANDBOX_NAME' onboarded with restricted policy"
}

test_brew_init() {
  log ""
  log "=== TC-BREW-01: brew init bootstraps Homebrew ==="
  local out exit_code=0
  out=$(run_with_timeout 1800 nemoclaw "$SANDBOX_NAME" brew init 2>&1) || exit_code=$?
  echo "$out" | tee -a "$LOG_FILE" >/dev/null
  if [[ "$exit_code" -ne 0 ]]; then
    fail "TC-BREW-01" "brew init exited $exit_code"
    return 1
  fi
  local brew_bin
  brew_bin=$(sandbox_exec '/home/linuxbrew/.linuxbrew/bin/brew --version 2>&1 || true')
  if echo "$brew_bin" | grep -q '^Homebrew '; then
    pass "TC-BREW-01"
  else
    fail "TC-BREW-01" "brew --version did not report Homebrew: $brew_bin"
  fi
}

test_brew_install_hello() {
  log ""
  log "=== TC-BREW-02: brew install hello lands a runnable bottle ==="
  local exit_code=0
  run_with_timeout 1800 nemoclaw "$SANDBOX_NAME" brew install hello 2>&1 | tee -a "$LOG_FILE" || exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    fail "TC-BREW-02" "brew install hello exited $exit_code"
    return 1
  fi
  local hello_out
  hello_out=$(sandbox_exec '/home/linuxbrew/.linuxbrew/bin/hello 2>&1 || true')
  if echo "$hello_out" | grep -q 'Hello, world'; then
    pass "TC-BREW-02"
  else
    fail "TC-BREW-02" "hello binary did not print expected greeting: $hello_out"
  fi
}

test_brew_uninstall_hello() {
  log ""
  log "=== TC-BREW-03: brew uninstall hello removes the bottle ==="
  local exit_code=0
  run_with_timeout 300 nemoclaw "$SANDBOX_NAME" brew uninstall hello 2>&1 | tee -a "$LOG_FILE" || exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    fail "TC-BREW-03" "brew uninstall hello exited $exit_code"
    return 1
  fi
  local present
  present=$(sandbox_exec 'test -x /home/linuxbrew/.linuxbrew/bin/hello && echo present || echo absent')
  if [[ "$present" == "absent" ]]; then
    pass "TC-BREW-03"
  else
    fail "TC-BREW-03" "hello binary still present after uninstall"
  fi
}

test_init_twice_idempotent() {
  log ""
  log "=== TC-BREW-04: brew init twice is idempotent ==="
  local exit_code=0
  local out
  out=$(run_with_timeout 60 nemoclaw "$SANDBOX_NAME" brew init 2>&1) || exit_code=$?
  echo "$out" | tee -a "$LOG_FILE" >/dev/null
  if [[ "$exit_code" -eq 0 ]] && echo "$out" | grep -q 'already installed'; then
    pass "TC-BREW-04"
  else
    fail "TC-BREW-04" "expected 'already installed' message, got exit=$exit_code out=$out"
  fi
}

test_shields_up_refuses() {
  log ""
  log "=== TC-BREW-06: brew install with shields up refuses ==="
  nemoclaw "$SANDBOX_NAME" shields up 2>&1 | tee -a "$LOG_FILE" || {
    skip "TC-BREW-06" "shields up failed; skipping"
    return 0
  }
  local exit_code=0
  local out
  out=$(nemoclaw "$SANDBOX_NAME" brew install jq 2>&1) || exit_code=$?
  echo "$out" | tee -a "$LOG_FILE" >/dev/null
  nemoclaw "$SANDBOX_NAME" shields down 2>&1 | tee -a "$LOG_FILE" || true
  if [[ "$exit_code" -ne 0 ]] && echo "$out" | grep -q 'shields up'; then
    pass "TC-BREW-06"
  else
    fail "TC-BREW-06" "expected refusal with 'shields up' message, got exit=$exit_code out=$out"
  fi
}

test_brew_deinit() {
  log ""
  log "=== TC-BREW-07: brew deinit removes /home/linuxbrew ==="
  local exit_code=0
  run_with_timeout 180 nemoclaw "$SANDBOX_NAME" brew deinit 2>&1 | tee -a "$LOG_FILE" || exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    fail "TC-BREW-07" "brew deinit exited $exit_code"
    return 1
  fi
  local present
  present=$(sandbox_exec 'test -d /home/linuxbrew && echo present || echo absent')
  if [[ "$present" == "absent" ]]; then
    pass "TC-BREW-07"
  else
    fail "TC-BREW-07" "/home/linuxbrew still present after deinit"
  fi
}

test_install_without_init_refused() {
  log ""
  log "=== TC-BREW-05: brew install without prior init refuses ==="
  local exit_code=0
  local out
  out=$(nemoclaw "$SANDBOX_NAME" brew install jq 2>&1) || exit_code=$?
  echo "$out" | tee -a "$LOG_FILE" >/dev/null
  if [[ "$exit_code" -ne 0 ]] && echo "$out" | grep -q 'brew init'; then
    pass "TC-BREW-05"
  else
    fail "TC-BREW-05" "expected refusal with 'brew init' hint, got exit=$exit_code out=$out"
  fi
}

main() {
  log "============================================================"
  log "NemoClaw brew-command E2E (#3757)"
  log "============================================================"
  preflight
  setup_sandbox
  test_brew_init
  test_brew_install_hello
  test_brew_uninstall_hello
  test_init_twice_idempotent
  test_shields_up_refuses
  test_brew_deinit
  test_install_without_init_refused
  log ""
  log "============================================================"
  log "Summary: PASS=$PASS FAIL=$FAIL SKIP=$SKIP TOTAL=$TOTAL"
  log "============================================================"
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  if [[ "$FAIL" -gt 0 ]]; then
    exit 1
  fi
}

main "$@"
