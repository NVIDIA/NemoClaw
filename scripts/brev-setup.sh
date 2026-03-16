#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Brev VM bootstrap — installs prerequisites then runs setup.sh.
#
# Run on a fresh Brev VM:
#   export NVIDIA_API_KEY=nvapi-...
#   ./scripts/brev-setup.sh
#
# What it does:
#   1. Installs Docker (if missing)
#   2. Installs NVIDIA Container Toolkit (if GPU present)
#   3. Installs openshell CLI from GitHub release (binary, no Rust build)
#   4. Runs setup.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[brev]${NC} $1"; }
warn() { echo -e "${YELLOW}[brev]${NC} $1"; }
fail() { echo -e "${RED}[brev]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY not set"

# Suppress needrestart noise from apt (Scanning processes, No services need...)
export NEEDRESTART_MODE=a
export DEBIAN_FRONTEND=noninteractive

# --- 0. Node.js (needed for services) ---
if ! command -v node > /dev/null 2>&1; then
  info "Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - > /dev/null 2>&1
  sudo apt-get install -y -qq nodejs > /dev/null 2>&1
  info "Node.js $(node --version) installed"
else
  info "Node.js already installed: $(node --version)"
fi

# --- 1. Docker ---
if ! command -v docker > /dev/null 2>&1; then
  info "Installing Docker..."
  sudo apt-get update -qq > /dev/null 2>&1
  sudo apt-get install -y -qq docker.io > /dev/null 2>&1
  sudo usermod -aG docker "$(whoami)"
  info "Docker installed"
else
  info "Docker already installed"
fi

# --- 2. NVIDIA Container Toolkit (if GPU present) ---
if command -v nvidia-smi > /dev/null 2>&1; then
  if ! dpkg -s nvidia-container-toolkit > /dev/null 2>&1; then
    info "Installing NVIDIA Container Toolkit..."
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null
    sudo apt-get update -qq > /dev/null 2>&1
    sudo apt-get install -y -qq nvidia-container-toolkit > /dev/null 2>&1
    sudo nvidia-ctk runtime configure --runtime=docker > /dev/null 2>&1
    sudo systemctl restart docker
    info "NVIDIA Container Toolkit installed"
  else
    info "NVIDIA Container Toolkit already installed"
  fi
fi

# --- 3. openshell CLI (binary release, not pip) ---
if ! command -v openshell > /dev/null 2>&1; then
  info "Installing openshell CLI from GitHub release..."
  if ! command -v gh > /dev/null 2>&1; then
    sudo apt-get update -qq > /dev/null 2>&1
    sudo apt-get install -y -qq gh > /dev/null 2>&1
  fi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
    aarch64|arm64) ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
    *) fail "Unsupported architecture: $ARCH" ;;
  esac
  tmpdir="$(mktemp -d)"
  GH_TOKEN="${GITHUB_TOKEN:-}" gh release download --repo NVIDIA/OpenShell \
    --pattern "$ASSET" --dir "$tmpdir"
  tar xzf "$tmpdir/$ASSET" -C "$tmpdir"
  sudo install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
  rm -rf "$tmpdir"
  info "openshell $(openshell --version) installed"
else
  info "openshell already installed: $(openshell --version)"
fi

# --- 3b. cloudflared (for public tunnel) ---
if ! command -v cloudflared > /dev/null 2>&1; then
  info "Installing cloudflared..."
  CF_ARCH="$(uname -m)"
  case "$CF_ARCH" in
    x86_64|amd64) CF_ARCH="amd64" ;;
    aarch64|arm64) CF_ARCH="arm64" ;;
    *) fail "Unsupported architecture for cloudflared: $CF_ARCH" ;;
  esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o /tmp/cloudflared
  sudo install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared
  rm -f /tmp/cloudflared
  info "cloudflared $(cloudflared --version 2>&1 | head -1) installed"
else
  info "cloudflared already installed"
fi

# --- 4. vLLM (local inference, if GPU present) ---
VLLM_MODEL="nvidia/nemotron-3-nano-30b-a3b"
if command -v nvidia-smi > /dev/null 2>&1; then
  if ! python3 -c "import vllm" 2>/dev/null; then
    info "Installing vLLM..."
    if ! command -v pip3 > /dev/null 2>&1; then
      sudo apt-get install -y -qq python3-pip > /dev/null 2>&1
    fi
    pip3 install --break-system-packages vllm 2>/dev/null || pip3 install vllm
    info "vLLM installed"
  else
    info "vLLM already installed"
  fi

  # Start vLLM if not already running
  if curl -s http://localhost:8000/v1/models > /dev/null 2>&1; then
    info "vLLM already running on :8000"
  elif python3 -c "import vllm" 2>/dev/null; then
    info "Starting vLLM with $VLLM_MODEL..."
    nohup python3 -m vllm.entrypoints.openai.api_server \
      --model "$VLLM_MODEL" \
      --port 8000 \
      --host 0.0.0.0 \
      > /tmp/vllm-server.log 2>&1 &
    VLLM_PID=$!
    info "Waiting for vLLM to load model (this can take a few minutes)..."
    for i in $(seq 1 120); do
      if curl -s http://localhost:8000/v1/models > /dev/null 2>&1; then
        info "vLLM ready (PID $VLLM_PID)"
        break
      fi
      if ! kill -0 "$VLLM_PID" 2>/dev/null; then
        warn "vLLM exited. Check /tmp/vllm-server.log"
        break
      fi
      sleep 2
    done
  fi
fi

# --- 5. Run setup.sh ---
# Use sg docker to ensure docker group is active (usermod -aG doesn't
# take effect in the current session without re-login)
info "Running setup.sh..."
export NVIDIA_API_KEY
exec sg docker -c "bash $SCRIPT_DIR/setup.sh"
