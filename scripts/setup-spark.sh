#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw setup for DGX Spark devices.
#
# Ensures the current user is in the docker group so NemoClaw can
# manage containers without sudo.
#
# Usage:
#   sudo bash scripts/setup-spark.sh
#   # or via curl:
#   curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/setup-spark.sh | sudo bash
#
# What it does:
#   1. Adds current user to docker group (avoids sudo for everything else)

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
    DOCKER_GROUP_ADDED=true
  fi
fi

# ── 2. Next steps ─────────────────────────────────────────────────

echo ""
if [ "${DOCKER_GROUP_ADDED:-}" = true ]; then
  warn "Docker group was just added. You must open a new terminal (or run 'newgrp docker') before continuing."
else
  info "DGX Spark Docker configuration complete."
fi
