#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Brev launchable startup script — CI-Ready CPU
#
# Pre-bakes a VM with everything needed for NemoClaw E2E tests so that
# CI runs only need to: rsync branch code → npm ci → nemoclaw onboard → test.
#
# What this installs:
#   1. Docker (docker.io) — enabled and running
#   2. Node.js 22 (nodesource)
#   3. OpenShell CLI binary (pinned release)
#   4. NemoClaw repo cloned with npm deps installed and TS plugin built
#
# What this does NOT install (intentionally):
#   - code-server (not needed for automated CI)
#   - VS Code themes/extensions
#   - NVIDIA Container Toolkit (see brev-launchable-ci-gpu.sh for GPU flavor)
#   - Ollama / vLLM
#
# Readiness detection:
#   Writes /var/run/nemoclaw-launchable-ready when complete.
#   Also writes "=== Ready ===" to /tmp/launch-plugin.log for backward compat.
#
# Usage (Brev launchable startup script — one-liner that curls this):
#   curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/<ref>/scripts/brev-launchable-ci-cpu.sh | bash
#
# Environment overrides:
#   OPENSHELL_VERSION     — OpenShell CLI release tag (default: v0.0.72)
#   NEMOCLAW_REF          — NemoClaw git ref to clone (default: main)
#   NEMOCLAW_CLONE_DIR    — Where to clone NemoClaw (default: ~/NemoClaw)
#
# Related:
#   - Epic: https://github.com/NVIDIA/NemoClaw/issues/1326
#   - Issue: https://github.com/NVIDIA/NemoClaw/issues/1327

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────
OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.72}"
NEMOCLAW_REF="${NEMOCLAW_REF:-main}"
TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
NEMOCLAW_CLONE_DIR="${NEMOCLAW_CLONE_DIR:-${TARGET_HOME}/NemoClaw}"

LAUNCH_LOG="${LAUNCH_LOG:-/tmp/launch-plugin.log}"
SENTINEL="/var/run/nemoclaw-launchable-ready"

# ── Suppress apt noise ───────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# ── Logging ──────────────────────────────────────────────────────────
mkdir -p "$(dirname "$LAUNCH_LOG")"
exec > >(tee -a "$LAUNCH_LOG") 2>&1

_ts() { date '+%H:%M:%S'; }
info() { printf '\033[0;32m[%s ci-cpu]\033[0m %s\n' "$(_ts)" "$1"; }
warn() { printf '\033[1;33m[%s ci-cpu]\033[0m %s\n' "$(_ts)" "$1"; }
fail() {
  printf '\033[0;31m[%s ci-cpu]\033[0m %s\n' "$(_ts)" "$1"
  exit 1
}

assert_openshell_version() {
  local raw="$1"
  if [[ ! "$raw" =~ ^v?[0-9]+[.][0-9]+[.][0-9]+$ ]]; then
    fail "Invalid OPENSHELL_VERSION '$raw'; expected vX.Y.Z or X.Y.Z"
  fi
}

assert_openshell_version "$OPENSHELL_VERSION"
if [[ "$OPENSHELL_VERSION" != v* ]]; then
  OPENSHELL_VERSION="v${OPENSHELL_VERSION}"
fi
OPENSHELL_VERSION_NO_V="${OPENSHELL_VERSION#v}"

# ── Retry helper ─────────────────────────────────────────────────────
# Usage: retry 3 10 "description" command arg1 arg2
retry() {
  local max_attempts="$1" sleep_sec="$2" desc="$3"
  shift 3
  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if ((attempt >= max_attempts)); then
      warn "Failed after $max_attempts attempts: $desc"
      return 1
    fi
    info "Retry $attempt/$max_attempts for: $desc (sleeping ${sleep_sec}s)"
    sleep "$sleep_sec"
    ((attempt++))
  done
}

# ── Wait for apt locks ───────────────────────────────────────────────
# Brev VMs sometimes have unattended-upgrades running at boot.
wait_for_apt_lock() {
  local max_wait=120 elapsed=0
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
    || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
    if ((elapsed >= max_wait)); then
      warn "apt lock not released after ${max_wait}s — proceeding anyway"
      return 0
    fi
    if ((elapsed % 15 == 0)); then
      info "Waiting for apt lock to be released... (${elapsed}s)"
    fi
    sleep 5
    ((elapsed += 5))
  done
}

openshell_cli_asset_for_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) printf '%s\n' "openshell-x86_64-unknown-linux-musl.tar.gz" ;;
    aarch64 | arm64) printf '%s\n' "openshell-aarch64-unknown-linux-musl.tar.gz" ;;
    *) fail "Unsupported architecture: $arch" ;;
  esac
}

openshell_cli_pinned_sha256() {
  local release_tag="$1" asset="$2"
  case "${release_tag}:${asset}" in
    v0.0.72:openshell-x86_64-unknown-linux-musl.tar.gz)
      printf '%s\n' "37836c3b50383e03249c5e16512c1806e591fba8451408a84fb2f628ddb318c4"
      ;;
    v0.0.72:openshell-aarch64-unknown-linux-musl.tar.gz)
      printf '%s\n' "a5ff01a3240d73c72ec1700eda6cc6c752a86cf50c5dd1b5bdc459f544d03045"
      ;;
    *)
      return 1
      ;;
  esac
}

openshell_checksum_line() {
  local checksum_file="$1" asset="$2"
  awk -v asset="$asset" '$2 == asset { print; found=1; exit } END { if (!found) exit 1 }' "$checksum_file"
}

verify_openshell_cli_asset() {
  local tmpdir="$1" asset="$2" checksum_file="openshell-checksums-sha256.txt"
  local checksum_line expected_sha release_sha
  local -a sha_cmd
  if command -v sha256sum >/dev/null 2>&1; then
    sha_cmd=(sha256sum)
  elif command -v shasum >/dev/null 2>&1; then
    sha_cmd=(shasum -a 256)
  else
    fail "No SHA-256 tool available (sha256sum/shasum)"
  fi

  retry 3 10 "download openshell checksum" \
    curl -fsSL -o "$tmpdir/$checksum_file" \
    "https://github.com/NVIDIA/OpenShell/releases/download/${OPENSHELL_VERSION}/${checksum_file}"
  checksum_line="$(openshell_checksum_line "$tmpdir/$checksum_file" "$asset")" \
    || fail "OpenShell checksum file does not list $asset"
  expected_sha="$(openshell_cli_pinned_sha256 "$OPENSHELL_VERSION" "$asset")" \
    || fail "No NemoClaw-pinned SHA-256 for OpenShell ${OPENSHELL_VERSION} asset ${asset}"
  release_sha="$(printf '%s\n' "$checksum_line" | awk '{print $1}')"
  [[ "$release_sha" == "$expected_sha" ]] \
    || fail "OpenShell release checksum for $asset does not match NemoClaw-pinned ${OPENSHELL_VERSION} digest"
  (cd "$tmpdir" && printf '%s\n' "$checksum_line" | "${sha_cmd[@]}" -c -) \
    || fail "OpenShell CLI checksum verification failed for $asset"
}

install_openshell_cli_release() {
  local asset tmpdir
  asset="$(openshell_cli_asset_for_arch)"
  tmpdir="$(mktemp -d)"
  retry 3 10 "download openshell" \
    curl -fsSL -o "$tmpdir/$asset" \
    "https://github.com/NVIDIA/OpenShell/releases/download/${OPENSHELL_VERSION}/${asset}"
  verify_openshell_cli_asset "$tmpdir" "$asset"
  tar xzf "$tmpdir/$asset" -C "$tmpdir"
  sudo install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
  rm -rf "$tmpdir"
}

# ══════════════════════════════════════════════════════════════════════
# 1. System packages
# ══════════════════════════════════════════════════════════════════════
# Kill unattended-upgrades immediately — it grabs the apt lock on boot
# and can block for 60-120s. Irrelevant on an ephemeral CI VM.
sudo systemctl stop unattended-upgrades 2>/dev/null || true
sudo systemctl disable unattended-upgrades 2>/dev/null || true
sudo killall -9 unattended-upgr 2>/dev/null || true

info "Installing system packages..."
wait_for_apt_lock
retry 3 10 "apt-get update" sudo apt-get update -qq
retry 3 10 "apt-get install" sudo apt-get install -y -qq \
  ca-certificates curl git jq tar >/dev/null 2>&1
info "System packages installed"

# ══════════════════════════════════════════════════════════════════════
# 2. Docker
# ══════════════════════════════════════════════════════════════════════
if command -v docker >/dev/null 2>&1; then
  info "Docker already installed"
else
  info "Installing Docker..."
  wait_for_apt_lock
  retry 3 10 "install docker" sudo apt-get install -y -qq docker.io >/dev/null 2>&1
  info "Docker installed"
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$TARGET_USER" 2>/dev/null || true
# The current bootstrap process predates the usermod above, so any Docker
# daemon command in this session must use `sg docker -c ...`. New SSH sessions
# naturally receive the docker group. Never weaken the host-root-equivalent
# Docker socket permissions to work around stale group membership.
info "Docker enabled ($(docker --version 2>/dev/null | head -c 40))"

# ══════════════════════════════════════════════════════════════════════
# 3. Node.js 22
# ══════════════════════════════════════════════════════════════════════
node_major=""
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
fi

if command -v npm >/dev/null 2>&1 && [[ -n "$node_major" ]] && ((node_major >= 22)); then
  info "Node.js already installed: $(node --version)"
else
  info "Installing Node.js 22..."
  # IMPORTANT: update NODESOURCE_SHA256 when changing setup_22.x URL
  NODESOURCE_URL="https://deb.nodesource.com/setup_22.x"
  NODESOURCE_SHA256="575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1"
  ns_tmp="$(mktemp)"
  curl -fsSL "$NODESOURCE_URL" -o "$ns_tmp" \
    || {
      rm -f "$ns_tmp"
      fail "Failed to download NodeSource installer"
    }
  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash="$(sha256sum "$ns_tmp" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash="$(shasum -a 256 "$ns_tmp" | awk '{print $1}')"
  else
    rm -f "$ns_tmp"
    fail "No SHA-256 tool available (sha256sum/shasum)"
  fi
  if [[ "$actual_hash" != "$NODESOURCE_SHA256" ]]; then
    rm -f "$ns_tmp"
    fail "NodeSource installer integrity check failed\n  Expected: $NODESOURCE_SHA256\n  Actual:   $actual_hash"
  fi
  info "NodeSource installer integrity verified"
  sudo -E bash "$ns_tmp" >/dev/null 2>&1
  rm -f "$ns_tmp"
  wait_for_apt_lock
  retry 3 10 "install nodejs" sudo apt-get install -y -qq nodejs >/dev/null 2>&1
  info "Node.js $(node --version) installed"
fi

# ══════════════════════════════════════════════════════════════════════
# 4. OpenShell CLI
# ══════════════════════════════════════════════════════════════════════
if command -v openshell >/dev/null 2>&1; then
  _installed_ver="$(openshell --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo '0.0.0')"
  _pinned_ver="$OPENSHELL_VERSION_NO_V"
  if [ "$_installed_ver" = "$_pinned_ver" ]; then
    info "OpenShell CLI already installed at pinned version: $_installed_ver"
  else
    info "OpenShell CLI $_installed_ver does not match pinned ${_pinned_ver} — reinstalling..."
    install_openshell_cli_release
    info "OpenShell CLI upgraded: $(openshell --version 2>&1 || echo unknown)"
  fi
else
  info "Installing OpenShell CLI ${OPENSHELL_VERSION}..."
  install_openshell_cli_release
  info "OpenShell CLI installed: $(openshell --version 2>&1 || echo unknown)"
fi

# ══════════════════════════════════════════════════════════════════════
# 5. Clone NemoClaw and install deps
# ══════════════════════════════════════════════════════════════════════
if [[ -d "$NEMOCLAW_CLONE_DIR/.git" ]]; then
  info "NemoClaw repo exists at $NEMOCLAW_CLONE_DIR — refreshing"
  git -C "$NEMOCLAW_CLONE_DIR" fetch origin "$NEMOCLAW_REF"
  git -C "$NEMOCLAW_CLONE_DIR" checkout "$NEMOCLAW_REF"
  git -C "$NEMOCLAW_CLONE_DIR" pull --ff-only origin "$NEMOCLAW_REF" || true
else
  info "Cloning NemoClaw (ref: $NEMOCLAW_REF)..."
  git clone --branch "$NEMOCLAW_REF" --depth 1 \
    "https://github.com/NVIDIA/NemoClaw.git" "$NEMOCLAW_CLONE_DIR"
fi

info "Installing npm dependencies..."
cd "$NEMOCLAW_CLONE_DIR"
npm install --ignore-scripts 2>&1 | tail -3
info "Root deps installed"

# --ignore-scripts above skips the `prepare` lifecycle which normally
# builds dist/ (via `build:cli`). Build it explicitly — bin/nemoclaw.js
# does `require("../dist/nemoclaw")` and needs the compiled output.
info "Building CLI (dist/)..."
npm run build:cli 2>&1 | tail -3
info "CLI built"

info "Building TypeScript plugin..."
cd "$NEMOCLAW_CLONE_DIR/nemoclaw"
npm install --ignore-scripts 2>&1 | tail -3
npm run build 2>&1 | tail -3
cd "$NEMOCLAW_CLONE_DIR"
info "Plugin built"

# Expose the nemoclaw CLI on PATH. Earlier this was `sudo npm link`, but
# on cold CPU Brev that routinely hangs inside npm's global-prefix
# housekeeping and `sudo chown -R node_modules` traversal (≥20 min in
# CI). npm link just creates two symlinks in the end; do them directly
# so setup stays deterministic and fast.
info "Linking nemoclaw CLI (direct symlink)..."
sudo ln -sf "$NEMOCLAW_CLONE_DIR/bin/nemoclaw.js" /usr/local/bin/nemoclaw
sudo chmod +x "$NEMOCLAW_CLONE_DIR/bin/nemoclaw.js"
info "nemoclaw CLI linked at /usr/local/bin/nemoclaw"

# ══════════════════════════════════════════════════════════════════════
# 6. Readiness sentinel
# ══════════════════════════════════════════════════════════════════════
sudo touch "$SENTINEL"
echo "=== Ready ===" | sudo tee -a "$LAUNCH_LOG" >/dev/null

info "════════════════════════════════════════════════════"
info "  CI-Ready CPU launchable setup complete"
info "  NemoClaw:   $NEMOCLAW_CLONE_DIR (ref: $NEMOCLAW_REF)"
info "  OpenShell:  $(openshell --version 2>&1 || echo unknown)"
info "  Node.js:    $(node --version)"
info "  Docker:     $(docker --version 2>/dev/null | head -c 40)"
info "  Sentinel:   $SENTINEL"
info "════════════════════════════════════════════════════"
