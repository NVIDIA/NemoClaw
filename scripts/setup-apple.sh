#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw setup for Apple Silicon Macs (M-series).
#
# macOS cannot run k3s natively — OpenShell runs inside Docker Desktop's
# Linux VM. This script validates the Docker environment, configures
# Ollama for local inference, and ensures the sandbox can reach it.
#
# Usage:
#   nemoclaw setup-apple
#   # or directly:
#   bash scripts/setup-apple.sh
#
# What it does:
#   1. Validates macOS + Apple Silicon environment
#   2. Checks Docker Desktop is running and socket is reachable
#   3. Installs and configures Ollama for local inference
#   4. Validates OpenShell gateway can start
#   5. Prints recommended next steps

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
NC='\033[0m'

info() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}>>>${NC} $1"; }
fail() { echo -e "${RED}>>>${NC} $1"; exit 1; }
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }

# ── Pre-flight checks ─────────────────────────────────────────────

if [ "$(uname -s)" != "Darwin" ]; then
  fail "This script is for macOS. Use 'nemoclaw setup-spark' for DGX Spark or 'nemoclaw onboard' for Linux."
fi

ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ] && [ "$ARCH" != "aarch64" ]; then
  fail "This script is for Apple Silicon Macs (arm64). Detected: ${ARCH}. Use 'nemoclaw onboard' for other platforms."
fi

step "1/5  Checking macOS environment"

# Report hardware
GPU_CORES=""
UNIFIED_MEM=""
if command -v system_profiler &>/dev/null; then
  GPU_CORES=$(system_profiler SPDisplaysDataType 2>/dev/null | grep "Total Number of Cores" | awk -F': ' '{print $2}' | head -1 || true)
  UNIFIED_MEM=$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f", $1/1024/1024/1024}')
fi
info "macOS $(sw_vers -productVersion 2>/dev/null || echo 'unknown') on ${ARCH}"
[ -n "$GPU_CORES" ] && info "GPU: ${GPU_CORES} cores, ${UNIFIED_MEM}GB unified memory"

# ── Docker Desktop ─────────────────────────────────────────────────

step "2/5  Checking Docker Desktop"

if ! command -v docker &>/dev/null; then
  fail "Docker not found. Install Docker Desktop for Mac: https://www.docker.com/products/docker-desktop/"
fi

if ! docker info &>/dev/null 2>&1; then
  fail "Docker daemon is not running. Start Docker Desktop and try again."
fi

# Find Docker socket (Docker Desktop, Colima, or Podman)
DOCKER_SOCKET=""
for _sock in \
  "$HOME/.docker/run/docker.sock" \
  "/var/run/docker.sock" \
  "$HOME/.colima/default/docker.sock" \
  "$HOME/.config/colima/default/docker.sock" \
  "$HOME/.local/share/containers/podman/machine/podman.sock"; do
  if [ -S "$_sock" ]; then
    DOCKER_SOCKET="$_sock"
    break
  fi
done

if [ -n "$DOCKER_SOCKET" ]; then
  info "Docker socket: ${DOCKER_SOCKET}"
else
  warn "Could not locate Docker socket (Docker is running but socket path unknown)"
fi

DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "unknown")
info "Docker ${DOCKER_VERSION}"

# ── Ollama ─────────────────────────────────────────────────────────

step "3/5  Configuring local inference (Ollama)"

OLLAMA_INSTALLED=false
OLLAMA_RUNNING=false

if command -v ollama &>/dev/null; then
  OLLAMA_INSTALLED=true
  info "Ollama found: $(ollama --version 2>/dev/null || echo 'installed')"
else
  info "Ollama not installed. Installing via Homebrew..."
  if command -v brew &>/dev/null; then
    brew install ollama 2>/dev/null && OLLAMA_INSTALLED=true || warn "Ollama install failed. Install manually: https://ollama.com"
  else
    warn "Homebrew not found. Install Ollama manually: https://ollama.com"
  fi
fi

if [ "$OLLAMA_INSTALLED" = true ]; then
  # Check if Ollama is serving
  if curl -s --max-time 3 http://localhost:11434/api/tags &>/dev/null; then
    OLLAMA_RUNNING=true
    info "Ollama is running on port 11434"
  else
    # Prefer brew services (managed, survives reboots)
    if brew services list 2>/dev/null | grep -q "ollama.*started"; then
      OLLAMA_RUNNING=true
      info "Ollama managed by brew services (already running)"
    else
      info "Starting Ollama via brew services..."
      if brew services start ollama &>/dev/null 2>&1; then
        info "Ollama started via brew services"
      else
        info "brew services unavailable — starting directly..."
        OLLAMA_HOST=0.0.0.0:11434 ollama serve &>/dev/null &
        OLLAMA_BG_PID=$!
        trap 'kill $OLLAMA_BG_PID 2>/dev/null || true' INT TERM
      fi
    fi
    sleep 3
    if curl -s --max-time 3 http://localhost:11434/api/tags &>/dev/null; then
      OLLAMA_RUNNING=true
      info "Ollama started successfully"
    else
      warn "Ollama failed to start. You can start it manually: OLLAMA_HOST=0.0.0.0:11434 ollama serve"
    fi
  fi

  # Suggest pulling a model if none present
  if [ "$OLLAMA_RUNNING" = true ]; then
    MODEL_COUNT=$(set +o pipefail; curl -s http://localhost:11434/api/tags 2>/dev/null | grep -co '"name"' 2>/dev/null || echo "0")
    if [ "$MODEL_COUNT" = "0" ]; then
      info "No models found. For local inference, pull a model:"
      echo "    ollama pull llama3.1:8b     # 4.7GB, good balance"
      echo "    ollama pull qwen3:8b        # 4.9GB, strong reasoning"
    else
      info "Ollama has ${MODEL_COUNT} model(s) available"
    fi
  fi
fi

# ── OpenShell gateway ──────────────────────────────────────────────

step "4/5  Validating OpenShell"

if command -v openshell &>/dev/null; then
  info "OpenShell CLI found: $(openshell --version 2>/dev/null || echo 'installed')"
else
  warn "OpenShell CLI not found. Run 'nemoclaw onboard' to install it."
fi

# ── Summary ────────────────────────────────────────────────────────

step "5/5  Apple Silicon setup complete"

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │  NemoClaw — Apple Silicon Environment Summary   │"
echo "  ├─────────────────────────────────────────────────┤"
printf "  │  %-20s %-27s │\n" "macOS:" "$(sw_vers -productVersion 2>/dev/null || echo 'unknown') (${ARCH})"
printf "  │  %-20s %-27s │\n" "Docker:" "${DOCKER_VERSION}"
if [ "$OLLAMA_INSTALLED" = true ]; then
  if [ "$OLLAMA_RUNNING" = true ]; then
    printf "  │  %-20s %-27s │\n" "Ollama:" "✅ Running (port 11434)"
  else
    printf "  │  %-20s %-27s │\n" "Ollama:" "⚠️  Installed (not running)"
  fi
else
  printf "  │  %-20s %-27s │\n" "Ollama:" "❌ Not installed"
fi
if command -v openshell &>/dev/null; then
  printf "  │  %-20s %-27s │\n" "OpenShell:" "✅ Installed"
else
  printf "  │  %-20s %-27s │\n" "OpenShell:" "❌ Not found"
fi
echo "  └─────────────────────────────────────────────────┘"
echo ""

info "Next steps:"
echo "  1. Run 'nemoclaw onboard' to create your first sandbox"
echo "  2. For local inference: ollama pull llama3.1:8b"
echo "  3. For cloud inference: get an API key at https://build.nvidia.com"
echo ""
info "Known macOS limitations:"
echo "  • Ollama local inference may need DNS fix (inference.local → sandbox)"
echo "  • Docker Model Runner bridge not yet supported"
echo "  • See: https://github.com/NVIDIA/NemoClaw/issues/260"
