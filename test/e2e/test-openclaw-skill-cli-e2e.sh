#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# OpenClaw skills install/list E2E — direct CLI roundtrip inside sandbox.
#
# Asserts that when a user runs `openclaw skills install <path>` directly
# inside a NemoClaw sandbox, the installed skill is enumerated by
# `openclaw skills list`. The sandbox onboard flow pins OPENCLAW_HOME,
# OPENCLAW_STATE_DIR, and OPENCLAW_WORKSPACE_DIR so install and list resolve
# the same workspace dir.
#
# Unlike test-skill-agent-e2e.sh, this script does NOT exercise the agent —
# it exercises the CLI contract only, so it has no LLM dependency and no
# retry/fuzzy-match logic.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_INFERENCE_API_KEY set (needed to onboard the sandbox)
#   - NEMOCLAW_NON_INTERACTIVE=1, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Environment:
#   NEMOCLAW_SANDBOX_NAME       — sandbox name (default: e2e-openclaw-skill-cli)
#   NEMOCLAW_RECREATE_SANDBOX=1 — recreate if exists
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_INFERENCE_API_KEY=... bash test/e2e/test-openclaw-skill-cli-e2e.sh

# shellcheck disable=SC2317
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
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-openclaw-skill-cli}"
SKILL_ID="openclaw-skill-cli-fixture"
SKILL_DESCRIPTION="E2E fixture proving openclaw skills install + list roundtrip"

# Source shared teardown helper
# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "${E2E_DIR}/lib/sandbox-teardown.sh"
# shellcheck source=test/e2e/lib/ci-compatible-inference.sh
. "${E2E_DIR}/lib/ci-compatible-inference.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"
nemoclaw_e2e_configure_compatible_inference || exit 1

# ══════════════════════════════════════════════════════════════════════
# Phase 1: Install + Prerequisites
# ══════════════════════════════════════════════════════════════════════
section "Phase 1: Install + Prerequisites"

if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  exit 1
fi
pass "Docker is running"

if ! nemoclaw_e2e_require_hosted_inference_key; then
  exit 1
fi

cd "$REPO" || {
  fail "Could not cd to repo root"
  exit 1
}

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX="${NEMOCLAW_RECREATE_SANDBOX:-1}"

info "Installing NemoClaw via install.sh --non-interactive..."
INSTALL_LOG="/tmp/nemoclaw-e2e-openclaw-skill-cli-install.log"
bash install.sh --non-interactive --yes-i-accept-third-party-software >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait "$install_pid"
install_exit=$?
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true

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

command -v openshell >/dev/null 2>&1 || {
  fail "openshell not on PATH"
  exit 1
}
pass "openshell on PATH"

# ══════════════════════════════════════════════════════════════════════
# Phase 2: Pre-flight — verify the OPENCLAW_* runtime env pins reach
# the sandbox's runtime shell rc. Drift here means the workaround in
# src/lib/onboard.ts never propagates past `nemoclaw-start` and
# `openclaw skills list` will fall back to a hardcoded default workspace.
# ══════════════════════════════════════════════════════════════════════
section "Phase 2: Pre-flight runtime env propagation check"

set +e
# Single-quote the inner script so the OPENCLAW_* variables expand inside the
# sandbox shell, not on the host.
# shellcheck disable=SC2016
env_check_out=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc 'printf "OPENCLAW_HOME=%s\nOPENCLAW_STATE_DIR=%s\nOPENCLAW_WORKSPACE_DIR=%s\n" "${OPENCLAW_HOME:-}" "${OPENCLAW_STATE_DIR:-}" "${OPENCLAW_WORKSPACE_DIR:-}"' 2>&1)
env_check_rc=$?
set -uo pipefail

if [ "$env_check_rc" -ne 0 ]; then
  fail "Failed to read OPENCLAW_* env vars from sandbox runtime shell (exit ${env_check_rc})"
  printf '%s\n' "$env_check_out"
  exit 1
fi

for required_var in OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_WORKSPACE_DIR; do
  if ! printf '%s\n' "$env_check_out" | grep -Eq "^${required_var}=.+"; then
    fail "${required_var} not exported in sandbox runtime shell"
    printf '%s\n' "$env_check_out"
    exit 1
  fi
done
pass "OPENCLAW_HOME, OPENCLAW_STATE_DIR, and OPENCLAW_WORKSPACE_DIR are exported in sandbox runtime shell"

# ══════════════════════════════════════════════════════════════════════
# Phase 3: Write a skill fixture into the sandbox under /tmp and install
# it through the OpenClaw CLI from a non-managed source path.
# ══════════════════════════════════════════════════════════════════════
section "Phase 3: Install skill via 'openclaw skills install <path>' inside sandbox"

remote_skill_dir="/tmp/${SKILL_ID}"
# openshell sandbox exec rejects command arguments that contain newlines or CRs
# ("InvalidArgument: command argument N contains newline or carriage return
# characters"), so the SKILL.md payload is base64-encoded on the host and decoded
# inside the sandbox. The encoder uses base64 -w0 (or tr -d) so the encoded
# payload is itself single-line.
skill_payload=$(printf '%s\n' \
  "---" \
  "name: \"${SKILL_ID}\"" \
  "description: \"${SKILL_DESCRIPTION}\"" \
  "---" \
  "" \
  "# OpenClaw skill CLI roundtrip fixture" \
  "" \
  "Written by test/e2e/test-openclaw-skill-cli-e2e.sh.")
skill_payload_b64=$(printf '%s' "$skill_payload" | base64 | tr -d '\n')
write_skill_cmd="rm -rf $(printf "%q" "$remote_skill_dir") && mkdir -p $(printf "%q" "$remote_skill_dir") && printf '%s' '${skill_payload_b64}' | base64 -d > $(printf "%q" "${remote_skill_dir}/SKILL.md")"

set +e
write_out=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$write_skill_cmd" 2>&1)
write_rc=$?
set -uo pipefail
if [ "$write_rc" -ne 0 ]; then
  fail "Failed to write skill fixture into sandbox (exit ${write_rc})"
  printf '%s\n' "$write_out"
  exit 1
fi
pass "Wrote skill fixture into sandbox at ${remote_skill_dir}"

set +e
install_out=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "openclaw skills install $(printf "%q" "$remote_skill_dir")" 2>&1)
install_rc=$?
set -uo pipefail
if [ "$install_rc" -ne 0 ]; then
  fail "openclaw skills install failed (exit ${install_rc})"
  printf '%s\n' "$install_out"
  exit 1
fi
pass "openclaw skills install completed (exit 0)"
info "install output:"
printf '%s\n' "$install_out"

# ══════════════════════════════════════════════════════════════════════
# Phase 4: Disk verification — install must land under the workspace dir
# the runtime env pin advertises, NOT under the managed dir or a host
# fallback. The reporter's repro on disk was ls /sandbox/.openclaw/workspace/skills/<id>.
# ══════════════════════════════════════════════════════════════════════
section "Phase 4: Verify install landed under \${OPENCLAW_WORKSPACE_DIR}/skills/<id>"

expected_disk_path="/sandbox/.openclaw/workspace/skills/${SKILL_ID}/SKILL.md"
set +e
disk_out=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "ls -1 \"\${OPENCLAW_WORKSPACE_DIR}/skills/${SKILL_ID}/\" 2>&1 ; test -f \"\${OPENCLAW_WORKSPACE_DIR}/skills/${SKILL_ID}/SKILL.md\" && echo SKILL_MD_PRESENT" 2>&1)
disk_rc=$?
set -uo pipefail
if [ "$disk_rc" -ne 0 ] || ! printf '%s' "$disk_out" | grep -Fq "SKILL_MD_PRESENT"; then
  fail "Installed skill not present at \${OPENCLAW_WORKSPACE_DIR}/skills/${SKILL_ID}/SKILL.md (expected ${expected_disk_path})"
  printf '%s\n' "$disk_out"
  exit 1
fi
pass "SKILL.md present on disk at \${OPENCLAW_WORKSPACE_DIR}/skills/${SKILL_ID}/"

# ══════════════════════════════════════════════════════════════════════
# Phase 5: List skills via 'openclaw skills list --json' and assert the
# installed fixture is enumerated. This is the contract the issue reports as
# broken when the runtime env pin is missing; passing here proves the
# install path and the list path agree on the workspace dir.
# ══════════════════════════════════════════════════════════════════════
section "Phase 5: Verify 'openclaw skills list' surfaces the installed skill"

set +e
list_out=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc 'openclaw skills list --json' 2>&1)
list_rc=$?
set -uo pipefail
if [ "$list_rc" -ne 0 ]; then
  fail "openclaw skills list --json failed (exit ${list_rc})"
  printf '%s\n' "$list_out"
  exit 1
fi
pass "openclaw skills list --json completed (exit 0)"

if ! printf '%s' "$list_out" | grep -Fq "\"${SKILL_ID}\""; then
  fail "Installed skill '${SKILL_ID}' did not appear in 'openclaw skills list --json' output"
  printf '%s\n' "$list_out" | tail -c 8000
  exit 1
fi
pass "Installed skill '${SKILL_ID}' is enumerated by 'openclaw skills list --json'"

# Assert the list entry's source labels it as openclaw-workspace (not
# openclaw-managed or openclaw-extra) so we know the skill came from the
# workspace install path and not a fallback location.
if ! printf '%s' "$list_out" | grep -Fq "openclaw-workspace"; then
  fail "Expected at least one entry with source 'openclaw-workspace' in 'openclaw skills list --json' output"
  printf '%s\n' "$list_out" | tail -c 8000
  exit 1
fi
pass "list output includes an entry with source 'openclaw-workspace'"

# ══════════════════════════════════════════════════════════════════════
# Phase 6: 'openclaw skills info <id>' must resolve the same skill that
# install wrote and report its on-disk location. This catches drift
# between the install resolver and the per-skill info resolver.
# ══════════════════════════════════════════════════════════════════════
section "Phase 6: Verify 'openclaw skills info ${SKILL_ID}' resolves the workspace path"

set +e
info_out=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "openclaw skills info $(printf "%q" "$SKILL_ID") --json" 2>&1)
info_rc=$?
set -uo pipefail
if [ "$info_rc" -ne 0 ]; then
  fail "openclaw skills info ${SKILL_ID} --json failed (exit ${info_rc})"
  printf '%s\n' "$info_out"
  exit 1
fi
pass "openclaw skills info ${SKILL_ID} --json completed (exit 0)"

if ! printf '%s' "$info_out" | grep -Fq "${SKILL_ID}"; then
  fail "'openclaw skills info' output did not include the skill id"
  printf '%s\n' "$info_out" | tail -c 8000
  exit 1
fi
if ! printf '%s' "$info_out" | grep -Fq "/.openclaw/workspace/skills/${SKILL_ID}"; then
  fail "'openclaw skills info' did not report the workspace install path"
  printf '%s\n' "$info_out" | tail -c 8000
  exit 1
fi
pass "'openclaw skills info' reports the skill at the workspace install path"

# ══════════════════════════════════════════════════════════════════════
# Phase 7: 'openclaw skills check' is the eligibility report users run to
# diagnose missing skills. The installed fixture must appear there too so
# users do not see a partial view of their workspace.
# ══════════════════════════════════════════════════════════════════════
section "Phase 7: Verify 'openclaw skills check' includes the installed skill"

set +e
check_out=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc 'openclaw skills check --json' 2>&1)
check_rc=$?
set -uo pipefail
if [ "$check_rc" -ne 0 ]; then
  fail "openclaw skills check --json failed (exit ${check_rc})"
  printf '%s\n' "$check_out"
  exit 1
fi
pass "openclaw skills check --json completed (exit 0)"

if ! printf '%s' "$check_out" | grep -Fq "\"${SKILL_ID}\""; then
  fail "Installed skill '${SKILL_ID}' did not appear in 'openclaw skills check --json' output"
  printf '%s\n' "$check_out" | tail -c 8000
  exit 1
fi
pass "Installed skill '${SKILL_ID}' is enumerated by 'openclaw skills check --json'"

# ══════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  OpenClaw skill CLI E2E Results:"
echo "    Passed: $PASS"
echo "    Failed: $FAIL"
echo "    Total:  $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\033[1;32m\n  OpenClaw skill CLI E2E PASSED.\033[0m\n'
  exit 0
else
  printf '\033[1;31m\n  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
