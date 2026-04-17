#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# e2e-cloud-experimental — Ubuntu + Docker CE + experimental mode + Cloud API
#
# Focus: experimental / policy / network / security (VDR3 + internal bugs).
# Implemented: Phase 0–1, 3, 5–6. Phase 5 runs checks/*.sh; Phase 5b live chat; Phase 5c skill smoke; Phase 5d skill agent verification; Phase 5f check-docs.sh;
# Phase 5e openclaw TUI smoke (expect, non-interactive); Phase 5f check-docs.sh; Phase 6 final cleanup.
# Phase 3 default: expect-driven interactive curl|bash (RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL=1).
#   Set RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL=0 for non-interactive install (NEMOCLAW_NON_INTERACTIVE=1 and NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1, no expect).
# (add checks under e2e-cloud-experimental/checks without editing case loop). VDR3 #12 via env on Phase 3 install.
# Phase 2 skipped. Phase 5: checks suite (checks/*.sh only; opt-in scripts live under e2e-cloud-experimental/skip/).
# Phase 5b: POST /v1/chat/completions inside sandbox (model = CLOUD_EXPERIMENTAL_MODEL); retries on transient gateway/upstream failures.
# Phase 5c: validate repo .agents/skills; verify /sandbox/.openclaw inside sandbox (skills subdir optional → SKIP if absent).
# Phase 5d: inject skill-smoke-fixture into sandbox and verify token via openclaw agent.
# Phase 5e: nemoclaw connect → openclaw tui → send message → repeated Ctrl+C → exit (requires `expect`; skipped if missing or RUN_E2E_CLOUD_EXPERIMENTAL_TUI=0).
# Phase 5f: check-docs.sh (Markdown links + nemoclaw --help vs commands.md) before Phase 6; skip with RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_CHECK_DOCS=1.
#   Inherits CHECK_DOC_LINKS_REMOTE (check-docs.sh defaults to 1 — curl unique http(s) links); set CHECK_DOC_LINKS_REMOTE=0 to skip remote probes only.
# Phase 6: cleanup via e2e-cloud-experimental/cleanup.sh --verify (skipped when RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5=1 or RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_FINAL_CLEANUP=1).
# Phase 0 pre-cleanup uses the same script without --verify.
#
# Phase tags (optional — slice the suite without editing the script):
#   E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS — comma-separated whitelist; unset or "all" = run every phase (still subject to FROM_PHASE5 / SKIP_FINAL_CLEANUP / etc.).
#     Example: phase3,phase5b,phase5f
#   E2E_CLOUD_EXPERIMENTAL_SKIP_TAGS — comma-separated blacklist applied after ONLY (or alone when ONLY is unset).
#     Example: phase0,phase6,phase5e
#   Tag names: phase0 phase1 phase2 phase3 phase5 phase5b phase5c phase5d phase5e phase5f phase6
#   Sub-phases (5b–5f) are independent; skipping phase5 does not skip 5b. You must list each phase you want when using ONLY_TAGS.
# VDR3 #14 (re-onboard / volume audit) not automated here.
#
# Optional (not run here): port-8080 onboard conflict — see test/e2e/test-port8080-conflict.sh
#
# Prerequisites (when fully implemented):
#   - Docker running (Docker CE on Ubuntu for the nominal scenario)
#   - NVIDIA_API_KEY set (nvapi-...) for Cloud inference segments
#   - Network to integrate.api.nvidia.com
#   - NEMOCLAW_NON_INTERACTIVE=1 for automated onboard segments
#   - NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 for automated non-interactive install/onboard segments
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
#   RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL — default 1: Phase 3 uses expect to drive interactive onboard.
#     Set to 0 for non-interactive curl|bash (requires NEMOCLAW_NON_INTERACTIVE=1 and NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 in host env; no expect on PATH).
#   INTERACTIVE_SANDBOX_NAME / INTERACTIVE_RECREATE_ANSWER / INTERACTIVE_INFERENCE_SEND / INTERACTIVE_MODEL_SEND / INTERACTIVE_PRESETS_SEND — see Phase 3 expect branch
#   DEMO_FAKE_ONLY=1 — expect-only smoke, exit before Phase 0 (offline)
#   RUN_E2E_CLOUD_EXPERIMENTAL_TUI=0 — skip Phase 5e (openclaw tui expect smoke)
#   OPENCLAW_TUI_AUTO_MESSAGE — message sent inside TUI (default: 你好)
#   OPENCLAW_TUI_SEND_DELAY_SEC — seconds after `openclaw tui` before sending message (default: 3)
#   OPENCLAW_TUI_AFTER_MESSAGE_SEC — seconds after sending message before waiting for quit hint (default: 28; allow model to finish)
#   OPENCLAW_TUI_POST_REPLY_DRAIN_SEC — extra sleep after reply (footer is often "connected | idle", not the quit hint yet) (default: 6)
#   OPENCLAW_TUI_HINT_TIMEOUT_SEC — max seconds after first Ctrl+C to see "again to exit" or shell before fallback burst (default: 180)
#   OPENCLAW_TUI_CTRL_C_COUNT — fallback burst if still not back at shell (default: 8)
#   OPENCLAW_TUI_QUIT_SLEEP_SEC — pause between Ctrl+C sends (default: 3)
#   RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5=1 — skip Phase 0 + Phase 3; run Phase 1 then Phase 5–5e; skip Phase 6 unless FROM_PHASE5_RUN_CLEANUP=1
#     For an already-provisioned sandbox; set NEMOCLAW_SANDBOX_NAME when the name is not e2e-cloud-experimental
#   RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5_RUN_CLEANUP=1 — with FROM_PHASE5, still run Phase 6 final cleanup
#   RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_FINAL_CLEANUP=1 — leave sandbox/gateway up (local debugging); legacy: RUN_SCENARIO_A_SKIP_FINAL_CLEANUP=1
#   NEMOCLAW_INSTALL_SCRIPT_URL — optional override for Phase 3 curl URL (default: https://www.nvidia.com/nemoclaw.sh)
#   E2E_PHASE_5B_MAX_ATTEMPTS — Phase 5b chat retries (default: 3); set to 1 to disable retry
#   E2E_PHASE_5B_RETRY_SLEEP_SEC — seconds between Phase 5b attempts (default: 15)
#   E2E_CLOUD_EXPERIMENTAL_INSTALL_LOG — Phase 3 install log path (default: /tmp/nemoclaw-e2e-cloud-experimental-install.log)
#   RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_CHECK_DOCS=1 — skip Phase 5f (check-docs.sh)
#   CHECK_DOC_LINKS_REMOTE=0 — Phase 5f: skip curling http(s) doc links only (default in check-docs.sh: remote checks on)
#   E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS — see header: whitelist phases (e.g. phase5b,phase5c)
#   E2E_CLOUD_EXPERIMENTAL_SKIP_TAGS — see header: blacklist phases (e.g. phase6,phase5e)
#
# Usage (Phases 0–1, 3 + cases + Phase 5b–5f + Phase 6 cleanup; Phase 2 skipped):
#   NVIDIA_API_KEY=nvapi-... bash test/e2e/test-e2e-cloud-experimental.sh
#   Non-interactive install (no expect): RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL=0 NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 NVIDIA_API_KEY=nvapi-... bash ...
#
# Validate only (existing sandbox; no install, no Phase 0/6 teardown):
#   RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5=1 NVIDIA_API_KEY=nvapi-... bash test/e2e/test-e2e-cloud-experimental.sh
#   RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5=1 NEMOCLAW_SANDBOX_NAME=my-sbx NVIDIA_API_KEY=nvapi-... bash ...
#
# Phase 3 uses the public installer: curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
# (env below is exported before that run). Checkout root is still required for Phase 5c repo skills.
#
# Phase 3 (default): expect answers onboard prompts (inlined from e2e-cloud-experimental/expect-interactive-install.sh).
# Requires expect on PATH unless RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL=0.
# Phase 1 does not require NEMOCLAW_NON_INTERACTIVE when interactive install is enabled (default).
# DEMO_FAKE_ONLY=1 — run only a tiny expect self-test, then exit 0 (no install, no Phase 0+).

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

# Tag filter: ONLY_TAGS whitelist (unset or "all" = allow all); SKIP_TAGS always removes listed phases.
e2e_cloud_experimental_phase_enabled() {
  local phase="$1"
  local only="${E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS:-}"
  local sk="${E2E_CLOUD_EXPERIMENTAL_SKIP_TAGS:-}"
  local tok
  local IFS=,

  for tok in $sk; do
    tok="${tok// /}"
    [ -z "$tok" ] && continue
    if [ "$tok" = "$phase" ]; then
      return 1
    fi
  done

  if [ -z "$only" ] || [ "$only" = "all" ]; then
    return 0
  fi

  for tok in $only; do
    tok="${tok// /}"
    [ -z "$tok" ] && continue
    if [ "$tok" = "$phase" ]; then
      return 0
    fi
  done
  return 1
}

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

# ── Repo root (checkout; used for Phase 5c skill validation — not for Phase 3 install) ──
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

CLOUD_EXPERIMENTAL_MODEL="${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-${NEMOCLAW_SCENARIO_A_MODEL:-moonshotai/kimi-k2.5}}"
E2E_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_CLOUD_EXPERIMENTAL_READY_DIR="${E2E_DIR}/e2e-cloud-experimental/checks"

if [ "${RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL:-1}" = "1" ]; then
  SANDBOX_NAME="${INTERACTIVE_SANDBOX_NAME:-e2e-cloud-experimental}"
else
  SANDBOX_NAME="e2e-cloud-experimental"
fi

if [ "${RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5:-0}" = "1" ]; then
  SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-$SANDBOX_NAME}"
fi

# ── DEMO_FAKE_ONLY: offline expect sanity check (exits before Phase 0) ──
if [[ "${DEMO_FAKE_ONLY:-0}" == "1" ]]; then
  section "DEMO_FAKE_ONLY: expect smoke (no network)"
  if ! command -v expect >/dev/null 2>&1; then
    echo "ERROR: expect not on PATH." >&2
    exit 1
  fi
  fake_installer="$(mktemp)"
  trap 'rm -f "$fake_installer"' EXIT
  cat >"$fake_installer" <<'INSTALLER'
#!/bin/bash
set -e
read -r -p "Continue with demo install? [y/N]: " a
[[ "${a:-}" =~ ^[yY] ]] || exit 1
read -r -p "Sandbox name: " name
echo "Using sandbox: ${name:-demo-sandbox}"
read -r -p "Proceed? [y/N]: " b
[[ "${b:-}" =~ ^[yY] ]] || exit 1
echo "INSTALL_DEMO_OK"
INSTALLER
  chmod +x "$fake_installer"
  expect <<EOF
set timeout 30
spawn bash "$fake_installer"
expect {
  -re {Continue with demo install} { send "y\r"; exp_continue }
  -re {Sandbox name:}             { send "e2e-demo-sandbox\r"; exp_continue }
  -re {Proceed\\?}               { send "y\r"; exp_continue }
  "INSTALL_DEMO_OK"             { exit 0 }
  timeout                       { exit 1 }
  eof                           { exit 0 }
}
EOF
  pass "DEMO_FAKE_ONLY OK"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════════
# Destroy leftover sandbox / gateway / forwards from prior runs.
# nemoclaw destroy clears ~/.nemoclaw/sandboxes.json; align with test-double-onboard.sh.
section "Phase 0: Pre-cleanup"

if ! e2e_cloud_experimental_phase_enabled phase0; then
  skip "Phase 0: skipped by tag (phase0 — set E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS / SKIP_TAGS)"
elif [ "${RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5:-0}" = "1" ]; then
  skip "Phase 0: pre-cleanup skipped (RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5=1 — preserving sandbox '${SANDBOX_NAME}')"
else
  info "Destroying leftover sandbox, forwards, and gateway for '${SANDBOX_NAME}'..."
  SANDBOX_NAME="$SANDBOX_NAME" bash "${E2E_DIR}/e2e-cloud-experimental/cleanup.sh"
  pass "Pre-cleanup complete"
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 1: Prerequisites
# ══════════════════════════════════════════════════════════════════════
# Docker running; NVIDIA_API_KEY format; reach integrate.api.nvidia.com;
# NEMOCLAW_NON_INTERACTIVE=1 and NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 for automated path; optional: assert Linux + Docker CE.
section "Phase 1: Prerequisites"

if ! e2e_cloud_experimental_phase_enabled phase1; then
  skip "Phase 1: skipped by tag (phase1 — set E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS / SKIP_TAGS)"
elif docker info >/dev/null 2>&1; then
  pass "Docker is running"

  if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
    pass "NVIDIA_API_KEY is set (starts with nvapi-)"
  else
    fail "NVIDIA_API_KEY not set or invalid — required for e2e-cloud-experimental (Cloud API)"
    exit 1
  fi

  if curl -sf --max-time 10 https://integrate.api.nvidia.com/v1/models >/dev/null 2>&1; then
    pass "Network access to integrate.api.nvidia.com"
  else
    fail "Cannot reach integrate.api.nvidia.com"
    exit 1
  fi

  if [ "${RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5:-0}" = "1" ]; then
    pass "Phase 1: FROM_PHASE5 mode (NEMOCLAW_NON_INTERACTIVE not required)"
  elif [ "${RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL:-1}" = "1" ]; then
    pass "Phase 1: interactive install mode (NEMOCLAW_NON_INTERACTIVE not required on host)"
  elif [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
    fail "NEMOCLAW_NON_INTERACTIVE=1 is required when RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL=0 (or use default interactive install, or RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5=1)"
    exit 1
  elif [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
    fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required when RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL=0"
    exit 1
  else
    pass "NEMOCLAW_NON_INTERACTIVE=1"
    pass "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1"
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
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 2: Doc review — README hardware / software (VDR3 #11)
# ══════════════════════════════════════════════════════════════════════
# Deferred by request — not part of e2e-cloud-experimental for now.
section "Phase 2: Doc review (README prerequisites) — skipped"

if ! e2e_cloud_experimental_phase_enabled phase2; then
  skip "Phase 2: skipped by tag (phase2 — set E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS / SKIP_TAGS)"
else
  skip "Phase 2: doc review (VDR3 #11) — not required for now"
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 3: Install + PATH (VDR3 #7, #10)
# ══════════════════════════════════════════════════════════════════════
# Install: curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
# VDR3 #12 (experimental + cloud + custom model): env is inherited by the installer →
# nemoclaw onboard — no second onboard pass needed.
section "Phase 3: Install and PATH"

if ! e2e_cloud_experimental_phase_enabled phase3; then
  skip "Phase 3: skipped by tag (phase3 — set E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS / SKIP_TAGS)"
elif ! cd "$REPO"; then
  fail "Could not cd to repo root: $REPO"
  exit 1
else
  export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
  export NEMOCLAW_EXPERIMENTAL=1
  export NEMOCLAW_PROVIDER=cloud
  export NEMOCLAW_MODEL="$CLOUD_EXPERIMENTAL_MODEL"
  export NEMOCLAW_POLICY_MODE="${NEMOCLAW_POLICY_MODE:-custom}"
  export NEMOCLAW_POLICY_PRESETS="${NEMOCLAW_POLICY_PRESETS:-npm,pypi}"

  NEMOCLAW_INSTALL_SCRIPT_URL="${NEMOCLAW_INSTALL_SCRIPT_URL:-https://www.nvidia.com/nemoclaw.sh}"
  export NEMOCLAW_INSTALL_SCRIPT_URL

  # Override when running in Docker CI with a host-mounted log dir (see test/e2e/Dockerfile.cloud-experimental).
  INSTALL_LOG="${E2E_CLOUD_EXPERIMENTAL_INSTALL_LOG:-/tmp/nemoclaw-e2e-cloud-experimental-install.log}"

  if [ "${RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5:-0}" = "1" ]; then
    info "Phase 3: skipping curl|bash install (RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5=1)"
    install_exit=0
  elif [ "${RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL:-1}" = "1" ]; then
    if ! command -v expect >/dev/null 2>&1; then
      fail "Phase 3: expect not on PATH (install expect, or set RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL=0 for non-interactive install)"
      exit 1
    fi
    export INTERACTIVE_SANDBOX_NAME="${INTERACTIVE_SANDBOX_NAME:-$SANDBOX_NAME}"
    export INTERACTIVE_RECREATE_ANSWER="${INTERACTIVE_RECREATE_ANSWER:-n}"
    export INTERACTIVE_INFERENCE_SEND="${INTERACTIVE_INFERENCE_SEND:-}"
    export INTERACTIVE_MODEL_SEND="${INTERACTIVE_MODEL_SEND:-}"
    export INTERACTIVE_PRESETS_SEND="${INTERACTIVE_PRESETS_SEND:-y}"
    info "Phase 3: expect-driven interactive curl|bash (URL=${NEMOCLAW_INSTALL_SCRIPT_URL}, sandbox=${INTERACTIVE_SANDBOX_NAME})"
    info "Output streams to this terminal AND ${INSTALL_LOG} (via tee) — first prompts may take several minutes after curl/Node install."
    if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
      info "WARN: NVIDIA_API_KEY unset; expect will fail at API key prompt unless credentials exist on disk."
    fi
    set +e
    expect <<'EXPECT' 2>&1 | tee "$INSTALL_LOG"
set timeout -1

if {![info exists env(NEMOCLAW_INSTALL_SCRIPT_URL)]} {
  set url "https://www.nvidia.com/nemoclaw.sh"
} else {
  set url $env(NEMOCLAW_INSTALL_SCRIPT_URL)
}

set sandbox $env(INTERACTIVE_SANDBOX_NAME)
set recreate $env(INTERACTIVE_RECREATE_ANSWER)
set infer_send $env(INTERACTIVE_INFERENCE_SEND)
set model_send $env(INTERACTIVE_MODEL_SEND)
set presets_send $env(INTERACTIVE_PRESETS_SEND)

if {![info exists env(NVIDIA_API_KEY)]} {
  set apikey ""
} else {
  set apikey $env(NVIDIA_API_KEY)
}

log_user 1

spawn bash -c "exec 3<>/dev/tty; unset NEMOCLAW_NON_INTERACTIVE; export NEMOCLAW_NON_INTERACTIVE=; curl -fsSL \"$url\" | bash"

expect {
  eof { exit 0 }

  -re {Sandbox name \(lowercase} {
    send "$sandbox\r"
    exp_continue
  }

  -re {already exists\. Recreate\?} {
    send "$recreate\r"
    exp_continue
  }

  -re {Choose \[[0-9]+\]: } {
    send "$infer_send\r"
    exp_continue
  }

  -re {NVIDIA API Key:} {
    if {$apikey eq ""} {
      puts stderr "expect: got NVIDIA API Key prompt but NVIDIA_API_KEY is empty"
      exit 1
    }
    send "$apikey\r"
    exp_continue
  }

  -re {Choose model} {
    send "$model_send\r"
    exp_continue
  }

  -re {Apply suggested presets} {
    send "$presets_send\r"
    exp_continue
  }

  -re {Enter preset names} {
    send "pypi,npm\r"
    exp_continue
  }

  timeout {
    puts stderr "expect: unexpected timeout"
    exit 1
  }
}
EXPECT
    install_exit=${PIPESTATUS[0]}
    set -uo pipefail
  else
    info "Running: curl -fsSL ${NEMOCLAW_INSTALL_SCRIPT_URL} | bash"
    info "Onboard uses EXPERIMENTAL=1, PROVIDER=cloud, MODEL=${CLOUD_EXPERIMENTAL_MODEL} (override: NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL or legacy NEMOCLAW_SCENARIO_A_MODEL)."
    info "Policy: NEMOCLAW_POLICY_MODE=${NEMOCLAW_POLICY_MODE} NEMOCLAW_POLICY_PRESETS=${NEMOCLAW_POLICY_PRESETS} (override env to change)."
    info "Installs Node.js, openshell, NemoClaw, and runs onboard — may take several minutes."

    curl -fsSL "$NEMOCLAW_INSTALL_SCRIPT_URL" | bash >"$INSTALL_LOG" 2>&1 &
    install_pid=$!
    tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
    tail_pid=$!
    wait "$install_pid"
    install_exit=$?
    kill "$tail_pid" 2>/dev/null || true
    wait "$tail_pid" 2>/dev/null || true
  fi

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
    if [ "${RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5:-0}" = "1" ]; then
      pass "Phase 3: install skipped (FROM_PHASE5); using existing sandbox '${SANDBOX_NAME}'"
    elif [ "${RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL:-1}" = "1" ]; then
      pass "public install (expect interactive curl|bash) completed (exit 0)"
    else
      pass "public install (curl nemoclaw.sh | bash) completed (exit 0)"
    fi
  else
    if [ "${RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL:-1}" = "1" ]; then
      fail "public install (expect interactive curl|bash) failed (exit $install_exit)"
    else
      fail "public install (curl nemoclaw.sh | bash) failed (exit $install_exit)"
    fi
    exit 1
  fi

  if command -v nemoclaw >/dev/null 2>&1; then
    pass "nemoclaw on PATH ($(command -v nemoclaw))"
  else
    _e2e_path_ctx="after install"
    [ "${RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5:-0}" = "1" ] && _e2e_path_ctx="required for Phase 5"
    fail "nemoclaw not found on PATH (${_e2e_path_ctx})"
    exit 1
  fi

  if command -v openshell >/dev/null 2>&1; then
    pass "openshell on PATH ($(openshell --version 2>&1 || echo unknown))"
  else
    _e2e_path_ctx="after install"
    [ "${RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5:-0}" = "1" ] && _e2e_path_ctx="required for Phase 5"
    fail "openshell not found on PATH (${_e2e_path_ctx})"
    exit 1
  fi

  if nemoclaw --help >/dev/null 2>&1; then
    pass "nemoclaw --help exits 0"
  else
    fail "nemoclaw --help failed"
    exit 1
  fi

fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5: Sandbox checks suite (test/e2e/e2e-cloud-experimental/checks/*.sh)
# ══════════════════════════════════════════════════════════════════════
# Ready scripts are sorted by filename; each must exit 0 on success. See e2e-cloud-experimental/README.md.
section "Phase 5: Sandbox checks suite (then Phase 5b chat + Phase 5c skill smoke in this script)"

if ! e2e_cloud_experimental_phase_enabled phase5; then
  skip "Phase 5: skipped by tag (phase5 — checks/*.sh only; 5b–5f use their own tags)"
else
  export SANDBOX_NAME CLOUD_EXPERIMENTAL_MODEL REPO NVIDIA_API_KEY

  # Ensure PATH includes /usr/local/bin and ~/.local/bin so child bash
  # processes (checks/*.sh) can find openshell and other tools installed
  # during Phase 3. Without this, check scripts exit 127. (#1969)
  export PATH="/usr/local/bin:${HOME}/.local/bin:${PATH}"

  shopt -s nullglob
  case_scripts=("$E2E_CLOUD_EXPERIMENTAL_READY_DIR"/*.sh)
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
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5b: Live chat via inference.local (after all cases)
# ══════════════════════════════════════════════════════════════════════
# Same path as test-full-e2e.sh 4b: sandbox → gateway → cloud; model from CLOUD_EXPERIMENTAL_MODEL.
section "Phase 5b: Live chat (inference.local /v1/chat/completions)"

if ! e2e_cloud_experimental_phase_enabled phase5b; then
  skip "Phase 5b: skipped by tag (phase5b — set E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS / SKIP_TAGS)"
else
  if ! command -v python3 >/dev/null 2>&1; then
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
") || {
    fail "Phase 5b: could not build chat JSON payload"
    exit 1
  }

  PHASE_5B_MAX="${E2E_PHASE_5B_MAX_ATTEMPTS:-3}"
  PHASE_5B_SLEEP="${E2E_PHASE_5B_RETRY_SLEEP_SEC:-5}"
  # Clamp to at least 1 attempt
  if ! [[ "$PHASE_5B_MAX" =~ ^[1-9][0-9]*$ ]]; then
    PHASE_5B_MAX=3
  fi
  info "POST chat completion inside sandbox (model ${CLOUD_EXPERIMENTAL_MODEL}, up to ${PHASE_5B_MAX} attempt(s), ${PHASE_5B_SLEEP}s between retries)..."

  CHAT_TIMEOUT_CMD=""
  command -v timeout >/dev/null 2>&1 && CHAT_TIMEOUT_CMD="timeout 120"
  command -v gtimeout >/dev/null 2>&1 && CHAT_TIMEOUT_CMD="gtimeout 120"

  ssh_config_chat="$(mktemp)"
  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config_chat" 2>/dev/null; then
    rm -f "$ssh_config_chat"
    fail "Phase 5b: openshell sandbox ssh-config failed for '${SANDBOX_NAME}'"
    exit 1
  fi

  phase_5b_attempt=1
  phase_5b_ok=0
  phase_5b_last_fail=""
  while [ "$phase_5b_attempt" -le "$PHASE_5B_MAX" ]; do
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
    set -uo pipefail

    if [ "$chat_ssh_rc" -ne 0 ]; then
      phase_5b_last_fail="Phase 5b: ssh/curl failed (exit ${chat_ssh_rc}): ${sandbox_chat_out:0:400}"
    elif [ -z "$sandbox_chat_out" ]; then
      phase_5b_last_fail="Phase 5b: empty response from inference.local chat completions"
    else
      chat_text=$(printf '%s' "$sandbox_chat_out" | parse_chat_content 2>/dev/null) || chat_text=""
      if echo "$chat_text" | grep -qi "PONG"; then
        pass "Phase 5b: chat completion returned PONG (model ${CLOUD_EXPERIMENTAL_MODEL}, attempt ${phase_5b_attempt}/${PHASE_5B_MAX})"
        phase_5b_ok=1
        break
      fi
      phase_5b_last_fail="Phase 5b: expected PONG in assistant text, got: ${chat_text:0:300} (raw: ${sandbox_chat_out:0:400})"
    fi

    if [ "$phase_5b_attempt" -ge "$PHASE_5B_MAX" ]; then
      break
    fi
    info "Phase 5b: attempt ${phase_5b_attempt}/${PHASE_5B_MAX} failed — ${phase_5b_last_fail#Phase 5b: }"
    info "Phase 5b: sleeping ${PHASE_5B_SLEEP}s before retry..."
    sleep "$PHASE_5B_SLEEP"
    phase_5b_attempt=$((phase_5b_attempt + 1))
  done

  rm -f "$ssh_config_chat"

  if [ "$phase_5b_ok" -ne 1 ]; then
    fail "$phase_5b_last_fail"
    exit 1
  fi

fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5c: Skill smoke (repo Cursor skills + sandbox OpenClaw layout)
# ══════════════════════════════════════════════════════════════════════
# Repo: test/e2e/e2e-cloud-experimental/features/skill/lib/validate_repo_skills.sh — every .agents/skills/*/SKILL.md
# Sandbox: test/e2e/e2e-cloud-experimental/features/skill/lib/validate_sandbox_openclaw_skills.sh — /sandbox/.openclaw + openclaw.json;
#   skills subdir is optional (migration); absent → honest SKIP (not PASS).
section "Phase 5c: Skill smoke (repo + sandbox OpenClaw)"

if ! e2e_cloud_experimental_phase_enabled phase5c; then
  skip "Phase 5c: skipped by tag (phase5c — set E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS / SKIP_TAGS)"
else
  info "Validating repo .agents/skills (SKILL.md frontmatter + body)..."
  if ! bash "$E2E_DIR/e2e-cloud-experimental/features/skill/lib/validate_repo_skills.sh" --repo "$REPO"; then
    fail "Phase 5c: repo skill validation failed"
    exit 1
  fi
  pass "Phase 5c: repo agent skills (SKILL.md) valid"

  info "Checking /sandbox/.openclaw inside sandbox..."
  set +e
  sb_out=$(SANDBOX_NAME="$SANDBOX_NAME" bash "$E2E_DIR/e2e-cloud-experimental/features/skill/lib/validate_sandbox_openclaw_skills.sh" 2>/dev/null)
  sb_rc=$?
  set -uo pipefail

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

fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5d: Skill agent verification (inject + one-turn token check)
# ══════════════════════════════════════════════════════════════════════
# Deploy managed skill fixture into sandbox and verify one agent turn returns token.
section "Phase 5d: Skill agent verification (inject + token)"

if ! e2e_cloud_experimental_phase_enabled phase5d; then
  skip "Phase 5d: skipped by tag (phase5d — set E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS / SKIP_TAGS)"
else
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

fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5e: OpenClaw TUI smoke (nemoclaw connect → tui → message → Ctrl+C → exit)
# ══════════════════════════════════════════════════════════════════════
# TUI automation lives HERE as an expect(1) heredoc — not by calling
# e2e-cloud-experimental/openclaw-tui-in-sandbox.sh (that wrapper uses `interact` for humans).
section "Phase 5e: OpenClaw TUI smoke (expect)"

if ! e2e_cloud_experimental_phase_enabled phase5e; then
  skip "Phase 5e: skipped by tag (phase5e — set E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS / SKIP_TAGS)"
elif [ "${RUN_E2E_CLOUD_EXPERIMENTAL_TUI:-1}" = "0" ]; then
  skip "Phase 5e: skipped (RUN_E2E_CLOUD_EXPERIMENTAL_TUI=0)"
elif ! command -v expect >/dev/null 2>&1; then
  skip "Phase 5e: expect not on PATH — install expect to run TUI smoke (e.g. apt install expect)"
else
  TUI_MSG="${OPENCLAW_TUI_AUTO_MESSAGE:-你好}"
  TUI_SEND_DELAY="${OPENCLAW_TUI_SEND_DELAY_SEC:-3}"
  TUI_AFTER_MSG="${OPENCLAW_TUI_AFTER_MESSAGE_SEC:-28}"
  TUI_DRAIN="${OPENCLAW_TUI_POST_REPLY_DRAIN_SEC:-6}"
  TUI_HINT_TIMEOUT="${OPENCLAW_TUI_HINT_TIMEOUT_SEC:-180}"
  TUI_CTRL_C_COUNT="${OPENCLAW_TUI_CTRL_C_COUNT:-8}"
  TUI_QUIT_SLEEP="${OPENCLAW_TUI_QUIT_SLEEP_SEC:-3}"
  if ! [[ "$TUI_HINT_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
    TUI_HINT_TIMEOUT=180
  fi
  if ! [[ "$TUI_CTRL_C_COUNT" =~ ^[1-9][0-9]*$ ]]; then
    TUI_CTRL_C_COUNT=8
  fi
  if ! [[ "$TUI_QUIT_SLEEP" =~ ^[1-9][0-9]*$ ]]; then
    TUI_QUIT_SLEEP=3
  fi
  export E2E_TUI_SANDBOX="$SANDBOX_NAME"
  export E2E_TUI_MSG="$TUI_MSG"
  export E2E_TUI_SEND_DELAY="$TUI_SEND_DELAY"
  export E2E_TUI_AFTER_MSG="$TUI_AFTER_MSG"
  export E2E_TUI_DRAIN_SEC="$TUI_DRAIN"
  export E2E_TUI_HINT_TIMEOUT_SEC="$TUI_HINT_TIMEOUT"
  export E2E_TUI_CTRL_C_COUNT="$TUI_CTRL_C_COUNT"
  export E2E_TUI_QUIT_SLEEP_SEC="$TUI_QUIT_SLEEP"
  info "Running expect: nemoclaw connect → openclaw tui → message → quit TUI with ≥2× Ctrl+C (banner path: 2× immediately; else: 2× then wait for banner/shell; fallback burst ${TUI_CTRL_C_COUNT}×)..."
  set +e
  expect <<'E2E_EXPECT_TUI'
set timeout 300
set sandbox $env(E2E_TUI_SANDBOX)
set auto_msg $env(E2E_TUI_MSG)
set send_delay $env(E2E_TUI_SEND_DELAY)
set after_msg $env(E2E_TUI_AFTER_MSG)
set drain_sec $env(E2E_TUI_DRAIN_SEC)
set hint_timeout $env(E2E_TUI_HINT_TIMEOUT_SEC)
set cc_count $env(E2E_TUI_CTRL_C_COUNT)
set quit_sleep $env(E2E_TUI_QUIT_SLEEP_SEC)
# Sandbox shell prompt: include % (zsh); do not require a trailing space before EOL.
set prompt_re {[$#%>]\s*$}
spawn nemoclaw $sandbox connect
expect {
  -re $prompt_re {}
  timeout { puts stderr "Phase 5e: timeout waiting for sandbox shell prompt"; exit 1 }
  eof { puts stderr "Phase 5e: eof before sandbox shell prompt"; exit 1 }
}
send "openclaw tui\r"
sleep $send_delay
sleep 2
send -- "$auto_msg\r"
sleep $after_msg
sleep $drain_sec
# If the footer already shows "press ctrl+c again to exit", send 2× Ctrl+C immediately.
# Otherwise send at least 2× Ctrl+C first, then wait for the banner or shell (may send 2× more if banner appears).
set phase need_first_interrupt
set timeout 5
expect {
  -re {(?i)again to exit} { set phase quit_from_banner }
  timeout {}
}
if {$phase eq "quit_from_banner"} {
  send "\003"
  sleep $quit_sleep
  send "\003"
  sleep $quit_sleep
} else {
  send "\003"
  sleep $quit_sleep
  send "\003"
  sleep $quit_sleep
  set timeout $hint_timeout
  expect {
    -re {(?i)again to exit} {
      send "\003"
      sleep $quit_sleep
      send "\003"
      sleep $quit_sleep
    }
    -re $prompt_re {}
    eof { exit 0 }
    timeout {
      puts stderr "Phase 5e: no shell or 'again to exit' after first Ctrl+C — second + fallback burst"
      send "\003"
      sleep $quit_sleep
      for {set i 0} {$i < $cc_count} {incr i} {
        send "\003"
        sleep $quit_sleep
      }
    }
  }
}
# Prompt regex uses $ = end of the ENTIRE expect buffer. After the TUI, the buffer
# often ends with box-drawing or a blank line, not "sandbox@...$", so matching fails.
# Wake the line discipline, then fall back to a shell-only echo marker.
set saw_shell 0
send "\r"
sleep 0.6
set timeout 30
expect {
  -re $prompt_re { set saw_shell 1 }
  eof { exit 0 }
  timeout {}
}
if {!$saw_shell} {
  send "echo E2E5E_SHELL_MARKER\r"
  set timeout 30
  expect {
    -re {E2E5E_SHELL_MARKER} { set saw_shell 1 }
    eof { exit 0 }
    timeout {}
  }
}
if {!$saw_shell} {
  puts stderr "Phase 5e: no shell after quit — extra burst"
  for {set i 0} {$i < $cc_count} {incr i} {
    send "\003"
    sleep $quit_sleep
  }
  send "\r"
  sleep 0.6
  set timeout 45
  expect {
    -re $prompt_re { set saw_shell 1 }
    -re {E2E5E_SHELL_MARKER} { set saw_shell 1 }
    eof { exit 0 }
    timeout {}
  }
}
if {!$saw_shell} {
  puts stderr "Phase 5e: timeout waiting for shell (raise OPENCLAW_TUI_* envs or inspect PTY output)"
  exit 1
}
send "exit\r"
expect {
  eof {}
  timeout { puts stderr "Phase 5e: timeout waiting for connect session to end"; exit 1 }
}
exit 0
E2E_EXPECT_TUI
  tui_rc=$?
  set -uo pipefail
  if [ "$tui_rc" -eq 0 ]; then
    pass "Phase 5e: openclaw TUI smoke completed (connect → tui → message → exit)"
  else
    fail "Phase 5e: openclaw TUI expect session failed (exit ${tui_rc})"
    exit 1
  fi
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 5f: Documentation — e2e-cloud-experimental/check-docs.sh (before final cleanup)
# ══════════════════════════════════════════════════════════════════════
section "Phase 5f: Documentation checks (check-docs.sh)"

if ! e2e_cloud_experimental_phase_enabled phase5f; then
  skip "Phase 5f: skipped by tag (phase5f — set E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS / SKIP_TAGS)"
elif [ "${RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_CHECK_DOCS:-0}" = "1" ]; then
  skip "Phase 5f: check-docs skipped (RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_CHECK_DOCS=1)"
else
  info "check-docs.sh (default: curl unique http(s) links; CHECK_DOC_LINKS_REMOTE=0 to skip remote only)"
  if ! bash "${E2E_DIR}/e2e-cloud-experimental/check-docs.sh"; then
    fail "Phase 5f: check-docs.sh failed"
    exit 1
  fi
  pass "Phase 5f: check-docs.sh OK"
fi

# ══════════════════════════════════════════════════════════════════════
# Phase 6: Final cleanup (mirror Phase 0; leave machine tidy after E2E)
# ══════════════════════════════════════════════════════════════════════
# nemoclaw destroy --yes clears registry without [y/N] prompt (otherwise Cancelled. leaves a stale list entry).
# openshell sandbox delete + forward stop + gateway destroy.
section "Phase 6: Final cleanup"

if ! e2e_cloud_experimental_phase_enabled phase6; then
  skip "Phase 6: skipped by tag (phase6 — set E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS / SKIP_TAGS)"
elif [ "${RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5:-0}" = "1" ] && [ "${RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5_RUN_CLEANUP:-0}" != "1" ]; then
  skip "Phase 6: final cleanup skipped (RUN_E2E_CLOUD_EXPERIMENTAL_FROM_PHASE5=1 — set FROM_PHASE5_RUN_CLEANUP=1 to destroy sandbox)"
elif [ "${RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_FINAL_CLEANUP:-${RUN_SCENARIO_A_SKIP_FINAL_CLEANUP:-}}" = "1" ]; then
  skip "Phase 6: final cleanup skipped (RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_FINAL_CLEANUP=1)"
else
  info "Removing sandbox '${SANDBOX_NAME}', port forward, and nemoclaw gateway..."
  if ! SANDBOX_NAME="$SANDBOX_NAME" bash "${E2E_DIR}/e2e-cloud-experimental/cleanup.sh" --verify; then
    fail "Phase 6: final cleanup or verification failed"
    exit 1
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
    printf '\033[1;33m\n  e2e-cloud-experimental: suite done; %d check(s) skipped (Phase 2 / optional / FROM_PHASE5 skips).\033[0m\n' "$SKIP"
  else
    printf '\033[1;32m\n  e2e-cloud-experimental PASSED.\033[0m\n'
  fi
  exit 0
else
  printf '\033[1;31m\n  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
