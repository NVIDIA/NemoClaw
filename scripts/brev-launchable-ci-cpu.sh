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
#   5. Docker images pre-pulled (sandbox-base, openshell/cluster, node:22-slim)
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
#   OPENSHELL_VERSION     — OpenShell CLI release tag (default: v0.0.29)
#   NEMOCLAW_REF          — NemoClaw git ref to clone (default: main)
#   NEMOCLAW_CLONE_DIR    — Where to clone NemoClaw (default: ~/NemoClaw)
#   SKIP_DOCKER_PULL      — Set to 1 to skip Docker image pre-pulls
#
# Related:
#   - Epic: https://github.com/NVIDIA/NemoClaw/issues/1326
#   - Issue: https://github.com/NVIDIA/NemoClaw/issues/1327

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────
OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.29}"
NEMOCLAW_REF="${NEMOCLAW_REF:-main}"
TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
NEMOCLAW_CLONE_DIR="${NEMOCLAW_CLONE_DIR:-${TARGET_HOME}/NemoClaw}"

LAUNCH_LOG="${LAUNCH_LOG:-/tmp/launch-plugin.log}"
SENTINEL="/var/run/nemoclaw-launchable-ready"

# Docker images to pre-pull. These are the expensive layers that cause
# timeouts when pulled during CI runs.
DOCKER_IMAGES=(
  "ghcr.io/nvidia/nemoclaw/sandbox-base:latest"
  "node:22-slim"
)

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

# ══════════════════════════════════════════════════════════════════════
# 1. System packages
# ══════════════════════════════════════════════════════════════════════
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
# Make the socket world-accessible so SSH sessions (which don't pick up the
# new docker group until re-login) can use Docker immediately.  This is a
# short-lived CI VM — socket security is not a concern.
sudo chmod 666 /var/run/docker.sock
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
    warn "No SHA-256 tool found — skipping NodeSource integrity check"
    actual_hash="$NODESOURCE_SHA256"
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
  _pinned_ver="${OPENSHELL_VERSION#v}" # strip leading 'v'
  if [ "$_installed_ver" = "$_pinned_ver" ]; then
    info "OpenShell CLI already installed at pinned version: $_installed_ver"
  else
    info "OpenShell CLI $_installed_ver does not match pinned ${_pinned_ver} — reinstalling..."
    ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64 | amd64) ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
      aarch64 | arm64) ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
      *) fail "Unsupported architecture: $ARCH" ;;
    esac
    tmpdir="$(mktemp -d)"
    retry 3 10 "download openshell" \
      curl -fsSL -o "$tmpdir/$ASSET" \
      "https://github.com/NVIDIA/OpenShell/releases/download/${OPENSHELL_VERSION}/${ASSET}"
    tar xzf "$tmpdir/$ASSET" -C "$tmpdir"
    sudo install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
    rm -rf "$tmpdir"
    info "OpenShell CLI upgraded: $(openshell --version 2>&1 || echo unknown)"
  fi
else
  info "Installing OpenShell CLI ${OPENSHELL_VERSION}..."
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64 | amd64) ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
    aarch64 | arm64) ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
    *) fail "Unsupported architecture: $ARCH" ;;
  esac
  tmpdir="$(mktemp -d)"
  retry 3 10 "download openshell" \
    curl -fsSL -o "$tmpdir/$ASSET" \
    "https://github.com/NVIDIA/OpenShell/releases/download/${OPENSHELL_VERSION}/${ASSET}"
  tar xzf "$tmpdir/$ASSET" -C "$tmpdir"
  sudo install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
  rm -rf "$tmpdir"
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
npm install 2>&1 | tail -3
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
# 6. Pre-pull Docker images
# ══════════════════════════════════════════════════════════════════════
if [[ "${SKIP_DOCKER_PULL:-0}" == "1" ]]; then
  info "Skipping Docker image pre-pulls (SKIP_DOCKER_PULL=1)"
else
  info "Pre-pulling Docker images (this saves 3-5 min per CI run)..."

  # Use sg docker to ensure docker group is active without re-login
  for image in "${DOCKER_IMAGES[@]}"; do
    info "  Pulling $image..."
    sg docker -c "docker pull $image" 2>&1 | tail -1 \
      || warn "  Failed to pull $image (will be pulled at test time)"
  done

  # The openshell/cluster image tag should match the CLI version.
  # Try the pinned version first, fall back to latest.
  CLUSTER_TAG="${OPENSHELL_VERSION#v}" # v0.0.20 → 0.0.20
  CLUSTER_IMAGE="ghcr.io/nvidia/openshell/cluster:${CLUSTER_TAG}"
  info "  Pulling $CLUSTER_IMAGE..."
  if ! sg docker -c "docker pull $CLUSTER_IMAGE" 2>&1 | tail -1; then
    warn "  Could not pull $CLUSTER_IMAGE — trying :latest"
    sg docker -c "docker pull ghcr.io/nvidia/openshell/cluster:latest" 2>&1 | tail -1 \
      || warn "  Failed to pull openshell/cluster (will be pulled at test time)"
  fi

  info "Docker images pre-pulled"
fi

# ══════════════════════════════════════════════════════════════════════
# 7. Readiness sentinel
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
