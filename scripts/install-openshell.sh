#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

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

info "Detected $OS_LABEL ($ARCH_LABEL)"

if command -v openshell > /dev/null 2>&1; then
  info "openshell already installed: $(openshell --version 2>&1 || echo 'unknown')"
  exit 0
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
trap 'rm -rf "$tmpdir"' EXIT

if command -v gh > /dev/null 2>&1; then
  GH_TOKEN="${GITHUB_TOKEN:-}" gh release download --repo NVIDIA/OpenShell \
    --pattern "$ASSET" --dir "$tmpdir"
else
  curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/$ASSET" \
    -o "$tmpdir/$ASSET"
fi

tar xzf "$tmpdir/$ASSET" -C "$tmpdir"

target_dir="/usr/local/bin"

if [ -w "$target_dir" ]; then
  install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
elif [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || [ ! -t 0 ]; then
  target_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  mkdir -p "$target_dir"
  install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
  warn "Installed openshell to $target_dir/openshell (user-local path)"
  warn "Ensure $target_dir is on PATH for future shells."
else
  sudo install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
fi

info "$("$target_dir/openshell" --version 2>&1 || echo openshell) installed"
