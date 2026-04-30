#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Cloud Inference E2E — Live chat via inference.local + skill filesystem validation
#
# Tests end-to-end inference (sandbox → gateway → cloud API → response)
# and validates the OpenClaw skill filesystem layout inside the sandbox.
#
# Split from the cloud-experimental-e2e monolith (see #2644).
# Former phases: 5b (live chat), 5c (skill filesystem).
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - NEMOCLAW_NON_INTERACTIVE=1, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Environment:
#   NEMOCLAW_SANDBOX_NAME                   — sandbox name (default: e2e-cloud-inference)
#   NEMOCLAW_RECREATE_SANDBOX=1             — recreate if exists
#   E2E_PHASE_5B_MAX_ATTEMPTS              — chat retries (default: 3)
#   E2E_PHASE_5B_RETRY_SLEEP_SEC           — seconds between retries (default: 5)
#   NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL      — cloud model (default: nvidia/nemotron-3-super-120b-a12b)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-cloud-inference-e2e.sh

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
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-inference}"
CLOUD_MODEL="${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-nvidia/nemotron-3-super-120b-a12b}"

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
INSTALL_LOG="/tmp/nemoclaw-e2e-cloud-inference-install.log"
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
# Phase 2: Live chat via inference.local
# ══════════════════════════════════════════════════════════════════════
section "Phase 2: Live chat (inference.local /v1/chat/completions)"

command -v python3 >/dev/null 2>&1 || {
  fail "python3 not on PATH"
  exit 1
}

payload=$(CLOUD_MODEL="$CLOUD_MODEL" python3 -c "
import json, os
print(json.dumps({
    'model': os.environ['CLOUD_MODEL'],
    'messages': [{'role': 'user', 'content': 'Reply with exactly one word: PONG'}],
    'max_tokens': 100,
}))
") || {
  fail "Could not build chat payload"
  exit 1
}

MAX_ATTEMPTS="${E2E_PHASE_5B_MAX_ATTEMPTS:-3}"
RETRY_SLEEP="${E2E_PHASE_5B_RETRY_SLEEP_SEC:-5}"
[[ "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || MAX_ATTEMPTS=3

info "POST chat completion inside sandbox (model ${CLOUD_MODEL}, up to ${MAX_ATTEMPTS} attempts)..."

TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 120"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 120"

ssh_config="$(mktemp)"
if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  rm -f "$ssh_config"
  fail "openshell sandbox ssh-config failed for '${SANDBOX_NAME}'"
  exit 1
fi

attempt=1
chat_ok=0
last_fail=""
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  set +e
  chat_out=$(
    $TIMEOUT_CMD ssh -F "$ssh_config" \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 \
      -o LogLevel=ERROR \
      "openshell-${SANDBOX_NAME}" \
      "curl -sS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d $(printf '%q' "$payload")" \
      2>&1
  )
  chat_rc=$?
  set -uo pipefail

  if [ "$chat_rc" -ne 0 ]; then
    last_fail="ssh/curl failed (exit ${chat_rc}): ${chat_out:0:400}"
  elif [ -z "$chat_out" ]; then
    last_fail="empty response from inference.local"
  else
    chat_text=$(printf '%s' "$chat_out" | parse_chat_content 2>/dev/null) || chat_text=""
    if echo "$chat_text" | grep -qi "PONG"; then
      pass "Chat completion returned PONG (attempt ${attempt}/${MAX_ATTEMPTS})"
      chat_ok=1
      break
    fi
    last_fail="expected PONG, got: ${chat_text:0:300}"
  fi

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then break; fi
  info "Attempt ${attempt}/${MAX_ATTEMPTS} failed — ${last_fail}"
  info "Sleeping ${RETRY_SLEEP}s..."
  sleep "$RETRY_SLEEP"
  attempt=$((attempt + 1))
done

rm -f "$ssh_config"

if [ "$chat_ok" -ne 1 ]; then
  fail "Live chat: $last_fail"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 3: Skill filesystem validation
# ══════════════════════════════════════════════════════════════════════
section "Phase 3: Skill filesystem validation"

info "Validating repo .agents/skills (SKILL.md frontmatter + body)..."
if ! bash "$E2E_DIR/e2e-cloud-experimental/features/skill/lib/validate_repo_skills.sh" --repo "$REPO"; then
  fail "Repo skill validation failed"
  exit 1
fi
pass "Repo agent skills (SKILL.md) valid"

info "Checking /sandbox/.openclaw inside sandbox..."
set +e
sb_out=$(SANDBOX_NAME="$SANDBOX_NAME" bash "$E2E_DIR/e2e-cloud-experimental/features/skill/lib/validate_sandbox_openclaw_skills.sh" 2>/dev/null)
sb_rc=$?
set -uo pipefail

if [ "$sb_rc" -ne 0 ]; then
  fail "Sandbox OpenClaw layout check failed (exit ${sb_rc}): ${sb_out:0:240}"
  exit 1
fi
pass "Sandbox /sandbox/.openclaw + openclaw.json OK"

if echo "$sb_out" | grep -q "SKILLS_SUBDIR=present"; then
  pass "Sandbox /sandbox/.openclaw/skills present"
elif echo "$sb_out" | grep -q "SKILLS_SUBDIR=absent"; then
  skip "/sandbox/.openclaw/skills absent (migration snapshot had no skills dir)"
else
  fail "Unexpected sandbox check output: ${sb_out:0:240}"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Cloud Inference E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\033[1;32m\n  Cloud Inference E2E PASSED.\033[0m\n'
  exit 0
else
  printf '\033[1;31m\n  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
