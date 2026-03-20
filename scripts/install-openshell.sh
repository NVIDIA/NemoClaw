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
      x86_64)
        # No macOS x86_64 binary is published; check if this is Rosetta on Apple Silicon
        if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
          ASSET="openshell-aarch64-apple-darwin.tar.gz"
          info "Rosetta detected on Apple Silicon; using native ARM64 binary"
        else
          fail "Unsupported platform: macOS Intel (x86_64). OpenShell requires Apple Silicon."
        fi
        ;;
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

# Verify required tools
command -v file >/dev/null 2>&1 || fail "Required command 'file' not found. Install via: brew install file (macOS) or apt-get install file (Linux)"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

if command -v gh > /dev/null 2>&1; then
  GH_TOKEN="${GITHUB_TOKEN:-}" gh release download --repo NVIDIA/OpenShell \
    --pattern "$ASSET" --dir "$tmpdir"
else
  if ! curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/$ASSET" \
    -o "$tmpdir/$ASSET" 2>"$tmpdir/curl.err"; then
    printf "Failed to download openshell from GitHub:\n" >&2
    cat "$tmpdir/curl.err" >&2
    fail "Could not download $ASSET"
  fi
fi

# Validate the downloaded file is actually a gzip tarball
if ! file "$tmpdir/$ASSET" | grep -q "gzip compressed data"; then
  fail "Downloaded file is not a valid gzip tarball. GitHub may be unavailable or the release may be missing."
fi

# Try to download and verify checksum if available
# OpenShell publishes checksums as openshell-checksums-sha256.txt
CHECKSUM_FILE=""
for _ckname in openshell-checksums-sha256.txt SHA256SUMS; do
  _ckurl="https://github.com/NVIDIA/OpenShell/releases/latest/download/$_ckname"
  if curl -fsSL "$_ckurl" -o "$tmpdir/checksums.txt" 2>/dev/null; then
    CHECKSUM_FILE="$tmpdir/checksums.txt"
    break
  fi
done

if [ -n "$CHECKSUM_FILE" ]; then
  if ! grep -qF "$ASSET" "$CHECKSUM_FILE"; then
    if [ "${NEMOCLAW_ALLOW_UNVERIFIED:-0}" = "1" ]; then
      warn "Checksum not found for $ASSET; continuing due to NEMOCLAW_ALLOW_UNVERIFIED=1"
    else
      fail "Checksum not found for $ASSET in checksum file. Set NEMOCLAW_ALLOW_UNVERIFIED=1 to bypass."
    fi
  else
    if ! (cd "$tmpdir" && grep -F "$ASSET" checksums.txt | shasum -a 256 -c -s); then
      fail "Checksum verification failed for $ASSET. File may be corrupted or tampered with."
    fi
    info "Checksum verified"
  fi
else
  if [ "${NEMOCLAW_ALLOW_UNVERIFIED:-0}" = "1" ]; then
    warn "No checksum file available; continuing due to NEMOCLAW_ALLOW_UNVERIFIED=1"
  else
    fail "No checksum file available for verification. Set NEMOCLAW_ALLOW_UNVERIFIED=1 to bypass."
  fi
fi

# Extract tarball
if ! tar xzf "$tmpdir/$ASSET" -C "$tmpdir" --no-same-owner 2>"$tmpdir/tar.err"; then
  printf "Failed to extract tarball:\n" >&2
  cat "$tmpdir/tar.err" >&2
  fail "Could not extract $ASSET"
fi

# Verify the binary was extracted
if [ ! -f "$tmpdir/openshell" ]; then
  fail "Extracted tarball but openshell binary not found"
fi

# Verify it's an executable
if ! file "$tmpdir/openshell" | grep -qE "executable|Mach-O|ELF"; then
  fail "Extracted file is not a valid executable"
fi

# Install: prefer /usr/local/bin, fall back to user-local in non-interactive mode
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
