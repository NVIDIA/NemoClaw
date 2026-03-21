#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Configure the OpenClaw gateway inside a NemoClaw sandbox for Rabbit R1
# device pairing over LAN.
#
# This is the NemoClaw-adapted version of the upstream r1-openclaw.sh script.
# Instead of running openclaw commands directly on the host, it runs them
# inside the OpenShell sandbox via SSH and re-binds the port forward to
# 0.0.0.0 so the R1 can reach the gateway on the local network.
#
# Usage:
#   ./scripts/r1-connect.sh                       # use default sandbox
#   ./scripts/r1-connect.sh --sandbox my-assistant # use named sandbox
#   ./scripts/r1-connect.sh --tunnel               # use cloudflared for remote access

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────
info()  { printf '\033[1;34m[r1]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[r1]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[r1]\033[0m  %s\n' "$*"; exit 1; }

command_exists() { command -v "$1" &>/dev/null; }

DASHBOARD_PORT="${DASHBOARD_PORT:-18789}"
SANDBOX_NAME=""
USE_TUNNEL=false
OUTPUT_DIR="${OUTPUT_DIR:-.}"

# ── Parse flags ──────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox)
      SANDBOX_NAME="${2:?--sandbox requires a name}"
      shift 2
      ;;
    --tunnel)
      USE_TUNNEL=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# ── Resolve sandbox name from NemoClaw registry ─────────────────
if [ -z "$SANDBOX_NAME" ]; then
  REGISTRY="$HOME/.nemoclaw/sandboxes.json"
  if [ -f "$REGISTRY" ]; then
    # Read defaultSandbox, fall back to first key
    SANDBOX_NAME=$(node -e "
      const r = require('$REGISTRY');
      console.log(r.defaultSandbox || Object.keys(r.sandboxes || {})[0] || '');
    " 2>/dev/null || true)
  fi
  if [ -z "$SANDBOX_NAME" ]; then
    error "No sandbox found. Run 'nemoclaw onboard' first, or pass --sandbox <name>."
  fi
fi

info "Using sandbox: $SANDBOX_NAME"

# ── Verify sandbox is running ────────────────────────────────────
command_exists openshell || error "openshell CLI not found. Is OpenShell installed?"

SANDBOX_LIST=$(openshell sandbox list 2>&1 || true)
if ! echo "$SANDBOX_LIST" | grep -q "$SANDBOX_NAME"; then
  error "Sandbox '$SANDBOX_NAME' not found. Run 'nemoclaw onboard' first."
fi

# ── Set up SSH to sandbox ────────────────────────────────────────
SSH_CONF=$(mktemp /tmp/nemoclaw-r1-ssh-XXXXXX.conf)
openshell sandbox ssh-config "$SANDBOX_NAME" > "$SSH_CONF" 2>/dev/null
SSH_HOST="openshell-${SANDBOX_NAME}"

sandbox_exec() {
  ssh -T -o StrictHostKeyChecking=no -o LogLevel=ERROR -F "$SSH_CONF" "$SSH_HOST" "$@"
}

cleanup() {
  rm -f "$SSH_CONF"
}
trap cleanup EXIT

# Verify SSH connectivity
if ! sandbox_exec "echo ok" &>/dev/null; then
  error "Cannot SSH into sandbox '$SANDBOX_NAME'. Is it in Ready state?"
fi

info "SSH connection to sandbox verified"

# ── Confirm with user ───────────────────────────────────────────
echo ""
echo "This script will configure the OpenClaw gateway for R1 access:"
echo ""
echo "  1. Bind gateway to all network interfaces (0.0.0.0)"
echo "     This allows connections from other devices on your local network."
echo ""
echo "     WARNING: This is intended for home networks only."
echo "     Do not run on cloud instances where your IP is publicly accessible."
echo ""
echo "  2. Enable token authentication"
echo "     Requires a secret token to connect, preventing unauthorized access."
echo ""
echo "  3. Generate/reuse an authentication token"
echo "     A secure random token will be created (or existing one reused)."
echo ""
echo "  4. Re-bind the port forward on 0.0.0.0:$DASHBOARD_PORT"
echo "     So the R1 can reach the gateway over the local network."
echo ""
read -p "Do you want to proceed with these changes? [y/N] " confirm < /dev/tty
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

# ── Configure gateway inside sandbox ─────────────────────────────
info "Configuring OpenClaw gateway inside sandbox..."

# Check for existing token, reuse if present
EXISTING_TOKEN=$(sandbox_exec "openclaw config get gateway.auth.token 2>/dev/null" || echo "")
EXISTING_TOKEN=$(echo "$EXISTING_TOKEN" | tr -d '[:space:]')

if [ -n "$EXISTING_TOKEN" ] && [ "$EXISTING_TOKEN" != "null" ] && [ "$EXISTING_TOKEN" != "undefined" ]; then
  TOKEN="$EXISTING_TOKEN"
  info "Reusing existing auth token"
else
  TOKEN=$(openssl rand -hex 32)
  info "Generated new auth token"
fi

# Apply gateway config inside the sandbox
sandbox_exec "openclaw config set gateway.bind lan"
sandbox_exec "openclaw config set gateway.auth.mode token"
sandbox_exec "openclaw config set gateway.auth.token '$TOKEN'"
sandbox_exec "openclaw config set gateway.controlUi.allowInsecureAuth true"

info "Restarting gateway inside sandbox..."
sandbox_exec "openclaw gateway restart" 2>/dev/null || true

# Give the gateway a moment to come back up
sleep 3

# Verify gateway is running
if sandbox_exec "openclaw gateway status" &>/dev/null; then
  info "Gateway restarted successfully"
else
  warn "Gateway may still be starting — continuing anyway"
fi

# ── Re-bind port forward to 0.0.0.0 ─────────────────────────────
info "Re-binding port forward to 0.0.0.0:$DASHBOARD_PORT..."

openshell forward stop "$DASHBOARD_PORT" 2>/dev/null || true

# Wait for the port to be released — the previous forward may take a moment to
# close the listening socket.  Also kill any leftover process on the port.
for _attempt in 1 2 3; do
  if ! lsof -i ":${DASHBOARD_PORT}" -sTCP:LISTEN -t &>/dev/null; then
    break
  fi
  # Force-kill whatever is still holding the port
  lsof -i ":${DASHBOARD_PORT}" -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 1
done

openshell forward start --background "0.0.0.0:${DASHBOARD_PORT}" "$SANDBOX_NAME"

info "Port forward active on 0.0.0.0:$DASHBOARD_PORT"

# ── Detect host LAN IPs ─────────────────────────────────────────
get_lan_ips() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    ifconfig | grep 'inet ' | awk '{print $2}' | \
      grep -v '^127\.' | grep -v '^169\.254\.'
  else
    ip -4 addr show 2>/dev/null | \
      grep -oP '(?<=inet\s)\d+(\.\d+){3}' | \
      grep -v '^127\.' | grep -v '^169\.254\.' | grep -v '^172\.17\.'
  fi
}

# ── Handle tunnel mode ───────────────────────────────────────────
TUNNEL_URL=""
TUNNEL_PID=""

if [ "$USE_TUNNEL" = true ]; then
  if ! command_exists cloudflared; then
    warn "cloudflared not found. Install it or use LAN mode (without --tunnel)."
    warn "On macOS: brew install cloudflared"
    warn "Falling back to LAN mode."
    USE_TUNNEL=false
  else
    info "Starting cloudflared tunnel to localhost:$DASHBOARD_PORT..."
    TUNNEL_LOG=$(mktemp /tmp/nemoclaw-r1-tunnel-XXXXXX.log)
    nohup cloudflared tunnel --url "http://localhost:$DASHBOARD_PORT" > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!

    # Wait for tunnel URL
    for _ in $(seq 1 20); do
      TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
      if [ -n "$TUNNEL_URL" ]; then
        break
      fi
      sleep 1
    done

    if [ -n "$TUNNEL_URL" ]; then
      info "Tunnel active: $TUNNEL_URL"
    else
      warn "Tunnel URL not detected within 20s. Check $TUNNEL_LOG"
      USE_TUNNEL=false
    fi
  fi
fi

# ── Build QR payload ─────────────────────────────────────────────
IPS=$(get_lan_ips | while read -r ip; do echo "\"$ip\""; done | paste -sd ',' -)
if [ -z "$IPS" ] && [ "$USE_TUNNEL" = false ]; then
  error "No LAN IP addresses detected (ifconfig/ip command may be missing)."
fi

if [ "$USE_TUNNEL" = true ] && [ -n "$TUNNEL_URL" ]; then
  # Extract hostname from tunnel URL for the QR payload
  TUNNEL_HOST=$(echo "$TUNNEL_URL" | sed 's|https://||')
  JSON_PAYLOAD="{\"type\":\"clawdbot-gateway\",\"version\":1,\"ips\":[\"$TUNNEL_HOST\"],\"port\":443,\"token\":\"$TOKEN\",\"protocol\":\"wss\"}"
else
  JSON_PAYLOAD="{\"type\":\"clawdbot-gateway\",\"version\":1,\"ips\":[$IPS],\"port\":$DASHBOARD_PORT,\"token\":\"$TOKEN\",\"protocol\":\"ws\"}"
fi

# ── Display connection info ──────────────────────────────────────
echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │  NemoClaw + Rabbit R1                                │"
echo "  │                                                      │"
printf "  │  Sandbox:  %-42s│\n" "$SANDBOX_NAME"
printf "  │  Port:     %-42s│\n" "$DASHBOARD_PORT"
echo "  │  Auth:     token                                     │"
echo "  │                                                      │"

if [ "$USE_TUNNEL" = true ] && [ -n "$TUNNEL_URL" ]; then
  printf "  │  Tunnel:   %-42s│\n" "$TUNNEL_URL"
fi

echo "  │  LAN IPs:                                            │"
get_lan_ips | while read -r ip; do
  printf "  │    %-49s│\n" "ws://$ip:$DASHBOARD_PORT"
done

echo "  │                                                      │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""

echo "Token: $TOKEN"
echo ""

# ── Generate QR code ─────────────────────────────────────────────
info "QR Code (scan with your R1):"
echo ""
npx --yes qrcode "$JSON_PAYLOAD" --small < /dev/null

OUTPUT_FILE="$OUTPUT_DIR/r1-gateway-connection.png"
info "Saving QR code to: $OUTPUT_FILE"
npx --yes qrcode "$JSON_PAYLOAD" -o "$OUTPUT_FILE" < /dev/null 2>/dev/null
echo ""

# ── Wait for R1 and auto-approve ─────────────────────────────────
info "Waiting for Rabbit R1 to connect (timeout: 5 minutes)..."
TIMEOUT=300
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  PENDING=$(sandbox_exec "openclaw devices list --json 2>/dev/null" | \
    node -e "
      let d='';
      process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        try {
          const data=JSON.parse(d);
          const pending=data.pending||[];
          const r1=pending.find(p=>(p.displayName||'').includes('Rabbit R1'));
          if(r1&&r1.requestId) console.log(r1.requestId);
        } catch {}
      });
    " 2>/dev/null || true)

  if [ -n "$PENDING" ]; then
    info "Found Rabbit R1 device, approving..."
    sandbox_exec "openclaw devices approve '$PENDING'" 2>/dev/null
    info "Device approved successfully!"

    echo ""
    echo "  ✓ Your Rabbit R1 is now connected to OpenClaw"
    echo "    running inside NemoClaw sandbox '$SANDBOX_NAME'."
    echo ""
    echo "  To monitor network egress approvals:"
    echo "    openshell term"
    echo ""

    # Clean up tunnel on exit if running
    if [ -n "$TUNNEL_PID" ]; then
      echo "  Tunnel is still running (PID $TUNNEL_PID)."
      echo "  Press Ctrl+C to stop, or kill $TUNNEL_PID when done."
      echo ""
      wait "$TUNNEL_PID" 2>/dev/null || true
    fi
    exit 0
  fi

  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

warn "Timeout: No Rabbit R1 device found within 5 minutes."
warn "Make sure your R1 scanned the QR code and is on the same network."

if [ -n "$TUNNEL_PID" ]; then
  kill "$TUNNEL_PID" 2>/dev/null || true
fi
exit 1
