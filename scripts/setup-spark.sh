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
fail() { echo -e "${RED}>>>${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

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

command -v docker > /dev/null || fail "Docker not found. DGX Spark should have Docker pre-installed."

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

# ── 1b. Check for conflicting Kubernetes installations ────────────
#
# If another kubelet is running on the host (MicroK8s, k3s, kubeadm),
# setting cgroupns=host will cause k3s inside the gateway container to
# fight over /sys/fs/cgroup/kubepods with the host kubelet. Both see
# each other's pods as orphaned and kill them → CrashLoopBackOff.
# See: https://github.com/NVIDIA/NemoClaw/issues/431

detect_conflicting_kubelet() {
  local found=""

  # Check for common kubelet processes (including k3s itself)
  if pgrep -x kubelet > /dev/null 2>&1 || pgrep -x kubelite > /dev/null 2>&1 || pgrep -x k3s > /dev/null 2>&1; then
    found="kubelet process detected"
  fi

  # Check for MicroK8s specifically
  if [ -z "$found" ] && command -v microk8s > /dev/null 2>&1; then
    if microk8s status 2>/dev/null | grep -q "microk8s is running"; then
      found="MicroK8s is running"
    fi
  fi

  # Check for k3s/k3s-agent service
  if [ -z "$found" ] && (systemctl is-active --quiet k3s 2>/dev/null || systemctl is-active --quiet k3s-agent 2>/dev/null); then
    found="k3s service is active"
  fi

  if [ -n "$found" ]; then
    warn "⚠️  Conflicting Kubernetes detected: $found"
    warn ""
    warn "The gateway runs k3s inside Docker with cgroupns=host, which will"
    warn "conflict with the host kubelet over /sys/fs/cgroup/kubepods."
    warn "This causes all pods to enter CrashLoopBackOff."
    warn ""
    warn "Options:"
    warn "  1. Stop the host Kubernetes first:"
    warn "     sudo microk8s stop        # for MicroK8s"
    warn "     sudo systemctl stop k3s   # for k3s"
    warn "     sudo systemctl stop kubelet  # for kubeadm"
    warn ""
    warn "  2. Continue anyway (gateway will likely fail)"
    warn ""

    if [ -t 0 ]; then
      if ! read -rp "Continue anyway? [y/N] " reply; then
        fail "Aborted (no input). Stop the conflicting Kubernetes service and retry."
      fi
      if [[ ! "$reply" =~ ^[Yy] ]]; then
        fail "Aborted. Stop the conflicting Kubernetes service and retry."
      fi
    else
      fail "Conflicting Kubernetes detected. Stop it first or run interactively to override."
    fi
  fi
}

detect_conflicting_kubelet

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
  echo '{ "default-cgroupns-mode": "host" }' > "$DAEMON_JSON"
  NEEDS_RESTART=true
fi

# ── 3. Restart Docker if needed ───────────────────────────────────

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
  info "Docker restarted with cgroupns=host"
fi

# ── 4. Run normal setup ──────────────────────────────────────────

echo ""
info "DGX Spark Docker configuration complete."
info ""
info "Next step: run 'nemoclaw onboard' to set up your sandbox."
info "  nemoclaw onboard"
