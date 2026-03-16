#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Start NemoClaw auxiliary services: Telegram bridge
# and cloudflared tunnel for public access.
#
# Usage:
#   TELEGRAM_BOT_TOKEN=... ./scripts/start-services.sh         # start all
#   ./scripts/start-services.sh --status                       # check status
#   ./scripts/start-services.sh --stop                         # stop all
#   ./scripts/start-services.sh --sandbox mybox                # start for specific sandbox
#   ./scripts/start-services.sh --sandbox mybox --stop         # stop for specific sandbox

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DASHBOARD_PORT="${DASHBOARD_PORT:-18789}"

# ── Parse flags ──────────────────────────────────────────────────
SANDBOX_NAME="${NEMOCLAW_SANDBOX:-default}"
ACTION="start"

while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox)
      SANDBOX_NAME="${2:?--sandbox requires a name}"
      shift 2
      ;;
    --stop)
      ACTION="stop"
      shift
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

PIDDIR="/tmp/nemoclaw-services-${SANDBOX_NAME}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[services]${NC} $1"; }
warn()  { echo -e "${YELLOW}[services]${NC} $1"; }
fail()  { echo -e "${RED}[services]${NC} $1"; exit 1; }

is_running() {
  local pidfile="$PIDDIR/$1.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    return 0
  fi
  return 1
}

start_service() {
  local name="$1"
  shift
  if is_running "$name"; then
    info "$name already running (PID $(cat "$PIDDIR/$name.pid"))"
    return 0
  fi
  nohup "$@" > "$PIDDIR/$name.log" 2>&1 &
  echo $! > "$PIDDIR/$name.pid"
  info "$name started (PID $!)"
}

stop_service() {
  local name="$1"
  local pidfile="$PIDDIR/$name.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
      info "$name stopped (PID $pid)"
    else
      info "$name was not running"
    fi
    rm -f "$pidfile"
  else
    info "$name was not running"
  fi
}

show_status() {
  mkdir -p "$PIDDIR"
  echo ""
  for svc in telegram-bridge cloudflared; do
    if is_running "$svc"; then
      echo -e "  ${GREEN}●${NC} $svc  (PID $(cat "$PIDDIR/$svc.pid"))"
    else
      echo -e "  ${RED}●${NC} $svc  (stopped)"
    fi
  done
  echo ""

  if [ -f "$PIDDIR/cloudflared.log" ]; then
    local url
    url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$PIDDIR/cloudflared.log" 2>/dev/null | head -1 || true)"
    if [ -n "$url" ]; then
      info "Public URL: $url"
    fi
  fi
}

do_stop() {
  mkdir -p "$PIDDIR"
  stop_service cloudflared
  stop_service telegram-bridge
  info "All services stopped."
}

do_start() {
  [ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY required"

  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    warn "TELEGRAM_BOT_TOKEN not set — Telegram bridge will not start."
    warn "Create a bot via @BotFather on Telegram and set the token."
  fi

  command -v node > /dev/null || fail "node not found. Install Node.js first."

  # Verify sandbox is running
  if command -v openshell > /dev/null 2>&1; then
    if ! openshell sandbox list 2>&1 | grep -q "Ready"; then
      warn "No sandbox in Ready state. Telegram bridge may not work until sandbox is running."
    fi
  fi

  mkdir -p "$PIDDIR"

  # Telegram bridge (only if token provided)
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    start_service telegram-bridge \
      node "$REPO_DIR/scripts/telegram-bridge.js"
  fi

  # 3. cloudflared tunnel
  if command -v cloudflared > /dev/null 2>&1; then
    start_service cloudflared \
      cloudflared tunnel --url "http://localhost:$DASHBOARD_PORT"
  else
    warn "cloudflared not found — no public URL. Install: brev-setup.sh or manually."
  fi

  # Wait for cloudflared to publish URL
  if is_running cloudflared; then
    info "Waiting for tunnel URL..."
    for _ in $(seq 1 15); do
      local url
      url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$PIDDIR/cloudflared.log" 2>/dev/null | head -1 || true)"
      if [ -n "$url" ]; then
        break
      fi
      sleep 1
    done
  fi

  # Print banner
  echo ""
  echo "  ┌─────────────────────────────────────────────────────┐"
  echo "  │  NemoClaw Services                                  │"
  echo "  │                                                     │"

  local tunnel_url=""
  if [ -f "$PIDDIR/cloudflared.log" ]; then
    tunnel_url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$PIDDIR/cloudflared.log" 2>/dev/null | head -1 || true)"
  fi

  if [ -n "$tunnel_url" ]; then
    printf "  │  Public URL:  %-40s│\n" "$tunnel_url"
  fi

  if is_running telegram-bridge; then
    echo "  │  Telegram:    bridge running                        │"
  else
    echo "  │  Telegram:    not started (no token)                │"
  fi

  echo "  │                                                     │"
  echo "  │  Run 'openshell term' to monitor egress approvals   │"
  echo "  └─────────────────────────────────────────────────────┘"
  echo ""
}

# Dispatch
case "$ACTION" in
  stop)   do_stop ;;
  status) show_status ;;
  start)  do_start ;;
esac
