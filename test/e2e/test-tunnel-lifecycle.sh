#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-tunnel-lifecycle.sh
# NemoClaw Tunnel Lifecycle E2E Tests
#
# Covers:
#   TC-DEPLOY-01a: nemoclaw tunnel start (cloudflared tunnel)
#   TC-DEPLOY-01b: tunnel URL serves the OpenClaw dashboard
#   TC-DEPLOY-01c: nemoclaw tunnel stop removes URL from status
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set
#   - Network access to integrate.api.nvidia.com
# =============================================================================

set -euo pipefail

# ── Overall timeout ──────────────────────────────────────────────────────────
export NEMOCLAW_E2E_DEFAULT_TIMEOUT=3600
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"
# shellcheck source=test/e2e/lib/install-path-refresh.sh
source "${SCRIPT_DIR_TIMEOUT}/lib/install-path-refresh.sh"

# ── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
TOTAL=0

# Log a timestamped message.
log() { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*" | tee -a "$LOG_FILE"; }
# Record a passing assertion.
pass() {
  ((PASS += 1))
  ((TOTAL += 1))
  echo -e "${GREEN}  PASS${NC} $1" | tee -a "$LOG_FILE"
}
# Record a failing assertion.
fail() {
  ((FAIL += 1))
  ((TOTAL += 1))
  echo -e "${RED}  FAIL${NC} $1 — $2" | tee -a "$LOG_FILE"
}
# Record a skipped test.
skip() {
  ((SKIP += 1))
  ((TOTAL += 1))
  echo -e "${YELLOW}  SKIP${NC} $1 — $2" | tee -a "$LOG_FILE"
}

# ── Config ───────────────────────────────────────────────────────────────────
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-tunnel-lifecycle}"
LOG_FILE="test-tunnel-lifecycle-$(date +%Y%m%d-%H%M%S).log"
# Local dashboard port mirrors nemoclaw/src/lib/ports.ts DASHBOARD_PORT default.
LOCAL_DASHBOARD_PORT="${NEMOCLAW_DASHBOARD_PORT:-18789}"

# ── Resolve repo root ────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── Install NemoClaw if not present ──────────────────────────────────────────
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
    bash "$REPO_ROOT/install.sh" --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE"
  nemoclaw_refresh_install_env
  if ! command -v nemoclaw >/dev/null 2>&1; then
    log "ERROR: install.sh failed — nemoclaw not found"
    exit 1
  fi
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
preflight() {
  log "=== Pre-flight checks ==="
  if ! docker info >/dev/null 2>&1; then
    log "ERROR: Docker is not running."
    exit 1
  fi
  log "Docker is running"

  local api_key="${NVIDIA_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    log "ERROR: NVIDIA_API_KEY not set"
    exit 1
  fi

  install_nemoclaw

  if ! command -v cloudflared >/dev/null 2>&1; then
    # Install via Cloudflare's GPG-signed APT repo — trust anchor for secret-bearing
    # CI; APT verifies GPG-signed Release → package SHA256 (no per-version SHA pin).
    local cf_version="${CLOUDFLARED_VERSION:-2026.5.0}"
    log "Installing cloudflared ${cf_version} via Cloudflare APT repo..."
    sudo mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
      | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
      | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y "cloudflared=${cf_version}*" \
      || {
        log "ERROR: cloudflared ${cf_version} not available in Cloudflare APT repo"
        exit 1
      }
    log "cloudflared ${cf_version} installed (GPG verified via Cloudflare APT repo)"
  fi

  log "nemoclaw: $(nemoclaw --version 2>/dev/null || echo unknown)"
  log "cloudflared: $(cloudflared --version 2>/dev/null || echo 'not available')"
  log "Pre-flight complete"
}

# ── Onboard helper ───────────────────────────────────────────────────────────
onboard_sandbox() {
  local name="$1"
  log "  Onboarding sandbox '$name'..."
  NEMOCLAW_SANDBOX_NAME="$name" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="open" \
    run_with_timeout 1800 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || {
    log "FATAL: Onboard failed for '$name'"
    return 1
  }
  log "  Sandbox '$name' onboarded"
}

# Resolve /tmp/nemoclaw-services-<SANDBOX>/cloudflared.log; fall back to the
# most recently modified one if SANDBOX_NAME wasn't propagated to NemoClaw.
get_cloudflared_log_path() {
  local log="/tmp/nemoclaw-services-${SANDBOX_NAME}/cloudflared.log"
  if [[ -f "$log" ]]; then
    printf '%s\n' "$log"
    return 0
  fi
  # shellcheck disable=SC2012
  log="$(ls -t /tmp/nemoclaw-services-*/cloudflared.log 2>/dev/null | head -1 || true)"
  if [[ -n "$log" && -f "$log" ]]; then
    printf '%s\n' "$log"
  fi
  return 0
}

# Classify failure cause from cloudflared.log. Echoes one of:
#   nemoclaw_no_spawn / nemoclaw_capture_bug / nemoclaw_local / cloudflare / unknown
classify_cloudflared_log() {
  local cf_log
  cf_log=$(get_cloudflared_log_path)
  if [[ -z "$cf_log" ]]; then
    echo "nemoclaw_no_spawn"
    return
  fi
  if grep -qE 'https://[a-z0-9-]+\.trycloudflare\.com' "$cf_log" 2>/dev/null; then
    echo "nemoclaw_capture_bug"
    return
  fi
  if grep -qiE 'unable to reach the origin|connection refused.*127\.0\.0\.1|connection refused.*localhost|dial tcp.*127\.0\.0\.1.*refused' "$cf_log" 2>/dev/null; then
    echo "nemoclaw_local"
    return
  fi
  if grep -qiE 'failed to (dial|register)|quick tunnels (are )?(temporarily )?disabled|tunnel server.*error|i/o timeout|EOF.*tunnel|couldn.?t start tunnel|tunnel creation failed' "$cf_log" 2>/dev/null; then
    echo "cloudflare"
    return
  fi
  echo "unknown"
}

# Print the tail of cloudflared.log to the test log for human triage.
show_cloudflared_log() {
  local cf_log tail_lines=40
  cf_log=$(get_cloudflared_log_path)
  if [[ -z "$cf_log" ]]; then
    log "  (no cloudflared.log found under /tmp/nemoclaw-services-*/)"
    return
  fi
  log "  --- cloudflared.log ($cf_log, last ${tail_lines} lines) ---"
  tail -n "$tail_lines" "$cf_log" 2>/dev/null | sed 's/^/    /' | tee -a "$LOG_FILE" || true
  log "  --- end cloudflared.log ---"
}

# Probe local dashboard: any HTTP response (incl. 401/403) = up; "000" = down.
# Mirrors src/lib/verify-deployment.ts:128.
probe_local_dashboard() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 5 "http://localhost:${LOCAL_DASHBOARD_PORT}/" 2>/dev/null || true)"
  [[ -z "$code" ]] && code="000"
  [[ "$code" != "000" ]]
}

# Wait up to N seconds for local dashboard to become reachable.
# Returns 0 if reachable within timeout, 1 if not.
wait_local_dashboard_ready() {
  local max_tries="${1:-30}"
  for i in $(seq 1 "$max_tries"); do
    if probe_local_dashboard; then
      log "  ✓ Local dashboard reachable on localhost:${LOCAL_DASHBOARD_PORT} after ${i}s"
      return 0
    fi
    [[ $((i % 5)) -eq 0 ]] && log "  ... still waiting for localhost:${LOCAL_DASHBOARD_PORT} (${i}/${max_tries}s)"
    sleep 1
  done
  return 1
}

# =============================================================================
# TC-DEPLOY-01a: nemoclaw tunnel start (cloudflared tunnel)
# TC-DEPLOY-01b: tunnel URL serves the OpenClaw dashboard
# TC-DEPLOY-01c: nemoclaw tunnel stop removes tunnel URL from status
# =============================================================================
test_tunnel_lifecycle() {
  log "=== TC-DEPLOY-01a/b/c: Start / Probe / Stop ==="

  # Fail closed: skip would let a broken install path silently pass.
  if ! command -v cloudflared >/dev/null 2>&1; then
    fail "TC-DEPLOY-01a / TC-DEPLOY-01b / TC-DEPLOY-01c" \
      "cloudflared not available — required for tunnel validation. Preflight install should have run; check earlier log."
    return
  fi

  # Cascade guard: skip if a prior step left the sandbox missing.
  if ! nemoclaw list 2>/dev/null | grep -Fq -- "$SANDBOX_NAME"; then
    skip "TC-DEPLOY-01a / TC-DEPLOY-01b / TC-DEPLOY-01c" \
      "Sandbox '$SANDBOX_NAME' not present"
    return
  fi

  # ── Local dashboard pre-check (BEFORE tunnel start) ───────────────────────
  # Catch local-not-ready before tunnel start to avoid 502s blamed on Cloudflare.
  log "  Pre-check: Waiting for local dashboard at localhost:${LOCAL_DASHBOARD_PORT}..."
  if ! wait_local_dashboard_ready 30; then
    fail "TC-DEPLOY-01a: LocalReadiness" \
      "[NemoClaw fault] Local OpenClaw dashboard not reachable on localhost:${LOCAL_DASHBOARD_PORT} after 30s. Tunnel cannot proxy a dead origin — this is NOT a Cloudflare issue."
    return
  fi
  pass "TC-DEPLOY-01a: Local dashboard reachable (pre-check passed)"

  # ── TC-DEPLOY-01a: Start tunnel + verify URL surfaces ───────────────────────────────────
  log "  Step 1: Running nemoclaw tunnel start..."
  local start_output start_rc=0
  start_output=$(nemoclaw tunnel start 2>&1) || start_rc=$?
  log "  Start output:"
  log "  ---"
  log "$start_output"
  log "  ---"
  if [[ $start_rc -ne 0 ]]; then
    fail "TC-DEPLOY-01a: Start" "[NemoClaw fault] 'nemoclaw tunnel start' exited with code $start_rc — start command itself failed."
    return
  fi

  log "  Step 2: Reading nemoclaw status (polling for tunnel URL)..."
  local status_output tunnel_url
  for i in $(seq 1 15); do
    status_output=$(nemoclaw status 2>&1) || true
    tunnel_url=$(printf '%s\n' "$status_output" | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | head -1) || true
    [[ -n "$tunnel_url" ]] && break
    sleep 1
  done

  if [[ -n "$tunnel_url" ]]; then
    pass "TC-DEPLOY-01a: Tunnel URL found in status ($tunnel_url)"
  else
    # Classify failure cause from cloudflared.log to attribute fault accurately.
    # Print log tail first so the diagnostic is visible above the fail line in CI logs.
    show_cloudflared_log
    local cf_class
    cf_class=$(classify_cloudflared_log)
    case "$cf_class" in
      nemoclaw_no_spawn)
        fail "TC-DEPLOY-01a: NoSpawn" \
          "[NemoClaw fault] cloudflared.log missing — NemoClaw failed to spawn the cloudflared process. Check tunnel start impl."
        ;;
      nemoclaw_capture_bug)
        fail "TC-DEPLOY-01a: CaptureBug" \
          "[NemoClaw fault] cloudflared.log HAS trycloudflare URL but 'nemoclaw status' did not surface it. Status capture bug in NemoClaw."
        ;;
      nemoclaw_local)
        fail "TC-DEPLOY-01a: LocalOrigin" \
          "[NemoClaw fault] cloudflared log reports it cannot reach localhost:${LOCAL_DASHBOARD_PORT} (origin not serving). Pre-check should have caught this — review pre-check timeout."
        ;;
      cloudflare)
        fail "TC-DEPLOY-01a: CloudflareRegister" \
          "[Cloudflare fault] cloudflared failed to register with Cloudflare."
        ;;
      *)
        fail "TC-DEPLOY-01a: Start" \
          "[Unclassified] Tunnel URL did not surface and cloudflared.log did not match any known pattern. See log tail above."
        ;;
    esac
    # Stop the tunnel even no tunnel URL was found
    log "  Stopping tunnel..."
    nemoclaw tunnel stop 2>/dev/null || true
    log "  Tunnel stopped"
    return
  fi

  # ── TC-DEPLOY-01b: Tunnel serves the OpenClaw dashboard ────────────────────────
  if [[ -n "$tunnel_url" ]]; then
    log "  Step 3: Probing tunnel URL (exponential backoff + local re-verify)..."
    local http_code="000" body_file backoff=2 max_retries=15
    body_file=$(mktemp)
    for i in $(seq 1 "$max_retries"); do
      # curl -w '%{http_code}' always writes the 3-char status (writes "000" on
      # connection failure), so do NOT chain `|| echo "000"` — that would append
      # a second "000" to whatever curl already wrote, producing "000000".
      http_code=$(curl -sS -o "$body_file" -w '%{http_code}' \
        --max-time 30 "$tunnel_url" 2>/dev/null) || true
      [[ -z "$http_code" ]] && http_code="000"
      if [[ "$http_code" == "200" ]]; then
        break
      fi

      # Re-verify local BEFORE attributing the failure to Cloudflare — fact-find
      # first so the log message reflects truth at this moment (avoid lying logs).
      if ! probe_local_dashboard; then
        fail "TC-DEPLOY-01b: LocalRegression" \
          "[NemoClaw fault] Tunnel returned $http_code AND local dashboard regressed during retry loop (was healthy at pre-check). Likely sandbox/dashboard crash — NOT a Cloudflare issue."
        rm -f "$body_file"
        return
      fi

      log "  [$i/$max_retries] Tunnel not yet reachable ('$http_code'); LOCAL is healthy → Cloudflare quick-tunnel not ready (DNS propagation or edge instability); backoff ${backoff}s..."
      sleep "$backoff"
      backoff=$((backoff * 2))
      ((backoff > 30)) && backoff=30
    done

    if [[ "$http_code" == "200" ]]; then
      if grep -qE '<title>OpenClaw Control</title>|<openclaw-app' "$body_file"; then
        pass "TC-DEPLOY-01b: Tunnel serves OpenClaw dashboard (HTTP 200, marker matched)"
      else
        fail "TC-DEPLOY-01b" "[NemoClaw fault] HTTP 200 but body lacks OpenClaw dashboard markers — dashboard may be serving wrong content on port (first 200B: $(head -c 200 "$body_file" | tr -d '\n'))"
      fi
    else
      # If we get here, every retry re-checked local and found it healthy
      # → attribute the failure to Cloudflare quick-tunnel (third-party).
      fail "TC-DEPLOY-01b: CloudflareEdge" \
        "[Cloudflare fault] Tunnel URL never became reachable after $max_retries retries (last status '$http_code') while local stayed healthy throughout — Cloudflare quick-tunnel did not become reachable in time (slow DNS propagation or edge instability)."
    fi
    rm -f "$body_file"
  else
    skip "TC-DEPLOY-01b" "Tunnel URL not available"
  fi

  log "  Step 4: Running nemoclaw tunnel stop..."
  local stop_output stop_rc=0
  stop_output=$(nemoclaw tunnel stop 2>&1) || stop_rc=$?
  log "  Tunnel stop output:"
  printf '%s\n' "$stop_output" | sed 's/^/    /' | tee -a "$LOG_FILE" || true
  if [[ $stop_rc -ne 0 ]]; then
    fail "TC-DEPLOY-01c: Stop command" "nemoclaw tunnel stop failed (exit $stop_rc)"
    return
  fi

  # ── TC-DEPLOY-01c: Tunnel URL absent after stop ─────────────────────────────
  log "  Step 5: Verifying tunnel stopped (polling for URL removal)..."
  if [[ -z "$tunnel_url" ]]; then
    skip "TC-DEPLOY-01c" "Tunnel URL was never confirmed in status"
  else
    local post_status post_url status_rc=0 status_ok=0
    for i in $(seq 1 10); do
      status_rc=0
      post_status=$(nemoclaw status 2>&1) || status_rc=$?
      if [[ $status_rc -ne 0 ]]; then
        log "  [$i] nemoclaw status failed (exit $status_rc), retrying in 1s..."
        sleep 1
        continue
      fi
      status_ok=1
      post_url=$(printf '%s\n' "$post_status" | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | head -1) || true
      [[ -z "$post_url" ]] && break
      sleep 1
    done
    if [[ $status_ok -eq 0 ]]; then
      fail "TC-DEPLOY-01c: Stop" "Could not read nemoclaw status after stop"
    elif [[ -z "$post_url" ]]; then
      pass "TC-DEPLOY-01c: Tunnel URL absent after stop"
    else
      fail "TC-DEPLOY-01c: Stop" "Tunnel URL still present after stop ($post_url)"
    fi
  fi
}

# Clean up sandbox and services on exit.
teardown() {
  # Do not unlink ~/.nemoclaw/onboard.lock: see rationale in
  # test/e2e/lib/sandbox-teardown.sh — the lock is PID-ownership-aware
  # and onboard cleans up stale locks itself.
  set +e
  nemoclaw stop 2>/dev/null || true
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  set -e
}

# Print final PASS/FAIL/SKIP counts and exit.
summary() {
  echo ""
  echo "============================================================"
  echo "  Tunnel Lifecycle E2E Results"
  echo "============================================================"
  echo -e "  ${GREEN}PASS: $PASS${NC}"
  echo -e "  ${RED}FAIL: $FAIL${NC}"
  echo -e "  ${YELLOW}SKIP: $SKIP${NC}"
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

# Entry point: preflight → onboard → tests → summary.
main() {
  echo ""
  echo "============================================================"
  echo "  NemoClaw Tunnel Lifecycle E2E Tests"
  echo "  $(date)"
  echo "============================================================"
  echo ""

  preflight

  log "=== Onboarding sandbox ==="
  if ! onboard_sandbox "$SANDBOX_NAME"; then
    log "FATAL: Could not onboard sandbox"
    exit 1
  fi

  test_tunnel_lifecycle

  teardown
  trap - EXIT
  summary
}

trap teardown EXIT
main "$@"
