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

# Minimum version required for the released Docker-driver gateway/sandbox
# binaries and the GPU filesystem policy fixes NemoClaw depends on.
MIN_VERSION="0.0.37"
# Maximum version validated for this NemoClaw release. Newer OpenShell builds
# may change sandbox semantics; upgrade NemoClaw before upgrading past this.
MAX_VERSION="0.0.37"
# Pin fresh installs to this version instead of pulling "latest".
PIN_VERSION="$MAX_VERSION"
DEV_MIN_VERSION="0.0.37"

CHANNEL="${NEMOCLAW_OPENSHELL_CHANNEL:-auto}"
case "$CHANNEL" in
  stable | dev | auto) ;;
  *) fail "NEMOCLAW_OPENSHELL_CHANNEL must be one of: stable, dev, auto" ;;
esac

if [ "$CHANNEL" = "auto" ]; then
  RESOLVED_CHANNEL="stable"
else
  RESOLVED_CHANNEL="$CHANNEL"
fi

if [ "$RESOLVED_CHANNEL" = "dev" ]; then
  RELEASE_TAG="dev"
else
  RELEASE_TAG="v${PIN_VERSION}"
fi

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

linux_driver_bins_present() {
  if [ "$OS" != "Linux" ]; then
    return 0
  fi
  command -v openshell-gateway >/dev/null 2>&1 && command -v openshell-sandbox >/dev/null 2>&1
}

if command -v openshell >/dev/null 2>&1; then
  INSTALLED_VERSION_OUTPUT="$(openshell --version 2>&1 || true)"
  INSTALLED_VERSION="$(printf '%s\n' "$INSTALLED_VERSION_OUTPUT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  [ -n "$INSTALLED_VERSION" ] || INSTALLED_VERSION="0.0.0"
  if [ "$RESOLVED_CHANNEL" = "dev" ]; then
    if version_gte "$INSTALLED_VERSION" "$DEV_MIN_VERSION" && printf '%s\n' "$INSTALLED_VERSION_OUTPUT" | grep -qi 'dev'; then
      info "openshell already installed: $INSTALLED_VERSION_OUTPUT (dev channel)"
      exit 0
    fi
    warn "openshell $INSTALLED_VERSION is not the required dev-channel Docker-driver build — upgrading..."
  else
    if version_gte "$INSTALLED_VERSION" "$MIN_VERSION"; then
      if ! version_gte "$MAX_VERSION" "$INSTALLED_VERSION"; then
        fail "openshell $INSTALLED_VERSION is above the maximum ($MAX_VERSION) supported by this NemoClaw release. Upgrade NemoClaw first."
      fi
      if ! linux_driver_bins_present; then
        warn "openshell $INSTALLED_VERSION is missing Docker-driver binaries — reinstalling pinned OpenShell ${PIN_VERSION}..."
      else
        info "openshell already installed: $INSTALLED_VERSION (>= $MIN_VERSION, <= $MAX_VERSION)"
        exit 0
      fi
    else
      warn "openshell $INSTALLED_VERSION is below minimum $MIN_VERSION — upgrading..."
    fi
  fi
fi

info "Installing OpenShell from release '$RELEASE_TAG'..."

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

declare -a ASSETS=("$ASSET")
declare -a CHECKSUM_FILES=("openshell-checksums-sha256.txt")
if [ "$OS" = "Linux" ]; then
  case "$ARCH_LABEL" in
    x86_64)
      ASSETS+=("openshell-gateway-x86_64-unknown-linux-gnu.tar.gz")
      ASSETS+=("openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz")
      ;;
    aarch64)
      ASSETS+=("openshell-gateway-aarch64-unknown-linux-gnu.tar.gz")
      ASSETS+=("openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz")
      ;;
  esac
  CHECKSUM_FILES+=("openshell-gateway-checksums-sha256.txt")
  CHECKSUM_FILES+=("openshell-sandbox-checksums-sha256.txt")
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

download_with_curl() {
  local name
  for name in "${ASSETS[@]}" "${CHECKSUM_FILES[@]}"; do
    curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/download/${RELEASE_TAG}/$name" \
      -o "$tmpdir/$name"
  done
}

if command -v gh >/dev/null 2>&1; then
  gh_ok=1
  for name in "${ASSETS[@]}" "${CHECKSUM_FILES[@]}"; do
    if ! GH_PROMPT_DISABLED=1 GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" gh release download "$RELEASE_TAG" --repo NVIDIA/OpenShell \
      --pattern "$name" --dir "$tmpdir" --clobber 2>/dev/null; then
      gh_ok=0
      break
    fi
  done
  if [ "$gh_ok" = "1" ]; then
    : # gh succeeded
  else
    warn "gh CLI download failed (auth may not be configured) — falling back to curl"
    rm -f "$tmpdir"/*
    download_with_curl
  fi
else
  download_with_curl
fi

info "Verifying SHA-256 checksum..."
for i in "${!ASSETS[@]}"; do
  asset_name="${ASSETS[$i]}"
  checksum_file="${CHECKSUM_FILES[$i]}"
  (cd "$tmpdir" && grep -F "$asset_name" "$checksum_file" | shasum -a 256 -c -) \
    || fail "SHA-256 checksum verification failed for $asset_name"
done

for asset_name in "${ASSETS[@]}"; do
  tar xzf "$tmpdir/$asset_name" -C "$tmpdir"
done

target_dir="/usr/local/bin"

install_bins() {
  local dir="$1"
  install -m 755 "$tmpdir/openshell" "$dir/openshell"
  if [ -x "$tmpdir/openshell-gateway" ]; then
    install -m 755 "$tmpdir/openshell-gateway" "$dir/openshell-gateway"
  fi
  if [ -x "$tmpdir/openshell-sandbox" ]; then
    install -m 755 "$tmpdir/openshell-sandbox" "$dir/openshell-sandbox"
  fi
}

if [ -w "$target_dir" ]; then
  install_bins "$target_dir"
elif [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || [ ! -t 0 ]; then
  target_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  mkdir -p "$target_dir"
  install_bins "$target_dir"
  warn "Installed openshell to $target_dir/openshell (user-local path)"
  warn "For future shells, run: export PATH=\"$target_dir:\$PATH\""
  warn "Add that export to your shell profile, or open a new shell before using openshell directly."
else
  sudo install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
  if [ -x "$tmpdir/openshell-gateway" ]; then
    sudo install -m 755 "$tmpdir/openshell-gateway" "$target_dir/openshell-gateway"
  fi
  if [ -x "$tmpdir/openshell-sandbox" ]; then
    sudo install -m 755 "$tmpdir/openshell-sandbox" "$target_dir/openshell-sandbox"
  fi
fi

info "$("$target_dir/openshell" --version 2>&1 || echo openshell) installed"
