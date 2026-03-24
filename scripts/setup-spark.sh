#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw setup for DGX Spark devices.
#
# Spark ships Ubuntu 24.04 (cgroup v2) + Docker 28.x but no k3s.
# OpenShell's gateway starts k3s inside a Docker container, which
# needs cgroup host namespace access. This script configures Docker
# for that.
#
# Usage:
#   sudo nemoclaw setup-spark
#   # or directly:
#   sudo bash scripts/setup-spark.sh
#
# What it does:
#   1. Adds current user to docker group (avoids sudo for everything else)
#   2. Configures Docker daemon for cgroupns=host (k3s-in-Docker on cgroup v2)
#   3. Restarts Docker

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}>>>${NC} $1"; }
fail() {
  echo -e "${RED}>>>${NC} $1"
  exit 1
}

# ── Pre-flight checks ─────────────────────────────────────────────

if [ "$(uname -s)" != "Linux" ]; then
  fail "This script is for DGX Spark (Linux). Use 'nemoclaw setup' for macOS."
fi

if [ "$(id -u)" -ne 0 ]; then
  fail "Must run as root: sudo nemoclaw setup-spark"
fi

# Detect the real user (not root) for docker group add
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo "")}"
if [ -z "$REAL_USER" ]; then
  warn "Could not detect non-root user. Docker group will not be configured."
fi

command -v docker >/dev/null || fail "Docker not found. DGX Spark should have Docker pre-installed."

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

# ── 2. Docker cgroup namespace ────────────────────────────────────
#
# Spark runs cgroup v2 (Ubuntu 24.04). OpenShell's gateway embeds
# k3s in a Docker container, which needs --cgroupns=host to manage
# cgroup hierarchies. Without this, kubelet fails with:
#   "openat2 /sys/fs/cgroup/kubepods/pids.max: no"
#
# Setting default-cgroupns-mode=host in daemon.json makes all
# containers use the host cgroup namespace. This is safe — it's
# the Docker default on cgroup v1 hosts anyway.

DAEMON_JSON="/etc/docker/daemon.json"
NEEDS_RESTART=false

if [ -f "$DAEMON_JSON" ]; then
  # Check if already configured
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
  echo '{ "default-cgroupns-mode": "host" }' >"$DAEMON_JSON"
  NEEDS_RESTART=true
fi

# ── 3. Restart Docker if needed ───────────────────────────────────

if [ "$NEEDS_RESTART" = true ]; then
  info "Restarting Docker daemon..."
  systemctl restart docker
  # Wait for Docker to be ready
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if docker info >/dev/null 2>&1; then
      break
    fi
    [ "$i" -eq 10 ] && fail "Docker didn't come back after restart. Check 'systemctl status docker'."
    sleep 2
  done
  info "Docker restarted with cgroupns=host"
fi

# ── 4. Run normal setup ──────────────────────────────────────────

echo ""
info "DGX Spark Docker configuration complete."
info ""
