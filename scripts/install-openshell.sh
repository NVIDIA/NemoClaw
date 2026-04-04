#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[install]${NC} $1"; }
warn() { echo -e "${YELLOW}[install]${NC} $1"; }
fail() {
  echo -e "${RED}[install]${NC} $1"
  exit 1
}

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_LABEL="macOS" ;;
  Linux) OS_LABEL="Linux" ;;
  *) fail "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  x86_64 | amd64) ARCH_LABEL="x86_64" ;;
  aarch64 | arm64) ARCH_LABEL="aarch64" ;;
  *) fail "Unsupported architecture: $ARCH" ;;
esac

info "Detected $OS_LABEL ($ARCH_LABEL)"

# Minimum version required for sandbox persistence across gateway restarts
# (deterministic k3s node name + workspace PVC: NVIDIA/OpenShell#739, #488)
MIN_VERSION="0.0.22"

version_gte() {
  # Returns 0 (true) if $1 >= $2 — portable, no sort -V (BSD compat)
  local IFS=.
  local -a a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  for i in 0 1 2; do
    local ai=${a[$i]:-0} bi=${b[$i]:-0}
    if ((ai > bi)); then return 0; fi
    if ((ai < bi)); then return 1; fi
  done
  return 0
}

if command -v openshell >/dev/null 2>&1; then
  INSTALLED_VERSION="$(openshell --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo '0.0.0')"
  if version_gte "$INSTALLED_VERSION" "$MIN_VERSION"; then
    info "openshell already installed: $INSTALLED_VERSION (>= $MIN_VERSION)"
    exit 0
  fi
  warn "openshell $INSTALLED_VERSION is below minimum $MIN_VERSION — upgrading..."
fi

info "Installing openshell CLI..."

case "$OS" in
  Darwin)
    case "$ARCH_LABEL" in
      x86_64) ASSET="openshell-x86_64-apple-darwin.tar.gz" ;;
      aarch64) ASSET="openshell-aarch64-apple-darwin.tar.gz" ;;
    esac
    ;;
  Linux)
    case "$ARCH_LABEL" in
      x86_64) ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
      aarch64) ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
    esac
    ;;
esac

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

CHECKSUM_FILE="openshell-checksums-sha256.txt"
download_with_curl() {
  curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/$ASSET" \
    -o "$tmpdir/$ASSET"
  curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/$CHECKSUM_FILE" \
    -o "$tmpdir/$CHECKSUM_FILE"
}

if command -v gh >/dev/null 2>&1; then
  if GH_PROMPT_DISABLED=1 GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" gh release download --repo NVIDIA/OpenShell \
    --pattern "$ASSET" --dir "$tmpdir" 2>/dev/null \
    && GH_PROMPT_DISABLED=1 GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" gh release download --repo NVIDIA/OpenShell \
      --pattern "$CHECKSUM_FILE" --dir "$tmpdir" 2>/dev/null; then
    : # gh succeeded
  else
    warn "gh CLI download failed (auth may not be configured) — falling back to curl"
    rm -f "$tmpdir/$ASSET" "$tmpdir/$CHECKSUM_FILE"
    download_with_curl
  fi
else
  download_with_curl
fi

info "Verifying SHA-256 checksum..."
(cd "$tmpdir" && grep -F "$ASSET" "$CHECKSUM_FILE" | shasum -a 256 -c -) \
  || fail "SHA-256 checksum verification failed for $ASSET"

tar xzf "$tmpdir/$ASSET" -C "$tmpdir"

target_dir="/usr/local/bin"

if [ -w "$target_dir" ]; then
  install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
elif [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || [ ! -t 0 ]; then
  target_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  mkdir -p "$target_dir"
  install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
  warn "Installed openshell to $target_dir/openshell (user-local path)"
  warn "For future shells, run: export PATH=\"$target_dir:\$PATH\""
  warn "Add that export to your shell profile, or open a new shell before using openshell directly."
else
  sudo install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
fi

info "$("$target_dir/openshell" --version 2>&1 || echo openshell) installed"
