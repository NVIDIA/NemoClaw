#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-dashboard-reachability.sh
# NemoClaw OpenClaw Dashboard Reachability E2E Test
#
# Covers: TC-DASH-01 through TC-DASH-03
# Verifies the host → pod serving chain for the OpenClaw dashboard (default
# port 18789): port bound on host, HTTP 200 response, and a body-signature
# check so an unrelated process binding the port cannot silently pass.
# =============================================================================

set -euo pipefail

# ── Overall timeout (prevents hung CI jobs) ──────────────────────────────────
if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-1800}"
  if command -v timeout >/dev/null 2>&1; then
    exec timeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    exec gtimeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  fi
fi

# ── Config ───────────────────────────────────────────────────────────────────
SANDBOX="test-dash"
DASHBOARD_PORT="${NEMOCLAW_DASHBOARD_PORT:-18789}"
DASHBOARD_URL="http://127.0.0.1:${DASHBOARD_PORT}/"
POLL_ATTEMPTS=30
POLL_INTERVAL=1
LOG_FILE="test-dashboard-reachability-$(date +%Y%m%d-%H%M%S).log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Counters ─────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
TOTAL=0

# ── Helpers ──────────────────────────────────────────────────────────────────
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

# Onboard the test sandbox in non-interactive mode. Returns 0 if the sandbox
# appears in nemoclaw list.
onboard_sandbox() {
  local name="$1"
  log "  Onboarding sandbox '$name'..."

  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true

  local onboard_exit=0
  NEMOCLAW_SANDBOX_NAME="$name" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_RECREATE_SANDBOX=1 \
    nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || onboard_exit=$?

  if [[ $onboard_exit -ne 0 ]]; then
    log "  [onboard_sandbox] nemoclaw onboard exited with code $onboard_exit"
    return 1
  fi

  if ! nemoclaw list 2>/dev/null | grep -q "$name"; then
    log "  [onboard_sandbox] Sandbox '$name' not found in nemoclaw list after onboard"
    return 1
  fi
  return 0
}

# ── Resolve repo root ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -f "$SCRIPT_DIR/../../install.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -f "./install.sh" ]; then
  REPO_ROOT="$(pwd)"
else
  echo "ERROR: Cannot find install.sh — run from the repo root or test/e2e/"
  exit 1
fi

# ── Install NemoClaw if not present ──────────────────────────────────────────
install_nemoclaw() {
  if command -v nemoclaw &>/dev/null; then
    log "nemoclaw already installed: $(nemoclaw --version 2>/dev/null || echo 'unknown')"
    return 0
  fi

  log "=== Installing NemoClaw via install.sh ==="

  local install_exit=0
  bash "$REPO_ROOT/install.sh" --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || install_exit=$?

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

  if [[ $install_exit -ne 0 ]]; then
    echo -e "${RED}FATAL: install.sh failed (exit $install_exit)${NC}"
    exit 1
  fi

  if ! command -v nemoclaw &>/dev/null; then
    echo -e "${RED}FATAL: nemoclaw not found on PATH after install${NC}"
    exit 1
  fi

  log "nemoclaw installed: $(nemoclaw --version 2>/dev/null || echo 'unknown')"

  local install_sandbox
  install_sandbox="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
  if nemoclaw list 2>/dev/null | grep -q "$install_sandbox"; then
    log "Destroying install sandbox '$install_sandbox'..."
    nemoclaw "$install_sandbox" destroy --yes 2>/dev/null || true
  fi
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
preflight() {
  log "=== Pre-flight checks ==="

  if ! docker info &>/dev/null; then
    echo -e "${RED}ERROR: Docker is not running.${NC}"
    exit 1
  fi
  log "Docker is running"

  if [[ -z "${NVIDIA_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo -e "${YELLOW}WARNING: No API key detected.${NC}"
  fi

  install_nemoclaw

  log "nemoclaw: $(nemoclaw --version 2>/dev/null || echo 'unknown')"
  log "openshell: $(openshell --version 2>&1 | head -1 || echo 'unknown')"
  log "dashboard port: $DASHBOARD_PORT"

  if [[ -f "$HOME/.nemoclaw/onboard.lock" ]]; then
    log "Removing stale onboard lock"
    rm -f "$HOME/.nemoclaw/onboard.lock"
  fi

  if nemoclaw list 2>/dev/null | grep -q "$SANDBOX"; then
    log "Cleaning up leftover sandbox: $SANDBOX"
    nemoclaw "$SANDBOX" destroy --yes 2>/dev/null || true
  fi

  log "Pre-flight complete"
  echo ""
}

# ── Setup: Onboard the test sandbox ─────────────────────────────────────────
setup_sandbox() {
  log "=== Setup: Onboarding sandbox '$SANDBOX' ==="
  log "This may take a few minutes..."

  if ! onboard_sandbox "$SANDBOX"; then
    echo -e "${RED}FATAL: Onboard failed — sandbox '$SANDBOX' not found.${NC}"
    exit 1
  fi

  # Defensively re-establish the port-forward. nemoclaw onboard already
  # starts it, but an earlier crashed run can leave a stale entry and the
  # dashboard test is meaningless without a live forward.
  log "Ensuring port-forward on $DASHBOARD_PORT..."
  openshell forward start --background "$DASHBOARD_PORT" "$SANDBOX" \
    >>"$LOG_FILE" 2>&1 || log "  forward start returned non-zero (may already be running)"

  log "Sandbox '$SANDBOX' onboarded successfully"
  echo ""
}

# =============================================================================
# Test cases
# =============================================================================

# ── TC-DASH-01: Dashboard port bound on host ─────────────────────────────────
# Confirms the port-forward exists before we try HTTP. Separating this from
# the HTTP check gives a clearer failure signal: if the port is not bound at
# all, it's a forward-layer problem, not a gateway-process problem.
#
# Polls because `openshell forward start --background` forks and returns
# before the child has actually bound the port (see src/lib/onboard.ts,
# ensureDashboardForward).
test_dash_01_port_bound() {
  log "=== TC-DASH-01: Dashboard port bound on host ==="

  local i
  for i in $(seq 1 "$POLL_ATTEMPTS"); do
    if lsof -iTCP:"$DASHBOARD_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      pass "TC-DASH-01: Port $DASHBOARD_PORT is bound (after ${i}s)"
      return
    fi
    sleep "$POLL_INTERVAL"
  done

  fail "TC-DASH-01: Dashboard port bound" \
    "Nothing listening on $DASHBOARD_PORT after ${POLL_ATTEMPTS}s — port-forward not established"
}

# ── TC-DASH-02: Dashboard returns HTTP 200 ──────────────────────────────────
# Polls the dashboard up to POLL_ATTEMPTS × POLL_INTERVAL seconds. The
# gateway can take several seconds after onboard to start accepting
# connections, so a single-shot check would be flaky.
test_dash_02_http_200() {
  log "=== TC-DASH-02: Dashboard returns HTTP 200 ==="

  local status=""
  local i
  for i in $(seq 1 "$POLL_ATTEMPTS"); do
    status=$(curl -s -o /dev/null -w '%{http_code}' \
      --max-time 5 "$DASHBOARD_URL" 2>/dev/null || echo "000")
    if [[ "$status" == "200" ]]; then
      pass "TC-DASH-02: HTTP 200 after ${i}s"
      return
    fi
    sleep "$POLL_INTERVAL"
  done

  fail "TC-DASH-02: Dashboard HTTP 200" \
    "Last status after ${POLL_ATTEMPTS}s: $status (expected 200)"
}

# ── TC-DASH-03: Response body signature ─────────────────────────────────────
# Guards against an unrelated process binding the dashboard port. The
# structural HTML check is the fail gate; the marker check is soft because
# the dashboard may be an SPA whose raw HTML has no visible branding.
test_dash_03_body_signature() {
  log "=== TC-DASH-03: Response body signature ==="

  local body
  body=$(curl -s --max-time 10 "$DASHBOARD_URL" 2>/dev/null || true)

  if [[ -z "$body" ]]; then
    fail "TC-DASH-03: Body signature" "Empty response body"
    return
  fi

  if ! echo "$body" | grep -qiE '<html|<!doctype'; then
    fail "TC-DASH-03: Body signature" \
      "Response is not HTML — something else is bound to $DASHBOARD_PORT"
    return
  fi

  if echo "$body" | grep -qiE 'openclaw|control[- ]?ui|nemoclaw'; then
    pass "TC-DASH-03: Response body identifies as OpenClaw dashboard"
  else
    log "  ${YELLOW}WARN${NC} No OpenClaw/Control-UI marker in HTML body (may be SPA shell)"
    pass "TC-DASH-03: HTML served on $DASHBOARD_PORT"
  fi
}

# ── Teardown ─────────────────────────────────────────────────────────────────
teardown() {
  # Disable errexit during teardown — cleanup must be best-effort
  set +e
  log ""
  log "=== Teardown ==="
  openshell forward stop "$DASHBOARD_PORT" 2>/dev/null || true
  if nemoclaw list 2>/dev/null | grep -q "$SANDBOX"; then
    log "Destroying sandbox '$SANDBOX'..."
    nemoclaw "$SANDBOX" destroy --yes 2>/dev/null || true
  fi
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  log "Teardown complete"
  set -e
}

# ── Summary ──────────────────────────────────────────────────────────────────
summary() {
  echo ""
  echo "============================================================"
  echo "  TEST SUMMARY"
  echo "============================================================"
  echo -e "  ${GREEN}PASS: $PASS${NC}"
  echo -e "  ${RED}FAIL: $FAIL${NC}"
  echo "  TOTAL: $TOTAL"
  echo "============================================================"
  echo "  Log: $LOG_FILE"
  echo "============================================================"
  echo ""

  if [[ $FAIL -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo "============================================================"
  echo "  NemoClaw Dashboard Reachability E2E Test"
  echo "  $(date)"
  echo "============================================================"
  echo ""

  preflight
  setup_sandbox

  test_dash_01_port_bound
  test_dash_02_http_200
  test_dash_03_body_signature

  trap - EXIT
  teardown
  summary
}

trap teardown EXIT
main "$@"
