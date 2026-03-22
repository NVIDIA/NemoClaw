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
OPENSHELL_VERSION="v0.0.8"
if ! command -v openshell > /dev/null 2>&1; then
  info "Installing openshell CLI (${OPENSHELL_VERSION})..."
  if ! command -v gh > /dev/null 2>&1; then
    sudo apt-get update -qq > /dev/null 2>&1
    sudo apt-get install -y -qq gh > /dev/null 2>&1
  fi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64)
      ASSET="openshell-x86_64-unknown-linux-musl.tar.gz"
      EXPECTED_SHA="203a4732b8a8974c4f612132ea0325f2a1b298dff0fe639dc8f9aff4f26f8cc3"
      ;;
    aarch64|arm64)
      ASSET="openshell-aarch64-unknown-linux-musl.tar.gz"
      EXPECTED_SHA="e5efa57bf80bbc8fce4d47cc7f7fc7ccaaa65d57e9cca8094e1cd72c0a7ff72e"
      ;;
    *) fail "Unsupported architecture: $ARCH" ;;
  esac
  tmpdir="$(mktemp -d)"
  GH_TOKEN="${GITHUB_TOKEN:-}" gh release download "$OPENSHELL_VERSION" --repo NVIDIA/OpenShell \
    --pattern "$ASSET" --dir "$tmpdir"

  # Verify checksum
  if command -v sha256sum > /dev/null 2>&1; then
    echo "${EXPECTED_SHA}  $tmpdir/$ASSET" | sha256sum -c -
  elif command -v shasum > /dev/null 2>&1; then
    echo "${EXPECTED_SHA}  $tmpdir/$ASSET" | shasum -a 256 -c -
  else
    fail "sha256sum or shasum not found. Cannot verify binary integrity."
  fi

  tar xzf "$tmpdir/$ASSET" -C "$tmpdir"
  sudo install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
  rm -rf "$tmpdir"
  info "openshell $(openshell --version) installed"
else
  info "openshell already installed: $(openshell --version)"
fi

# --- 3b. cloudflared (for public tunnel) ---
CLOUDFLARED_VERSION="2025.2.0"
if ! command -v cloudflared > /dev/null 2>&1; then
  info "Installing cloudflared (${CLOUDFLARED_VERSION})..."
  CF_ARCH="$(uname -m)"
  case "$CF_ARCH" in
    x86_64|amd64)
      CF_BIN_ARCH="amd64"
      EXPECTED_SHA="cbd18c5a6dee084db7a55d761b91202e47e63ddbd18d0faff04ca96e56739b3f"
      ;;
    aarch64|arm64)
      CF_BIN_ARCH="arm64"
      EXPECTED_SHA="92b8917aeb655ef8b9e90176dd9475b40ea85ec54b21bcafbdf57d9a68b72d15"
      ;;
    *) fail "Unsupported architecture for cloudflared: $CF_ARCH" ;;
  esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${CF_BIN_ARCH}" -o /tmp/cloudflared

  # Verify checksum
  if command -v sha256sum > /dev/null 2>&1; then
    echo "${EXPECTED_SHA}  /tmp/cloudflared" | sha256sum -c -
  elif command -v shasum > /dev/null 2>&1; then
    echo "${EXPECTED_SHA}  /tmp/cloudflared" | shasum -a 256 -c -
  else
    fail "sha256sum or shasum not found. Cannot verify binary integrity."
  fi

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
