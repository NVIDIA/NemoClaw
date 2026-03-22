#!/bin/bash
# e2e-cloud-experimental — Ubuntu + Docker CE + experimental mode + Cloud API
#
# Focus: experimental / policy / network / security (VDR3 + internal bugs).
# Implemented: Phase 0–1, 3, 5–6. Phase 5 runs checks/*.sh; Phase 5b live chat; Phase 5c skill smoke; Phase 5d skill agent verification; Phase 6 final cleanup.
# (add checks under e2e-cloud-experimental/checks without editing case loop). VDR3 #12 via env on Phase 3 install.
# Phase 2 skipped. Phase 5: checks suite (checks/*.sh only; opt-in scripts live under e2e-cloud-experimental/skip/).
# Phase 5b: POST /v1/chat/completions inside sandbox (model = CLOUD_EXPERIMENTAL_MODEL).
# Phase 5c: validate repo .agents/skills; verify /sandbox/.openclaw inside sandbox (skills subdir optional → SKIP if absent).
# Phase 5d: inject skill-smoke-fixture into sandbox and verify token via openclaw agent.
# Phase 6: cleanup.
# VDR3 #14 (re-onboard / volume audit) not automated here.
#
# Optional (not run here): port-8080 onboard conflict — see test/e2e/test-port8080-conflict.sh
#
# Prerequisites (when fully implemented):
#   - Docker running (Docker CE on Ubuntu for the nominal scenario)
#   - NVIDIA_API_KEY set (nvapi-...) for Cloud inference segments
#   - Network to integrate.api.nvidia.com
#   - NEMOCLAW_NON_INTERACTIVE=1 for automated onboard segments
#
# Environment (suggested):
#   Sandbox name is fixed in this script: e2e-cloud-experimental
#   NEMOCLAW_EXPERIMENTAL=1            — experimental inference options (onboard)
#   NEMOCLAW_PROVIDER=cloud            — non-interactive provider selection
#   NEMOCLAW_MODEL=...                 — optional during Phase 3 install
#   NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL  — cloud model for first onboard (default: moonshotai/kimi-k2.5); legacy: NEMOCLAW_SCENARIO_A_MODEL
#   NEMOCLAW_POLICY_MODE=custom
#   NEMOCLAW_POLICY_PRESETS            — e.g. npm,pypi (github preset TBD in repo)
#   RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE=1 — optional: expect-based steps (later phases)
#   RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_FINAL_CLEANUP=1 — leave sandbox/gateway up (local debugging); legacy: RUN_SCENARIO_A_SKIP_FINAL_CLEANUP=1
#
# Usage (Phases 0–1, 3 + cases + Phase 5b chat + Phase 5c skill smoke + Phase 5d skill verification + Phase 6 cleanup; Phase 2 skipped):
#   NEMOCLAW_NON_INTERACTIVE=1 NVIDIA_API_KEY=nvapi-... bash test/e2e/test-e2e-cloud-experimental.sh
#
# CI equivalent to public curl | bash: run from repo root with install.sh (install does onboard).

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() { ((PASS++)); ((TOTAL++)); printf '\033[32m  PASS: %s\033[0m\n' "$1"; }
fail() { ((FAIL++)); ((TOTAL++)); printf '\033[31m  FAIL: %s\033[0m\n' "$1"; }
skip() { ((SKIP++)); ((TOTAL++)); printf '\033[33m  SKIP: %s\033[0m\n' "$1"; }
section() { echo ""; printf '\033[1;36m=== %s ===\033[0m\n' "$1"; }
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# Parse chat completion JSON — content, reasoning_content, or reasoning (e.g. moonshot/kimi via gateway)
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

# ── Repo root (same logic as test-full-e2e.sh) ─────────────────────────
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root (install.sh)."
  exit 1
fi

SANDBOX_NAME="e2e-cloud-experimental"
CLOUD_EXPERIMENTAL_MODEL="${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-${NEMOCLAW_SCENARIO_A_MODEL:-moonshotai/kimi-k2.5}}"
E2E_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_CLOUD_EXPERIMENTAL_READY_DIR="${E2E_DIR}/e2e-cloud-experimental/checks"

# ══════════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════════
# Destroy leftover sandbox / gateway / forwards from prior runs.
# nemoclaw destroy clears ~/.nemoclaw/sandboxes.json; align with test-double-onboard.sh.
section "Phase 0: Pre-cleanup"
info "Destroying leftover sandbox, forwards, and gateway for '${SANDBOX_NAME}'..."

if command -v nemoclaw > /dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
fi
if command -v openshell > /dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell forward stop 18789 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi

pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════════
# Phase 1: Prerequisites
# ══════════════════════════════════════════════════════════════════════
# Docker running; NVIDIA_API_KEY format; reach integrate.api.nvidia.com;
# NEMOCLAW_NON_INTERACTIVE=1 for automated path; optional: assert Linux + Docker CE.
section "Phase 1: Prerequisites"

if docker info > /dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set (starts with nvapi-)"
else
  fail "NVIDIA_API_KEY not set or invalid — required for e2e-cloud-experimental (Cloud API)"
  exit 1
fi

if curl -sf --max-time 10 https://integrate.api.nvidia.com/v1/models > /dev/null 2>&1; then
  pass "Network access to integrate.api.nvidia.com"
else
  fail "Cannot reach integrate.api.nvidia.com"
  exit 1
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required for automated e2e-cloud-experimental segments"
  exit 1
else
  pass "NEMOCLAW_NON_INTERACTIVE=1"
fi

# Nominal scenario: Ubuntu + Docker (Linux + Docker in README). Others may still run; do not hard-fail on macOS.
if [[ "$(uname -s)" == "Linux" ]]; then
  pass "Host OS is Linux (nominal for e2e-cloud-experimental / README)"
else
  skip "Host is not Linux — e2e-cloud-experimental nominally targets Ubuntu (continuing)"
fi

if srv_ver=$(docker version -f '{{.Server.Version}}' 2>/dev/null) && [ -n "$srv_ver" ]; then
  pass "Docker server version reported (${srv_ver})"
else
  skip "Could not read docker server version from docker version"
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 2: Doc review — README hardware / software (VDR3 #11)
# ══════════════════════════════════════════════════════════════════════
# Deferred by request — not part of e2e-cloud-experimental for now.
section "Phase 2: Doc review (README prerequisites) — skipped"
skip "Phase 2: doc review (VDR3 #11) — not required for now"

# ══════════════════════════════════════════════════════════════════════
# Phase 3: Install + PATH (VDR3 #7, #10)
# ══════════════════════════════════════════════════════════════════════
# Public path: curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
# CI / dev from checkout: bash install.sh --non-interactive (same installer logic).
# VDR3 #12 (experimental + cloud + custom model): env is inherited by install.sh →
# nemoclaw onboard — no second onboard pass needed.
section "Phase 3: Install and PATH"

cd "$REPO" || { fail "Could not cd to repo root: $REPO"; exit 1; }

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_EXPERIMENTAL=1
export NEMOCLAW_PROVIDER=cloud
export NEMOCLAW_MODEL="$CLOUD_EXPERIMENTAL_MODEL"
export NEMOCLAW_POLICY_MODE="${NEMOCLAW_POLICY_MODE:-custom}"
export NEMOCLAW_POLICY_PRESETS="${NEMOCLAW_POLICY_PRESETS:-npm,pypi}"

info "Running install.sh --non-interactive (equivalent to curl|bash install path)..."
info "Onboard uses EXPERIMENTAL=1, PROVIDER=cloud, MODEL=${CLOUD_EXPERIMENTAL_MODEL} (override: NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL or legacy NEMOCLAW_SCENARIO_A_MODEL)."
info "Policy: NEMOCLAW_POLICY_MODE=${NEMOCLAW_POLICY_MODE} NEMOCLAW_POLICY_PRESETS=${NEMOCLAW_POLICY_PRESETS} (override env to change)."
info "Installs Node.js, openshell, NemoClaw, and runs onboard — may take several minutes."

INSTALL_LOG="/tmp/nemoclaw-e2e-cloud-experimental-install.log"
bash install.sh --non-interactive > "$INSTALL_LOG" 2>&1 &
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
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ "$install_exit" -eq 0 ]; then
  pass "install.sh --non-interactive completed (exit 0)"
else
  fail "install.sh failed (exit $install_exit)"
  exit 1
fi

if command -v nemoclaw > /dev/null 2>&1; then
  pass "nemoclaw on PATH ($(command -v nemoclaw))"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

if command -v openshell > /dev/null 2>&1; then
  pass "openshell on PATH ($(openshell --version 2>&1 || echo unknown))"
else
  fail "openshell not found on PATH after install"
  exit 1
fi

if nemoclaw --help > /dev/null 2>&1; then
  pass "nemoclaw --help exits 0"
else
  fail "nemoclaw --help failed"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5: Sandbox checks suite (test/e2e/e2e-cloud-experimental/checks/*.sh)
# ══════════════════════════════════════════════════════════════════════
# Ready scripts are sorted by filename; each must exit 0 on success. See e2e-cloud-experimental/README.md.
section "Phase 5: Sandbox checks suite (then Phase 5b chat + Phase 5c skill smoke in this script)"

export SANDBOX_NAME CLOUD_EXPERIMENTAL_MODEL REPO NVIDIA_API_KEY

shopt -s nullglob
case_scripts=( "$E2E_CLOUD_EXPERIMENTAL_READY_DIR"/*.sh )
shopt -u nullglob

if [ "${#case_scripts[@]}" -eq 0 ]; then
  skip "No checks scripts in ${E2E_CLOUD_EXPERIMENTAL_READY_DIR} (add checks/*.sh)"
else
  info "Checks directory: ${E2E_CLOUD_EXPERIMENTAL_READY_DIR} (${#case_scripts[@]} script(s))"
  for case_script in "${case_scripts[@]}"; do
    info "Running $(basename "$case_script")..."
    set +e
    bash "$case_script"
    c_rc=$?
    set -uo pipefail
    if [ "$c_rc" -eq 0 ]; then
      pass "case $(basename "$case_script" .sh)"
    else
      fail "case $(basename "$case_script" .sh) exited ${c_rc}"
      exit 1
    fi
  done
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5b: Live chat via inference.local (after all cases)
# ══════════════════════════════════════════════════════════════════════
# Same path as test-full-e2e.sh 4b: sandbox → gateway → cloud; model from CLOUD_EXPERIMENTAL_MODEL.
section "Phase 5b: Live chat (inference.local /v1/chat/completions)"

if ! command -v python3 > /dev/null 2>&1; then
  fail "Phase 5b: python3 not on PATH (needed to parse chat response)"
  exit 1
fi

payload=$(CLOUD_EXPERIMENTAL_MODEL="$CLOUD_EXPERIMENTAL_MODEL" python3 -c "
import json, os
print(json.dumps({
    'model': os.environ['CLOUD_EXPERIMENTAL_MODEL'],
    'messages': [{'role': 'user', 'content': 'Reply with exactly one word: PONG'}],
    'max_tokens': 100,
}))
") || { fail "Phase 5b: could not build chat JSON payload"; exit 1; }

info "POST chat completion inside sandbox (model ${CLOUD_EXPERIMENTAL_MODEL})..."

CHAT_TIMEOUT_CMD=""
command -v timeout > /dev/null 2>&1 && CHAT_TIMEOUT_CMD="timeout 120"
command -v gtimeout > /dev/null 2>&1 && CHAT_TIMEOUT_CMD="gtimeout 120"

ssh_config_chat="$(mktemp)"
sandbox_chat_out=""
if ! openshell sandbox ssh-config "$SANDBOX_NAME" > "$ssh_config_chat" 2>/dev/null; then
  rm -f "$ssh_config_chat"
  fail "Phase 5b: openshell sandbox ssh-config failed for '${SANDBOX_NAME}'"
  exit 1
fi

set +e
sandbox_chat_out=$(
  $CHAT_TIMEOUT_CMD ssh -F "$ssh_config_chat" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "curl -sS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d $(printf '%q' "$payload")" \
  2>&1
)
chat_ssh_rc=$?
set -euo pipefail
rm -f "$ssh_config_chat"

if [ "$chat_ssh_rc" -ne 0 ]; then
  fail "Phase 5b: ssh/curl failed (exit ${chat_ssh_rc}): ${sandbox_chat_out:0:400}"
  exit 1
fi

if [ -z "$sandbox_chat_out" ]; then
  fail "Phase 5b: empty response from inference.local chat completions"
  exit 1
fi

chat_text=$(printf '%s' "$sandbox_chat_out" | parse_chat_content 2>/dev/null) || chat_text=""
if echo "$chat_text" | grep -qi "PONG"; then
  pass "Phase 5b: chat completion returned PONG (model ${CLOUD_EXPERIMENTAL_MODEL})"
else
  fail "Phase 5b: expected PONG in assistant text, got: ${chat_text:0:300} (raw: ${sandbox_chat_out:0:400})"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5c: Skill smoke (repo Cursor skills + sandbox OpenClaw layout)
# ══════════════════════════════════════════════════════════════════════
# Repo: test/e2e/e2e-cloud-experimental/features/skill/lib/validate_repo_skills.py — every .agents/skills/*/SKILL.md
# Sandbox: test/e2e/e2e-cloud-experimental/features/skill/lib/validate_sandbox_openclaw_skills.sh — /sandbox/.openclaw + openclaw.json;
#   skills subdir is optional (migration); absent → honest SKIP (not PASS).
section "Phase 5c: Skill smoke (repo + sandbox OpenClaw)"

if ! command -v python3 > /dev/null 2>&1; then
  fail "Phase 5c: python3 not on PATH"
  exit 1
fi

info "Validating repo .agents/skills (SKILL.md frontmatter + body)..."
if ! python3 "$E2E_DIR/e2e-cloud-experimental/features/skill/lib/validate_repo_skills.py" --repo "$REPO"; then
  fail "Phase 5c: repo skill validation failed"
  exit 1
fi
pass "Phase 5c: repo agent skills (SKILL.md) valid"

info "Checking /sandbox/.openclaw inside sandbox..."
set +e
sb_out=$(SANDBOX_NAME="$SANDBOX_NAME" bash "$E2E_DIR/e2e-cloud-experimental/features/skill/lib/validate_sandbox_openclaw_skills.sh" 2>/dev/null)
sb_rc=$?
set -euo pipefail

if [ "$sb_rc" -ne 0 ]; then
  fail "Phase 5c: sandbox OpenClaw layout check failed (exit ${sb_rc}): ${sb_out:0:240}"
  exit 1
fi
pass "Phase 5c: sandbox /sandbox/.openclaw + openclaw.json OK"

if echo "$sb_out" | grep -q "SKILLS_SUBDIR=present"; then
  pass "Phase 5c: sandbox /sandbox/.openclaw/skills present"
elif echo "$sb_out" | grep -q "SKILLS_SUBDIR=absent"; then
  skip "Phase 5c: /sandbox/.openclaw/skills absent (host migration snapshot had no skills dir)"
else
  fail "Phase 5c: unexpected sandbox check output: ${sb_out:0:240}"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5d: Skill agent verification (inject + one-turn token check)
# ══════════════════════════════════════════════════════════════════════
# Deploy managed skill fixture into sandbox and verify one agent turn returns token.
section "Phase 5d: Skill agent verification (inject + token)"

info "Injecting skill-smoke-fixture into sandbox '${SANDBOX_NAME}'..."
if ! SANDBOX_NAME="$SANDBOX_NAME" SKILL_ID="skill-smoke-fixture" bash "$E2E_DIR/e2e-cloud-experimental/features/skill/add-sandbox-skill.sh"; then
  fail "Phase 5d: failed to inject/query skill-smoke-fixture"
  exit 1
fi
pass "Phase 5d: skill-smoke-fixture injected and queryable"

info "Running one openclaw agent turn to verify skill token..."
if ! NVIDIA_API_KEY="$NVIDIA_API_KEY" SANDBOX_NAME="$SANDBOX_NAME" SKILL_ID="skill-smoke-fixture" bash "$E2E_DIR/e2e-cloud-experimental/features/skill/verify-sandbox-skill-via-agent.sh"; then
  fail "Phase 5d: agent verification did not return skill token"
  exit 1
fi
pass "Phase 5d: agent returned SKILL_SMOKE_VERIFY_K9X2"

# ══════════════════════════════════════════════════════════════════════
# Phase 6: Final cleanup (mirror Phase 0; leave machine tidy after E2E)
# ══════════════════════════════════════════════════════════════════════
# nemoclaw destroy clears registry; openshell sandbox delete + forward stop + gateway destroy.
section "Phase 6: Final cleanup"

if [ "${RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_FINAL_CLEANUP:-${RUN_SCENARIO_A_SKIP_FINAL_CLEANUP:-}}" = "1" ]; then
  skip "Phase 6: final cleanup skipped (RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_FINAL_CLEANUP=1)"
else
  info "Removing sandbox '${SANDBOX_NAME}', port forward, and nemoclaw gateway..."

  if command -v nemoclaw > /dev/null 2>&1; then
    nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
  fi
  if command -v openshell > /dev/null 2>&1; then
    openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
    openshell forward stop 18789 2>/dev/null || true
    openshell gateway destroy -g nemoclaw 2>/dev/null || true
  fi

  if command -v openshell > /dev/null 2>&1; then
    if openshell sandbox get "$SANDBOX_NAME" >/dev/null 2>&1; then
      fail "openshell sandbox get '${SANDBOX_NAME}' still succeeds after cleanup"
      exit 1
    fi
    pass "openshell: sandbox '${SANDBOX_NAME}' no longer visible to sandbox get"
  else
    skip "openshell not on PATH — skipped sandbox get check after cleanup"
  fi

  if command -v nemoclaw > /dev/null 2>&1; then
    set +e
    list_out=$(nemoclaw list 2>&1)
    list_rc=$?
    set -uo pipefail
    if [ "$list_rc" -eq 0 ]; then
      if echo "$list_out" | grep -Fq "    ${SANDBOX_NAME}"; then
        fail "nemoclaw list still lists '${SANDBOX_NAME}' after destroy"
        exit 1
      fi
      pass "nemoclaw list: '${SANDBOX_NAME}' removed from registry"
    else
      skip "nemoclaw list failed after cleanup — could not verify registry (exit $list_rc)"
    fi
  else
    skip "nemoclaw not on PATH — skipped list check after cleanup"
  fi

  pass "Phase 6: final cleanup complete"
fi

# ══════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  e2e-cloud-experimental Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  if [ "$SKIP" -gt 0 ]; then
    printf '\033[1;33m\n  e2e-cloud-experimental: Phases 0–1, 3 + case suite + Phase 5b/5c/5d + cleanup done; %d check(s) skipped (includes Phase 2 + optional skips).\033[0m\n' "$SKIP"
  else
    printf '\033[1;32m\n  e2e-cloud-experimental PASSED.\033[0m\n'
  fi
  exit 0
else
  printf '\033[1;31m\n  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
