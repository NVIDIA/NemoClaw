#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw setup for NVIDIA Jetson devices (Orin Nano, Orin NX, AGX Orin, Thor).
#
# Jetson devices use unified memory and a Tegra kernel that lacks nf_tables
# chain modules (nft_chain_filter, nft_chain_nat, etc.). The OpenShell gateway
# runs k3s inside a Docker container, and k3s's network policy controller
# uses iptables in nf_tables mode by default, which panics on Tegra kernels.
#
# This script prepares the Jetson host so that `nemoclaw onboard` succeeds:
#   1. Verifies Jetson platform
#   2. Ensures NVIDIA Container Runtime is configured for Docker
#   3. Loads required kernel modules (br_netfilter, xt_comment)
#   4. Configures Docker daemon with default-runtime=nvidia
#
# The iptables-legacy patch for the gateway container image is handled
# automatically by `nemoclaw onboard` when it detects a Jetson GPU.
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
  fail "This script is for NVIDIA Jetson (Linux). Use 'nemoclaw setup' for macOS."
fi

if [ "$(uname -m)" != "aarch64" ]; then
  fail "Jetson devices are aarch64. This system is $(uname -m)."
fi

if [ "$(id -u)" -ne 0 ]; then
  fail "Must run as root: sudo nemoclaw setup-jetson"
fi

# Verify Jetson platform
JETSON_MODEL=""
if [ -f /proc/device-tree/model ]; then
  JETSON_MODEL=$(tr -d '\0' < /proc/device-tree/model)
fi

if ! echo "$JETSON_MODEL" | grep -qi "jetson"; then
  # Also check nvidia-smi for Orin GPU name
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader,nounits 2>/dev/null || echo "")
  if ! echo "$GPU_NAME" | grep -qiE "orin|thor"; then
    fail "This does not appear to be a Jetson device. Use 'nemoclaw onboard' directly."
  fi
  JETSON_MODEL="${GPU_NAME}"
fi

info "Detected Jetson platform: ${JETSON_MODEL}"

# Detect the real user (not root) for docker group add
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo "")}"

command -v docker > /dev/null || fail "Docker not found. Install docker.io: sudo apt-get install -y docker.io"
command -v python3 > /dev/null || fail "python3 not found. Install with: sudo apt-get install -y python3-minimal"

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

# ── 2. NVIDIA Container Runtime ──────────────────────────────────
#
# Jetson JetPack pre-installs nvidia-container-runtime but Docker may
# not be configured to use it as the default runtime.

DAEMON_JSON="/etc/docker/daemon.json"
NEEDS_RESTART=false

configure_nvidia_runtime() {
  if ! command -v nvidia-container-runtime > /dev/null 2>&1; then
    warn "nvidia-container-runtime not found. GPU passthrough may not work."
    warn "Install with: sudo apt-get install -y nvidia-container-toolkit"
    return
  fi

  if [ -f "$DAEMON_JSON" ]; then
    # Check if nvidia runtime is already configured
    if python3 -c "
import json, sys
try:
    d = json.load(open('$DAEMON_JSON'))
    runtimes = d.get('runtimes', {})
    if 'nvidia' in runtimes:
        sys.exit(0)
    sys.exit(1)
except:
    sys.exit(1)
" 2>/dev/null; then
      info "NVIDIA runtime already configured in Docker daemon"
    else
      info "Adding NVIDIA runtime to Docker daemon config..."
      python3 -c "
import json
try:
    with open('$DAEMON_JSON') as f:
        d = json.load(f)
except:
    d = {}
d.setdefault('runtimes', {})['nvidia'] = {
    'path': 'nvidia-container-runtime',
    'runtimeArgs': []
}
d['default-runtime'] = 'nvidia'
with open('$DAEMON_JSON', 'w') as f:
    json.dump(d, f, indent=2)
"
      NEEDS_RESTART=true
    fi
  else
    info "Creating Docker daemon config with NVIDIA runtime..."
    mkdir -p "$(dirname "$DAEMON_JSON")"
    cat > "$DAEMON_JSON" <<'DAEMONJSON'
{
  "runtimes": {
    "nvidia": {
      "path": "nvidia-container-runtime",
      "runtimeArgs": []
    }
  },
  "default-runtime": "nvidia"
}
DAEMONJSON
    NEEDS_RESTART=true
  fi
}

configure_nvidia_runtime

# ── 3. Kernel modules ────────────────────────────────────────────

info "Loading required kernel modules..."
modprobe br_netfilter 2>/dev/null || warn "Could not load br_netfilter"
modprobe xt_comment 2>/dev/null || warn "Could not load xt_comment"

# Persist across reboots
MODULES_FILE="/etc/modules-load.d/nemoclaw-jetson.conf"
if [ ! -f "$MODULES_FILE" ]; then
  info "Persisting kernel modules for boot..."
  cat > "$MODULES_FILE" <<'MODULES'
# NemoClaw: required for k3s networking inside Docker
br_netfilter
xt_comment
MODULES
fi

# ── 4. Restart Docker if needed ──────────────────────────────────

if [ "$NEEDS_RESTART" = true ]; then
  info "Restarting Docker daemon..."
  systemctl restart docker
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if docker info > /dev/null 2>&1; then
      break
    fi
    [ "$i" -eq 10 ] && fail "Docker didn't come back after restart. Check 'systemctl status docker'."
    sleep 2
  done
  info "Docker restarted with NVIDIA runtime"
fi

# ── Done ─────────────────────────────────────────────────────────

echo ""
info "Jetson setup complete."
info ""
info "Device: ${JETSON_MODEL}"
info ""
info "Next step: run 'nemoclaw onboard' to set up your sandbox."
info "  nemoclaw onboard"
info ""
info "The onboard wizard will automatically patch the gateway image"
info "for Jetson iptables compatibility."
