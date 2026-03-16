#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw curl-pipe-bash installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/install.sh | bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[install]${NC} $1"; }
warn()  { echo -e "${YELLOW}[install]${NC} $1"; }
fail()  { echo -e "${RED}[install]${NC} $1"; exit 1; }

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_LABEL="macOS" ;;
  Linux)  OS_LABEL="Linux" ;;
  *)      fail "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH_LABEL="x86_64" ;;
  aarch64|arm64) ARCH_LABEL="aarch64" ;;
  *)             fail "Unsupported architecture: $ARCH" ;;
esac

COLIMA_PROFILE="${COLIMA_PROFILE:-default}"

info "Detected $OS_LABEL ($ARCH_LABEL)"
if [ "$OS" = "Darwin" ]; then
  info "Colima profile: $COLIMA_PROFILE"
fi

# ── Detect Node.js version manager ──────────────────────────────

NODE_MGR="none"
NEED_RESHIM=false

if command -v asdf > /dev/null 2>&1 && asdf plugin list 2>/dev/null | grep -q nodejs; then
  NODE_MGR="asdf"
elif [ -n "${NVM_DIR:-}" ] && [ -s "${NVM_DIR}/nvm.sh" ]; then
  NODE_MGR="nvm"
elif command -v fnm > /dev/null 2>&1; then
  NODE_MGR="fnm"
elif command -v brew > /dev/null 2>&1 && [ "$OS" = "Darwin" ]; then
  NODE_MGR="brew"
elif [ "$OS" = "Linux" ]; then
  NODE_MGR="nodesource"
fi

info "Node.js manager: $NODE_MGR"

# ── Install Node.js 22 if needed ────────────────────────────────

install_node() {
  local current_major=""
  if command -v node > /dev/null 2>&1; then
    current_major="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  fi

  if [ "$current_major" = "22" ]; then
    info "Node.js 22 already installed: $(node -v)"
    return 0
  fi

  info "Installing Node.js 22..."

  case "$NODE_MGR" in
    asdf)
      local latest_22
      latest_22="$(asdf list all nodejs 2>/dev/null | grep '^22\.' | tail -1)"
      [ -n "$latest_22" ] || fail "Could not find Node.js 22 in asdf"
      asdf install nodejs "$latest_22"
      asdf global nodejs "$latest_22"
      NEED_RESHIM=true
      ;;
    nvm)
      # shellcheck source=/dev/null
      . "${NVM_DIR}/nvm.sh"
      nvm install 22
      nvm use 22
      nvm alias default 22
      ;;
    fnm)
      fnm install 22
      fnm use 22
      fnm default 22
      ;;
    brew)
      brew install node@22
      brew link --overwrite node@22 2>/dev/null || true
      ;;
    nodesource)
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - > /dev/null 2>&1
      sudo apt-get install -y -qq nodejs > /dev/null 2>&1
      ;;
    none)
      fail "No Node.js version manager found. Install Node.js 22 manually, then re-run."
      ;;
  esac

  info "Node.js $(node -v) installed"
}

install_node

# ── Install Docker ───────────────────────────────────────────────

install_docker() {
  if command -v docker > /dev/null 2>&1 && docker info > /dev/null 2>&1; then
    info "Docker already running"
    return 0
  fi

  if command -v docker > /dev/null 2>&1; then
    # Docker installed but not running
    if [ "$OS" = "Darwin" ]; then
      if command -v colima > /dev/null 2>&1; then
        info "Starting Colima profile '$COLIMA_PROFILE'..."
        if ! colima start --profile "$COLIMA_PROFILE"; then
          fail "Failed to start Colima profile '$COLIMA_PROFILE'. If your default profile is busy or unhealthy, try: export COLIMA_PROFILE=nemoclaw"
        fi
        return 0
      fi
    fi
    fail "Docker is installed but not running. Please start Docker and re-run."
  fi

  info "Installing Docker..."

  case "$OS" in
    Darwin)
      if ! command -v brew > /dev/null 2>&1; then
        fail "Homebrew required to install Docker on macOS. Install from https://brew.sh"
      fi
      info "Installing Colima + Docker CLI via Homebrew..."
      brew install colima docker
      info "Starting Colima profile '$COLIMA_PROFILE'..."
      if ! colima start --profile "$COLIMA_PROFILE"; then
        fail "Failed to start Colima profile '$COLIMA_PROFILE'. If your default profile is busy or unhealthy, try: export COLIMA_PROFILE=nemoclaw"
      fi
      ;;
    Linux)
      sudo apt-get update -qq > /dev/null 2>&1
      sudo apt-get install -y -qq docker.io > /dev/null 2>&1
      sudo usermod -aG docker "$(whoami)"
      info "Docker installed. You may need to log out and back in for group changes."
      ;;
  esac

  if ! docker info > /dev/null 2>&1; then
    fail "Docker installed but not running. Start Docker and re-run."
  fi

  info "Docker is running"
}

install_docker

# ── Install OpenShell CLI binary ─────────────────────────────────

install_openshell() {
  if command -v openshell > /dev/null 2>&1; then
    info "openshell already installed: $(openshell --version 2>&1 || echo 'unknown')"
    return 0
  fi

  info "Installing openshell CLI..."

  case "$OS" in
    Darwin)
      case "$ARCH_LABEL" in
        x86_64)  ASSET="openshell-x86_64-apple-darwin.tar.gz" ;;
        aarch64) ASSET="openshell-aarch64-apple-darwin.tar.gz" ;;
      esac
      ;;
    Linux)
      case "$ARCH_LABEL" in
        x86_64)  ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
        aarch64) ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
      esac
      ;;
  esac

  tmpdir="$(mktemp -d)"
  if command -v gh > /dev/null 2>&1; then
    GH_TOKEN="${GITHUB_TOKEN:-}" gh release download --repo NVIDIA/OpenShell \
      --pattern "$ASSET" --dir "$tmpdir"
  else
    # Fallback: curl latest release
    curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/$ASSET" \
      -o "$tmpdir/$ASSET"
  fi

  tar xzf "$tmpdir/$ASSET" -C "$tmpdir"

  local install_dir="/usr/local/bin"
  if [ "$OS" = "Darwin" ] && command -v brew > /dev/null 2>&1; then
    install_dir="$(brew --prefix)/bin"
  fi

  mkdir -p "$install_dir"
  if [ -w "$install_dir" ]; then
    install -m 755 "$tmpdir/openshell" "$install_dir/openshell"
  else
    sudo install -m 755 "$tmpdir/openshell" "$install_dir/openshell"
  fi

  rm -rf "$tmpdir"
  info "openshell $(openshell --version 2>&1 || echo '') installed"
}

install_openshell

# ── Install NemoClaw CLI ─────────────────────────────────────────

info "Installing nemoclaw CLI from GitHub..."
npm install -g github:NVIDIA/NemoClaw

if [ "$NEED_RESHIM" = true ]; then
  info "Reshimming asdf..."
  asdf reshim nodejs
fi

# ── Verify ───────────────────────────────────────────────────────

if ! command -v nemoclaw > /dev/null 2>&1; then
  fail "nemoclaw not found in PATH after install. Check your Node.js bin directory."
fi

echo ""
info "Installation complete!"
info "nemoclaw $(nemoclaw --version 2>/dev/null || echo 'v0.1.0') is ready."
echo ""
echo "  Run \`nemoclaw onboard\` to get started"
echo ""
