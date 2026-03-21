#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw setup for Jetson devices (Orin Nano, Orin NX, AGX Orin).
#
# Jetson kernels (5.15.x-tegra) may not include nf_tables NAT modules.
# OpenShell's gateway starts k3s inside a Docker container, which uses
# iptables for networking. If the kernel lacks nf_tables support, the
# container's iptables-nft binary fails and k3s cannot start.
#
# This script configures the host for best compatibility:
#   1. Adds current user to docker group (avoids sudo for everything else)
#   2. Sets iptables-legacy as the system default via update-alternatives
#   3. Configures Docker daemon for cgroupns=host (k3s-in-Docker)
#   4. Restarts Docker
#
# Usage:
#   sudo nemoclaw setup-jetson
#   # or directly:
#   sudo bash scripts/setup-jetson.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}>>>${NC} $1"; }
fail() { echo -e "${RED}>>>${NC} $1"; exit 1; }

# ── Pre-flight checks ─────────────────────────────────────────────

if [ "$(uname -s)" != "Linux" ]; then
  fail "This script is for Jetson devices (Linux). Use 'nemoclaw setup' for macOS."
fi

if [ "$(id -u)" -ne 0 ]; then
  fail "Must run as root: sudo nemoclaw setup-jetson"
fi

# Verify this is a Jetson device
IS_JETSON=false
if uname -r | grep -qi tegra; then
  IS_JETSON=true
elif [ -f /etc/nv_tegra_release ]; then
  IS_JETSON=true
elif [ -f /proc/device-tree/compatible ] && grep -qi 'nvidia,tegra\|nvidia,jetson' /proc/device-tree/compatible 2>/dev/null; then
  IS_JETSON=true
fi

if [ "$IS_JETSON" = false ]; then
  fail "This does not appear to be a Jetson device. Use 'nemoclaw setup-spark' for DGX Spark."
fi

# Detect the real user (not root) for docker group add
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo "")}"
if [ -z "$REAL_USER" ]; then
  warn "Could not detect non-root user. Docker group will not be configured."
fi

command -v docker > /dev/null || fail "Docker not found. Install Docker before running this script."

# ── 1. Docker group ───────────────────────────────────────────────

if [ -n "$REAL_USER" ]; then
  if id -nG "$REAL_USER" | grep -qw docker; then
    info "User '$REAL_USER' already in docker group"
  else
    info "Adding '$REAL_USER' to docker group..."
    usermod -aG docker "$REAL_USER"
    info "Added. Group will take effect on next login (or use 'newgrp docker')."
  fi
fi

# ── 2. iptables-legacy ────────────────────────────────────────────
#
# Jetson kernels may lack nf_tables NAT modules (nft_chain_nat,
# xt_MASQUERADE). Switch the host to iptables-legacy so Docker's own
# networking uses the legacy backend. This does not fix the container's
# internal iptables (that requires OpenShell to pass IPTABLES_MODE=legacy),
# but it ensures the host-side Docker networking works correctly.

NEEDS_RESTART=false

if command -v update-alternatives > /dev/null 2>&1; then
  CURRENT_IPTABLES=$(iptables --version 2>/dev/null || echo "")
  if echo "$CURRENT_IPTABLES" | grep -q "nf_tables"; then
    info "Host iptables uses nf_tables backend. Switching to legacy..."
    update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null || warn "Could not set iptables-legacy (alternative may not exist)"
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null || warn "Could not set ip6tables-legacy (alternative may not exist)"
    NEEDS_RESTART=true
  else
    info "Host iptables already uses legacy backend"
  fi
else
  warn "update-alternatives not found. Cannot switch iptables to legacy mode."
  warn "Manually symlink /usr/sbin/iptables to /usr/sbin/iptables-legacy if available."
fi

# ── 3. Docker cgroup namespace ────────────────────────────────────
#
# Newer JetPack versions may use cgroup v2. OpenShell's gateway embeds
# k3s in a Docker container, which needs --cgroupns=host to manage
# cgroup hierarchies.

DAEMON_JSON="/etc/docker/daemon.json"

if [ -f "$DAEMON_JSON" ]; then
  if grep -q '"default-cgroupns-mode"' "$DAEMON_JSON" 2>/dev/null; then
    CURRENT_MODE=$(python3 -c "import json; print(json.load(open('$DAEMON_JSON')).get('default-cgroupns-mode',''))" 2>/dev/null || echo "")
    if [ "$CURRENT_MODE" = "host" ]; then
      info "Docker daemon already configured for cgroupns=host"
    else
      info "Updating Docker daemon cgroupns mode to 'host'..."
      python3 -c "
import json
with open('$DAEMON_JSON') as f:
    d = json.load(f)
d['default-cgroupns-mode'] = 'host'
with open('$DAEMON_JSON', 'w') as f:
    json.dump(d, f, indent=2)
"
      NEEDS_RESTART=true
    fi
  else
    info "Adding cgroupns=host to Docker daemon config..."
    python3 -c "
import json
try:
    with open('$DAEMON_JSON') as f:
        d = json.load(f)
except:
    d = {}
d['default-cgroupns-mode'] = 'host'
with open('$DAEMON_JSON', 'w') as f:
    json.dump(d, f, indent=2)
"
    NEEDS_RESTART=true
  fi
else
  info "Creating Docker daemon config with cgroupns=host..."
  mkdir -p "$(dirname "$DAEMON_JSON")"
  echo '{ "default-cgroupns-mode": "host" }' > "$DAEMON_JSON"
  NEEDS_RESTART=true
fi

# ── 4. Restart Docker if needed ───────────────────────────────────

if [ "$NEEDS_RESTART" = true ]; then
  info "Restarting Docker daemon..."
  systemctl restart docker
  # Wait for Docker to be ready
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if docker info > /dev/null 2>&1; then
      break
    fi
    [ "$i" -eq 10 ] && fail "Docker didn't come back after restart. Check 'systemctl status docker'."
    sleep 2
  done
  info "Docker restarted successfully"
fi

# ── Done ──────────────────────────────────────────────────────────

echo ""
info "Jetson host configuration complete."
info ""
info "Next step: run 'nemoclaw onboard' to set up your sandbox."
info "The onboard wizard will automatically patch the gateway image"
info "to use iptables-legacy."
info ""
info "  nemoclaw onboard"
