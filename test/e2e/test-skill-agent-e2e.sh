#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Skill Agent E2E — Skill injection + agent verification
#
# Injects a skill fixture into the sandbox and verifies the agent reads
# the skill's SKILL.md and returns the verification token. Includes retry
# logic and fuzzy matching to handle LLM non-determinism.
#
# Split from the cloud-experimental-e2e monolith (see #2644).
# Former phase: 5d (skill agent verification).
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - NEMOCLAW_NON_INTERACTIVE=1, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Environment:
#   NEMOCLAW_SANDBOX_NAME                   — sandbox name (default: e2e-skill-agent)
#   NEMOCLAW_RECREATE_SANDBOX=1             — recreate if exists
#   E2E_SKILL_AGENT_MAX_ATTEMPTS           — agent turn retries (default: 3)
#   E2E_SKILL_AGENT_RETRY_SLEEP_SEC        — seconds between retries (default: 15)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-skill-agent-e2e.sh

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

# ── Repo root ──
_script_dir="$(cd "$(dirname "$0")" && pwd)"
_candidate="$(cd "${_script_dir}/../.." && pwd)"
if [ -d /workspace ] && [ -f /workspace/package.json ] && [ -d /workspace/test/e2e ]; then
  REPO="/workspace"
elif [ -f "${_candidate}/package.json" ] && [ -d "${_candidate}/test/e2e" ]; then
  REPO="${_candidate}"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi
unset _script_dir _candidate

E2E_DIR="$(cd "$(dirname "$0")" && pwd)"
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-skill-agent}"
SKILL_ID="skill-smoke-fixture"
VERIFY_PHRASE="SKILL_SMOKE_VERIFY_K9X2"
MAX_ATTEMPTS="${E2E_SKILL_AGENT_MAX_ATTEMPTS:-3}"
RETRY_SLEEP="${E2E_SKILL_AGENT_RETRY_SLEEP_SEC:-15}"
[[ "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || MAX_ATTEMPTS=3

# Source shared teardown helper
# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "${E2E_DIR}/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# ══════════════════════════════════════════════════════════════════════
# Phase 1: Install + Prerequisites
# ══════════════════════════════════════════════════════════════════════
section "Phase 1: Install + Prerequisites"

if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  exit 1
fi
pass "Docker is running"

if [ -z "${NVIDIA_API_KEY:-}" ] || [[ "${NVIDIA_API_KEY}" != nvapi-* ]]; then
  fail "NVIDIA_API_KEY not set or invalid"
  exit 1
fi
pass "NVIDIA_API_KEY is set"

cd "$REPO" || {
  fail "Could not cd to repo root"
  exit 1
}

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX="${NEMOCLAW_RECREATE_SANDBOX:-1}"

info "Installing NemoClaw via install.sh --non-interactive..."
INSTALL_LOG="/tmp/nemoclaw-e2e-skill-agent-install.log"
bash install.sh --non-interactive --yes-i-accept-third-party-software >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait "$install_pid"
install_exit=$?
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true

# Source shell profile
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"

if [ "$install_exit" -ne 0 ]; then
  fail "install.sh failed (exit $install_exit)"
  tail -30 "$INSTALL_LOG"
  exit 1
fi
pass "NemoClaw installed"

command -v nemoclaw >/dev/null 2>&1 || {
  fail "nemoclaw not on PATH"
  exit 1
}
command -v openshell >/dev/null 2>&1 || {
  fail "openshell not on PATH"
  exit 1
}
pass "CLIs on PATH"

# ══════════════════════════════════════════════════════════════════════
# Phase 2: Inject skill fixture
# ══════════════════════════════════════════════════════════════════════
section "Phase 2: Inject skill fixture"

info "Injecting ${SKILL_ID} into sandbox '${SANDBOX_NAME}'..."
if ! SANDBOX_NAME="$SANDBOX_NAME" \
  SKILL_ID="$SKILL_ID" \
  SKILL_DESCRIPTION="E2E smoke skill injected for agent verification" \
  bash "$E2E_DIR/e2e-cloud-experimental/features/skill/add-sandbox-skill.sh"; then
  fail "Failed to inject ${SKILL_ID}"
  exit 1
fi
pass "${SKILL_ID} injected and queryable"

# ══════════════════════════════════════════════════════════════════════
# Phase 3: Agent verification with retry + fuzzy matching
# ══════════════════════════════════════════════════════════════════════
section "Phase 3: Agent verification (${MAX_ATTEMPTS} attempts, ${RETRY_SLEEP}s between)"

attempt=1
agent_ok=0
last_fail=""

while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  info "Attempt ${attempt}/${MAX_ATTEMPTS}: running openclaw agent turn..."

  set +e
  agent_out=$(
    NVIDIA_API_KEY="$NVIDIA_API_KEY" \
      SANDBOX_NAME="$SANDBOX_NAME" \
      SKILL_ID="$SKILL_ID" \
      VERIFY_TOKEN="$VERIFY_PHRASE" \
      bash "$E2E_DIR/e2e-cloud-experimental/features/skill/verify-sandbox-skill-via-agent.sh" 2>&1
  )
  agent_rc=$?
  set -uo pipefail

  if [ "$agent_rc" -eq 0 ]; then
    pass "Agent returned ${VERIFY_PHRASE} (attempt ${attempt}/${MAX_ATTEMPTS})"
    agent_ok=1
    break
  fi

  # Fuzzy fallback: check if the token appears in the *agent output section only*,
  # not in helper diagnostic/error lines. The helper delimits agent output with
  # "--- agent stdout/stderr" / "--- end ---" markers. We extract only that
  # section to avoid false positives from error messages that echo the token
  # (see Brandon's review on #2647).
  agent_section=$(printf '%s' "$agent_out" | sed -n '/--- agent stdout\/stderr/,/--- end ---/p')
  if [ -n "$agent_section" ]; then
    collapsed=$(printf '%s' "$agent_section" | tr -d '\n\r' | tr -d '`"'\''' | tr '[:upper:]' '[:lower:]')
    token_lower=$(printf '%s' "$VERIFY_PHRASE" | tr '[:upper:]' '[:lower:]')
    if printf '%s' "$collapsed" | grep -Fq "$token_lower"; then
      info "Token found in agent output section (fuzzy match — script exited ${agent_rc} but token present in delimited output)"
      pass "Agent returned ${VERIFY_PHRASE} via fuzzy match (attempt ${attempt}/${MAX_ATTEMPTS})"
      agent_ok=1
      break
    fi
  fi

  last_fail="Agent verification failed (exit ${agent_rc}): ${agent_out:0:400}"

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then break; fi
  info "Attempt ${attempt}/${MAX_ATTEMPTS} failed — sleeping ${RETRY_SLEEP}s before retry..."
  sleep "$RETRY_SLEEP"
  attempt=$((attempt + 1))
done

if [ "$agent_ok" -ne 1 ]; then
  fail "$last_fail"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Skill Agent E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\033[1;32m\n  Skill Agent E2E PASSED.\033[0m\n'
  exit 0
else
  printf '\033[1;31m\n  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
