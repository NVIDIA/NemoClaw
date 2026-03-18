#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw setup for macOS / Apple Silicon.
#
# Apple Silicon Macs have no NVIDIA GPU, so NIM runs via cloud inference.
# This script verifies Docker Desktop (or Colima), Ollama, Node.js, and
# the openshell CLI — everything needed before `nemoclaw onboard`.
#
# Usage:
#   nemoclaw setup-apple
#   # or directly:
#   bash scripts/setup-apple.sh
#
# What it does:
#   1. Verifies macOS + Apple Silicon
#   2. Checks Docker Desktop / Colima is running
#   3. Checks / installs Ollama for local inference
#   4. Checks / installs openshell CLI
#   5. Detects Apple GPU and unified memory
#   6. Warns about nvm PATH issues
#   7. Prints next steps

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}>>>${NC} $1" >&2; }
fail() { echo -e "${RED}>>>${NC} $1" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 1. Pre-flight checks ─────────────────────────────────────────

if [ "$(uname -s)" != "Darwin" ]; then
  fail "This script is for macOS. Use 'nemoclaw setup-spark' for DGX Spark."
fi

info "macOS detected: $(sw_vers -productVersion 2>/dev/null || echo 'unknown version')"

# Validate HOME environment variable
if [ -z "${HOME:-}" ]; then
  fail "HOME environment variable is not set"
elif [[ ! "$HOME" =~ ^/ ]]; then
  fail "HOME must be an absolute path, got: $HOME"
elif [ ! -d "$HOME" ]; then
  fail "HOME directory does not exist: $HOME"
fi

# Check architecture
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  # Check if running under Rosetta 2 translation
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    warn "Running under Rosetta 2 translation. Use native ARM64 binaries for best performance:"
    warn "  Node.js: brew install node@20"
    warn "  Docker: Download Apple Silicon version from docker.com"
  fi
  info "Apple Silicon detected ($ARCH)"
else
  warn "Intel Mac detected ($ARCH). This script is optimized for Apple Silicon."
  warn "Note: Local Ollama inference requires Apple Silicon. Use cloud inference (build.nvidia.com) instead."
fi

# Node.js 20+
if ! command -v node > /dev/null 2>&1; then
  fail "Node.js not found. Install via brew or download from nodejs.org (LTS recommended): brew install node@20"
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  fail "Node.js 20+ required (found v$(node -v)). Upgrade via: brew install node@20"
fi
info "Node.js $(node -v) OK"

# ── 2. Docker Desktop / Colima ───────────────────────────────────

DOCKER_SOCKET=""
for _sock in \
  /var/run/docker.sock \
  "$HOME/.docker/run/docker.sock" \
  "$HOME/.colima/default/docker.sock" \
  "$HOME/.config/colima/default/docker.sock"; do
  if [ -S "$_sock" ]; then
    DOCKER_SOCKET="$_sock"
    break
  fi
done

if [ -z "$DOCKER_SOCKET" ]; then
  fail "No Docker socket found. Install and start Docker Desktop or Colima."
fi

if ! docker info > /dev/null 2>&1; then
  fail "Docker is installed but not responding. Start Docker Desktop (or 'colima start')."
fi

# Check if this is Colima
if echo "$DOCKER_SOCKET" | grep -q colima; then
  info "Colima detected (socket: $DOCKER_SOCKET)"
  warn "Note: Colima may require DNS fixes for k3s. This will be handled during onboard."
else
  info "Docker Desktop detected (socket: $DOCKER_SOCKET)"
fi

# Check Docker memory allocation
DOCKER_MEM_BYTES=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo "0")

if ! [[ "$DOCKER_MEM_BYTES" =~ ^[0-9]+$ ]] || [ "$DOCKER_MEM_BYTES" = "0" ]; then
  warn "Could not determine Docker memory allocation. Ensure Docker is running properly."
else
  DOCKER_MEM_GB=$(( DOCKER_MEM_BYTES / 1073741824 ))

  if [ "$DOCKER_MEM_GB" -lt 8 ]; then
    warn "Docker has ${DOCKER_MEM_GB}GB memory allocated. Recommend >= 8GB for sandbox."
    if echo "$DOCKER_SOCKET" | grep -qF colima; then
      warn "Increase in Colima: colima stop && colima start --memory 8"
    else
      warn "Increase in Docker Desktop: Settings > Resources > Memory"
    fi
  else
    info "Docker memory: ${DOCKER_MEM_GB}GB (>= 8GB OK)"
  fi
fi

# ── 3. Ollama ────────────────────────────────────────────────────

echo ""
info "Checking Ollama (optional for local inference on Apple Silicon)..."
if ! command -v ollama > /dev/null 2>&1; then
  warn "Ollama not installed. For local inference on Apple Silicon:"
  warn "  brew install ollama    # OR download from ollama.ai"
  warn ""
  warn "Skip this if you only want cloud inference (build.nvidia.com)."
else
  info "Ollama installed: $(ollama --version 2>/dev/null || echo 'unknown')"

  # Check if Ollama is running
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    info "Ollama is running on localhost:11434"
  else
    warn "Ollama is installed but not running."
    warn "Start it with: OLLAMA_HOST=0.0.0.0:11434 ollama serve"
  fi

  # Check OLLAMA_HOST binding
  if [ -n "${OLLAMA_HOST:-}" ]; then
    info "OLLAMA_HOST=$OLLAMA_HOST"
  else
    warn "OLLAMA_HOST is not set. For Docker containers to reach Ollama:"
    warn "  export OLLAMA_HOST=0.0.0.0:11434"
    warn "  ollama serve"
    warn ""
    warn "Or add to ~/.zshrc and restart your shell:"
    warn "  echo 'export OLLAMA_HOST=0.0.0.0:11434' >> ~/.zshrc"
    warn ""
    warn "Skip this if using cloud inference only."
  fi
fi

# ── 4. OpenShell CLI ─────────────────────────────────────────────

echo ""
if ! command -v openshell > /dev/null 2>&1; then
  info "openshell CLI not found. Installing..."
  info "(May require sudo password for /usr/local/bin access)"
  bash "$SCRIPT_DIR/install-openshell.sh"
  if ! command -v openshell > /dev/null 2>&1; then
    fail "Failed to install openshell CLI. Install manually: https://github.com/NVIDIA/OpenShell/releases"
  fi
fi
info "openshell CLI: $(openshell --version 2>/dev/null || echo 'installed')"

# ── 5. Apple GPU detection ───────────────────────────────────────

echo ""
info "Detecting Apple GPU (this may take a few seconds)..."
# Use timeout to prevent system_profiler from hanging (can take 5-10s normally)
GPU_INFO=$(timeout 15s system_profiler SPDisplaysDataType 2>/dev/null || true)

if [ -z "$GPU_INFO" ]; then
  warn "Could not detect GPU information (system_profiler timed out or unavailable)"
else
  CHIP_NAME=$(echo "$GPU_INFO" | grep "Chipset Model:" | head -1 | sed 's/.*Chipset Model: //' | xargs)
  GPU_CORES=$(echo "$GPU_INFO" | grep "Total Number of Cores:" | head -1 | sed 's/.*Total Number of Cores: //' | xargs)
  # Get unified memory from system
  UNIFIED_MEM=$(sysctl -n hw.memsize 2>/dev/null || echo "0")
  UNIFIED_MEM_GB=$(( UNIFIED_MEM / 1073741824 ))

  if [ -n "$CHIP_NAME" ]; then
    info "Apple GPU: $CHIP_NAME"
    [ -n "$GPU_CORES" ] && info "  GPU cores: $GPU_CORES"
    [ "$UNIFIED_MEM_GB" -gt 0 ] && info "  Unified memory: ${UNIFIED_MEM_GB}GB"
  fi
fi

echo ""
info "Note: NIM containers require an NVIDIA GPU."
info "On Apple Silicon, inference runs via cloud API (build.nvidia.com)"
info "or locally through Ollama."

# ── 6. nvm PATH fix ─────────────────────────────────────────────

if [ -n "${NVM_DIR:-}" ] || [ -d "$HOME/.nvm" ]; then
  warn "nvm detected. If you see Node version mismatch issues (#120),"
  warn "pin your default version:"
  warn "  nvm alias default \$(node -v)"
fi

# ── 7. Next steps ────────────────────────────────────────────────

echo ""
info "macOS setup checks complete."
info ""
info "Next step: run 'nemoclaw onboard' to:"
info "  - Create your sandbox"
info "  - Configure inference provider (cloud API or local Ollama)"
info "  - Apply security policies"
info ""
info "Run:"
info "  nemoclaw onboard"
