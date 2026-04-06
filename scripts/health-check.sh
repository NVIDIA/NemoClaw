#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Check the health of all NemoClaw services and optionally alert on failures.
#
# Probes Docker, the OpenShell gateway, sandbox readiness, SSH tunnel,
# inference endpoint, port forward, Telegram bridge, and (optionally)
# the in-sandbox OpenClaw agent via `openclaw doctor`.
#
# Designed to run interactively or on a timer (cron / launchd).
# When --alert is set, only sends a notification on failure — silent on success.
#
# Usage:
#   ./scripts/health-check.sh                            # check all, print status
#   ./scripts/health-check.sh --sandbox mybox            # check a named sandbox
#   ./scripts/health-check.sh --alert telegram           # alert via Telegram on failure
#   ./scripts/health-check.sh --json                     # output JSON (for scripting)
#   ./scripts/health-check.sh --quiet                    # exit code only (0=healthy)
#   ./scripts/health-check.sh --skip docker,ssh          # skip specific checks
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
#   2  Script error (bad arguments, missing dependencies)
#
# Related upstream issues:
#   - NemoClaw #233  (observability / metrics proposal)
#   - NemoClaw #1430 (Docker HEALTHCHECK missing)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Defaults ────────────────────────────────────────────────────
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
GATEWAY_NAME="${NEMOCLAW_GATEWAY_NAME:-nemoclaw}"
DASHBOARD_PORT="${DASHBOARD_PORT:-18789}"
ALERT_METHOD=""          # empty = no alerting
OUTPUT_MODE="pretty"     # pretty | json | quiet
SKIP_CHECKS=""           # comma-separated list of checks to skip

# ── Colors (disabled when not a terminal or in json/quiet mode) ─
if [ -t 1 ] && [ "$OUTPUT_MODE" = "pretty" ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' CYAN='' NC=''
fi

# ── Parse flags ─────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox)
      SANDBOX_NAME="${2:?--sandbox requires a name}"
      shift 2
      ;;
    --gateway)
      GATEWAY_NAME="${2:?--gateway requires a name}"
      shift 2
      ;;
    --port)
      DASHBOARD_PORT="${2:?--port requires a number}"
      shift 2
      ;;
    --alert)
      ALERT_METHOD="${2:?--alert requires a method (telegram)}"
      shift 2
      ;;
    --json)
      OUTPUT_MODE="json"
      GREEN='' RED='' YELLOW='' CYAN='' NC=''
      shift
      ;;
    --quiet | -q)
      OUTPUT_MODE="quiet"
      GREEN='' RED='' YELLOW='' CYAN='' NC=''
      shift
      ;;
    --skip)
      SKIP_CHECKS="${2:?--skip requires a comma-separated list}"
      shift 2
      ;;
    --help | -h)
      sed -n '2,/^$/s/^# *//p' "$0"
      exit 0
      ;;
    *) shift ;;
  esac
done

# ── Helpers ─────────────────────────────────────────────────────
CHECKS_PASSED=0
CHECKS_FAILED=0
CHECKS_SKIPPED=0
RESULTS=()

should_skip() {
  echo ",$SKIP_CHECKS," | grep -qi ",$1,"
}

record() {
  local name="$1" status="$2" detail="$3"
  RESULTS+=("${name}|${status}|${detail}")
  case "$status" in
    pass) CHECKS_PASSED=$((CHECKS_PASSED + 1)) ;;
    fail) CHECKS_FAILED=$((CHECKS_FAILED + 1)) ;;
    skip) CHECKS_SKIPPED=$((CHECKS_SKIPPED + 1)) ;;
  esac

  if [ "$OUTPUT_MODE" = "pretty" ]; then
    case "$status" in
      pass) echo -e "  ${GREEN}✓${NC} ${name}: ${detail}" ;;
      fail) echo -e "  ${RED}✗${NC} ${name}: ${detail}" ;;
      skip) echo -e "  ${YELLOW}–${NC} ${name}: skipped" ;;
    esac
  fi
}

# ── Individual checks ──────────────────────────────────────────

check_docker() {
  if should_skip "docker"; then record "docker" "skip" ""; return; fi
  if docker info >/dev/null 2>&1; then
    record "docker" "pass" "Docker daemon running"
  else
    record "docker" "fail" "Docker daemon not responding"
  fi
}

check_gateway() {
  if should_skip "gateway"; then record "gateway" "skip" ""; return; fi
  if ! command -v openshell >/dev/null 2>&1; then
    record "gateway" "fail" "openshell CLI not found"
    return
  fi
  local status_out
  status_out="$(openshell status 2>&1 || true)"
  if echo "$status_out" | grep -qi "healthy"; then
    record "gateway" "pass" "Gateway '$GATEWAY_NAME' healthy"
  elif echo "$status_out" | grep -qi "connected"; then
    record "gateway" "pass" "Gateway '$GATEWAY_NAME' connected"
  else
    record "gateway" "fail" "Gateway not healthy"
  fi
}

check_sandbox() {
  if should_skip "sandbox"; then record "sandbox" "skip" ""; return; fi
  if ! command -v openshell >/dev/null 2>&1; then
    record "sandbox" "fail" "openshell CLI not found"
    return
  fi
  local sandbox_out
  sandbox_out="$(openshell sandbox get "$SANDBOX_NAME" 2>&1 || true)"
  if echo "$sandbox_out" | grep -qi "ready"; then
    record "sandbox" "pass" "Sandbox '$SANDBOX_NAME' ready"
  elif echo "$sandbox_out" | grep -qi "not found\|does not exist"; then
    record "sandbox" "fail" "Sandbox '$SANDBOX_NAME' not found"
  else
    record "sandbox" "fail" "Sandbox '$SANDBOX_NAME' not ready"
  fi
}

check_ssh() {
  if should_skip "ssh"; then record "ssh" "skip" ""; return; fi
  local ssh_out
  ssh_out=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" 'echo ok' 2>&1 || true)
  if [ "$ssh_out" = "ok" ]; then
    record "ssh" "pass" "SSH tunnel to sandbox healthy"
  else
    record "ssh" "fail" "SSH tunnel broken (${ssh_out:0:80})"
  fi
}

check_inference() {
  if should_skip "inference"; then record "inference" "skip" ""; return; fi
  # Check common inference endpoints; at least one should respond
  local found=0 detail=""

  # LiteLLM (Bedrock proxy)
  if curl -sf --max-time 3 http://localhost:4000/health >/dev/null 2>&1; then
    found=1
    detail="LiteLLM (port 4000)"
  fi

  # Ollama
  if curl -sf --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
    found=1
    detail="${detail:+$detail, }Ollama (port 11434)"
  fi

  # vLLM / NIM
  if curl -sf --max-time 3 http://localhost:8000/v1/models >/dev/null 2>&1; then
    found=1
    detail="${detail:+$detail, }vLLM/NIM (port 8000)"
  fi

  # NVIDIA cloud (check via provider list if available)
  if command -v openshell >/dev/null 2>&1; then
    if openshell provider list 2>&1 | grep -q "nvidia-prod"; then
      found=1
      detail="${detail:+$detail, }NVIDIA cloud provider"
    fi
  fi

  if [ "$found" -eq 1 ]; then
    record "inference" "pass" "$detail"
  else
    record "inference" "fail" "No inference endpoint responding"
  fi
}

check_dashboard() {
  if should_skip "dashboard"; then record "dashboard" "skip" ""; return; fi
  # Use -o /dev/null -w to get HTTP status; accept any response (even errors)
  # as proof the port forward is alive. curl exit 7 = connection refused (down),
  # exit 52 = empty reply (gateway restarting). Only 7 is a hard failure.
  local http_code curl_exit
  http_code=$(curl -s --max-time 3 -o /dev/null -w "%{http_code}" \
    "http://127.0.0.1:${DASHBOARD_PORT}/" 2>/dev/null) && curl_exit=0 || curl_exit=$?
  if [ "$http_code" != "000" ]; then
    record "dashboard" "pass" "Dashboard on port $DASHBOARD_PORT (HTTP $http_code)"
  elif [ "$curl_exit" -eq 7 ]; then
    record "dashboard" "fail" "Port forward not running on $DASHBOARD_PORT"
  else
    record "dashboard" "fail" "Dashboard not responding on port $DASHBOARD_PORT"
  fi
}

check_bridge() {
  if should_skip "bridge"; then record "bridge" "skip" ""; return; fi
  local piddir="/tmp/nemoclaw-services-${SANDBOX_NAME}"
  local pidfile="$piddir/telegram-bridge.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    record "bridge" "pass" "Telegram bridge running (PID $(cat "$pidfile"))"
  else
    # Not necessarily a failure — bridge is optional
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
      record "bridge" "fail" "Telegram bridge not running (token is set)"
    else
      record "bridge" "skip" "No TELEGRAM_BOT_TOKEN"
    fi
  fi
}

check_agent() {
  if should_skip "agent"; then record "agent" "skip" ""; return; fi
  # Run openclaw doctor inside the sandbox via SSH.
  # The command outputs a banner, warnings, and diagnostic lines.
  # We only look for explicit error/failure indicators.
  local doctor_out doctor_exit
  doctor_out=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" 'openclaw doctor 2>&1; echo "EXIT:$?"' 2>&1 || true)
  doctor_exit=$(echo "$doctor_out" | grep -o 'EXIT:[0-9]*' | tail -1 | cut -d: -f2)
  if [ "${doctor_exit:-1}" = "0" ]; then
    record "agent" "pass" "openclaw doctor: passed (exit 0)"
  elif echo "$doctor_out" | grep -qi "error\|fail\|unhealthy"; then
    # Extract the first meaningful error line
    local err_line
    err_line=$(echo "$doctor_out" | grep -i "error\|fail\|unhealthy" | head -1)
    record "agent" "fail" "openclaw doctor: ${err_line:0:80}"
  else
    record "agent" "pass" "openclaw doctor: responded"
  fi
}

# ── Run all checks ─────────────────────────────────────────────
if [ "$OUTPUT_MODE" = "pretty" ]; then
  echo -e "\n${CYAN}NemoClaw Health Check${NC}  ($(date '+%Y-%m-%d %H:%M:%S'))"
  echo -e "${CYAN}Sandbox:${NC} $SANDBOX_NAME  ${CYAN}Gateway:${NC} $GATEWAY_NAME\n"
fi

check_docker
check_gateway
check_sandbox
check_ssh
check_inference
check_dashboard
check_bridge
check_agent

# ── Output ─────────────────────────────────────────────────────
TOTAL=$((CHECKS_PASSED + CHECKS_FAILED + CHECKS_SKIPPED))

if [ "$OUTPUT_MODE" = "pretty" ]; then
  echo ""
  if [ "$CHECKS_FAILED" -eq 0 ]; then
    echo -e "  ${GREEN}All $CHECKS_PASSED checks passed${NC} ($CHECKS_SKIPPED skipped)"
  else
    echo -e "  ${RED}$CHECKS_FAILED/$TOTAL checks failed${NC} ($CHECKS_PASSED passed, $CHECKS_SKIPPED skipped)"
  fi
  echo ""
fi

if [ "$OUTPUT_MODE" = "json" ]; then
  # Build JSON output
  echo "{"
  echo "  \"timestamp\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\","
  echo "  \"sandbox\": \"$SANDBOX_NAME\","
  echo "  \"gateway\": \"$GATEWAY_NAME\","
  echo "  \"summary\": { \"passed\": $CHECKS_PASSED, \"failed\": $CHECKS_FAILED, \"skipped\": $CHECKS_SKIPPED },"
  echo "  \"checks\": ["
  first=1
  for result in "${RESULTS[@]}"; do
    IFS='|' read -r name status detail <<< "$result"
    [ "$first" -eq 1 ] && first=0 || echo ","
    printf '    { "name": "%s", "status": "%s", "detail": "%s" }' "$name" "$status" "$detail"
  done
  echo ""
  echo "  ]"
  echo "}"
fi

# ── Alerting ───────────────────────────────────────────────────
if [ "$CHECKS_FAILED" -gt 0 ] && [ -n "$ALERT_METHOD" ]; then
  # Build failure summary
  FAILURE_LINES=""
  for result in "${RESULTS[@]}"; do
    IFS='|' read -r name status detail <<< "$result"
    if [ "$status" = "fail" ]; then
      FAILURE_LINES="${FAILURE_LINES}✗ ${name}: ${detail}\n"
    fi
  done

  case "$ALERT_METHOD" in
    telegram)
      if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
        echo "Warning: --alert telegram requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" >&2
      else
        ALERT_TEXT="⚠️ NemoClaw Health Alert

${CHECKS_FAILED}/${TOTAL} checks failed (sandbox: ${SANDBOX_NAME})

$(echo -e "$FAILURE_LINES")
Run: ./scripts/health-check.sh --sandbox $SANDBOX_NAME"

        RESULT=$(curl -s -X POST \
          "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
          -d chat_id="$TELEGRAM_CHAT_ID" \
          --data-urlencode "text=${ALERT_TEXT}" 2>&1)

        if echo "$RESULT" | grep -q '"ok":true'; then
          [ "$OUTPUT_MODE" = "pretty" ] && echo -e "  ${YELLOW}Alert sent to Telegram${NC}"
        else
          echo "Warning: Failed to send Telegram alert" >&2
        fi
      fi
      ;;
    *)
      echo "Warning: Unknown alert method '$ALERT_METHOD'. Supported: telegram" >&2
      ;;
  esac
fi

# ── Exit code ──────────────────────────────────────────────────
if [ "$CHECKS_FAILED" -gt 0 ]; then
  exit 1
else
  exit 0
fi
