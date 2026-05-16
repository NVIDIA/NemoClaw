#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Docs Validation E2E — CLI/docs parity + markdown link validation
#
# Runs check-docs.sh to verify nemoclaw --help matches commands.md
# and that markdown links resolve. No sandbox needed — just needs
# nemoclaw installed.
#
# Split from the cloud-experimental-e2e monolith (see #2644).
# Former phase: 5f (documentation checks).
#
# Prerequisites:
#   - nemoclaw installed and on PATH
#   - Node.js on PATH (for CLI help output)
#
# Environment:
#   CHECK_DOC_LINKS_REMOTE=1    — curl http(s) links (default: 1; set 0 to skip)
#   CHECK_DOC_LINKS_VERBOSE=1   — log each URL while curling
#
# Usage:
#   bash test/e2e/test-docs-validation.sh
#   CHECK_DOC_LINKS_REMOTE=0 bash test/e2e/test-docs-validation.sh

# ShellCheck cannot see EXIT trap invocations of cleanup helpers in this E2E script.
# shellcheck disable=SC2317
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
  REPO="${_candidate}" # exported for child scripts
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi
unset _script_dir _candidate
export REPO

E2E_DIR="$(cd "$(dirname "$0")" && pwd)"

# ══════════════════════════════════════════════════════════════════════
# Phase 1: Prerequisites
# ══════════════════════════════════════════════════════════════════════
section "Phase 1: Prerequisites"

# check-docs.sh needs nemoclaw on PATH for CLI parity check.
# In nightly CI the install step runs before this job.
if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH"
else
  # Try sourcing nvm in case it wasn't inherited
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"

  if command -v nemoclaw >/dev/null 2>&1; then
    pass "nemoclaw on PATH (after sourcing nvm)"
  else
    fail "nemoclaw not on PATH — install NemoClaw first"
    exit 1
  fi
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 2: CLI / docs parity (check-docs.sh --only-cli)
# ══════════════════════════════════════════════════════════════════════
section "Phase 2: CLI / docs parity"

info "Running check-docs.sh --only-cli (nemoclaw --help vs commands.md)..."
set +e
bash "${E2E_DIR}/e2e-cloud-experimental/check-docs.sh" --only-cli
cli_rc=$?
set -uo pipefail

if [ "$cli_rc" -eq 0 ]; then
  pass "CLI / docs parity check passed"
else
  fail "CLI / docs parity check failed (exit ${cli_rc})"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 3: Markdown link validation (check-docs.sh --only-links)
# ══════════════════════════════════════════════════════════════════════
section "Phase 3: Markdown link validation"

if [ "${CHECK_DOC_LINKS_REMOTE:-1}" = "0" ]; then
  info "Running check-docs.sh --only-links --local-only (no remote probes)..."
  set +e
  bash "${E2E_DIR}/e2e-cloud-experimental/check-docs.sh" --only-links --local-only
  links_rc=$?
  set -uo pipefail
else
  info "Running check-docs.sh --only-links (includes remote http(s) probes)..."
  set +e
  bash "${E2E_DIR}/e2e-cloud-experimental/check-docs.sh" --only-links
  links_rc=$?
  set -uo pipefail
fi

if [ "$links_rc" -eq 0 ]; then
  pass "Markdown link validation passed"
else
  # Remote link probes can fail due to rate limiting (429) — warn but don't block
  if [ "${CHECK_DOC_LINKS_REMOTE:-1}" != "0" ]; then
    info "Link validation failed — may be due to remote rate limiting. Re-run with CHECK_DOC_LINKS_REMOTE=0 to check local links only."
  fi
  fail "Markdown link validation failed (exit ${links_rc})"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Docs Validation E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\033[1;32m\n  Docs Validation E2E PASSED.\033[0m\n'
  exit 0
else
  printf '\033[1;31m\n  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
