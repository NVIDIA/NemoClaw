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

# Minimum version required for cgroup v2 fix (NVIDIA/OpenShell#329)
MIN_VERSION="0.0.7"

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

case "$OS/$ARCH" in
  Darwin/x86_64|Darwin/amd64)   ASSET="openshell-x86_64-apple-darwin.tar.gz" ;;
  Darwin/aarch64|Darwin/arm64)  ASSET="openshell-aarch64-apple-darwin.tar.gz" ;;
  Linux/x86_64|Linux/amd64)     ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
  Linux/aarch64|Linux/arm64)    ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
  *) fail "Unsupported platform: $OS/$ARCH" ;;
esac

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# Download
if command -v gh >/dev/null 2>&1; then
  GH_TOKEN="${GITHUB_TOKEN:-}" gh release download --repo NVIDIA/OpenShell \
    --pattern "$ASSET" --dir "$tmpdir"
else
  if ! curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/$ASSET" \
    -o "$tmpdir/$ASSET" 2>"$tmpdir/curl.err"; then
    cat "$tmpdir/curl.err" >&2
    fail "Could not download $ASSET"
  fi
fi

# Validate the downloaded file is actually a gzip tarball
if command -v file >/dev/null 2>&1; then
  if ! file "$tmpdir/$ASSET" 2>/dev/null | grep -q "gzip compressed data"; then
    fail "Downloaded file is not a valid gzip tarball. GitHub may be unavailable or the release may be missing."
  fi
fi

# Verify checksum if available (fail-closed)
CHECKSUM_URL="https://github.com/NVIDIA/OpenShell/releases/latest/download/SHA256SUMS"
if curl -fsSL "$CHECKSUM_URL" -o "$tmpdir/SHA256SUMS" 2>/dev/null; then
  if ! grep -qF "$ASSET" "$tmpdir/SHA256SUMS"; then
    fail "Checksum entry not found for $ASSET in SHA256SUMS"
  fi
  if ! (cd "$tmpdir" && grep -F "$ASSET" SHA256SUMS | shasum -a 256 -c -s); then
    fail "Checksum verification failed for $ASSET. File may be corrupted or tampered with."
  fi
  info "Checksum verified"
else
  fail "No checksum file available; refusing unverified install"
fi

# Extract tarball
if ! tar xzf "$tmpdir/$ASSET" -C "$tmpdir" 2>"$tmpdir/tar.err"; then
  cat "$tmpdir/tar.err" >&2
  fail "Could not extract $ASSET"
fi

# Verify the binary was extracted and is executable
if [ ! -f "$tmpdir/openshell" ]; then
  fail "Extracted tarball but openshell binary not found"
fi
if command -v file >/dev/null 2>&1; then
  if ! file "$tmpdir/openshell" | grep -qE "executable|Mach-O|ELF"; then
    fail "Extracted file is not a valid executable"
  fi
fi

# Install
target_dir="/usr/local/bin"

if [ -w "$target_dir" ]; then
  install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
elif [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || [ ! -t 0 ]; then
  target_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  mkdir -p "$target_dir"
  install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
  warn "Installed openshell to $target_dir/openshell (user-local path)"
  warn "For future shells, run: export PATH=\"$target_dir:\$PATH\""
else
  sudo install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
fi

info "$("$target_dir/openshell" --version 2>&1 || echo openshell) installed"
