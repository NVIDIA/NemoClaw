#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Brev launchable startup script — CI-Ready GPU
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
#   6. NVIDIA Container Toolkit (for GPU passthrough to Docker)
#   7. Ollama + specified model pre-pulled
#
# What this does NOT install (intentionally):
#   - code-server (not needed for automated CI)
#   - VS Code themes/extensions
#
# Readiness detection:
#   Writes /var/run/nemoclaw-launchable-ready when complete.
#   Also writes "=== Ready ===" to /tmp/launch-plugin.log for backward compat.
#
# Usage (Brev launchable startup script — one-liner that curls this):
#   curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/<ref>/scripts/brev-launchable-ci-gpu.sh | bash
#
# Environment overrides:
#   OPENSHELL_VERSION     — OpenShell CLI release tag (default: v0.0.20)
#   NEMOCLAW_REF          — NemoClaw git ref to clone (default: main)
#   NEMOCLAW_CLONE_DIR    — Where to clone NemoClaw (default: ~/NemoClaw)
#   SKIP_DOCKER_PULL      — Set to 1 to skip Docker image pre-pulls
#   OLLAMA_MODEL          — Which model to preload (default: qwen3:0.6b, fallback qwen2.5:0.5b)
#
# Related:
#   - Epic: https://github.com/NVIDIA/NemoClaw/issues/1326
#   - Issue: https://github.com/NVIDIA/NemoClaw/issues/1327

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────
OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.20}"
NEMOCLAW_REF="${NEMOCLAW_REF:-main}"
TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
NEMOCLAW_CLONE_DIR="${NEMOCLAW_CLONE_DIR:-${TARGET_HOME}/NemoClaw}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:0.6b}"

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
info() { printf '\033[0;32m[%s ci-gpu]\033[0m %s\n' "$(_ts)" "$1"; }
warn() { printf '\033[1;33m[%s ci-gpu]\033[0m %s\n' "$(_ts)" "$1"; }
fail() {
  printf '\033[0;31m[%s ci-gpu]\033[0m %s\n' "$(_ts)" "$1"
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
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  wait_for_apt_lock
  retry 3 10 "install nodejs" sudo apt-get install -y -qq nodejs >/dev/null 2>&1
  info "Node.js $(node --version) installed"
fi

# ══════════════════════════════════════════════════════════════════════
# 4. OpenShell CLI
# ══════════════════════════════════════════════════════════════════════
if command -v openshell >/dev/null 2>&1; then
  info "OpenShell CLI already installed: $(openshell --version 2>&1 || echo unknown)"
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

info "Building TypeScript plugin..."
cd "$NEMOCLAW_CLONE_DIR/nemoclaw"
npm install 2>&1 | tail -3
npm run build 2>&1 | tail -3
cd "$NEMOCLAW_CLONE_DIR"
info "Plugin built"

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
# 7. NVIDIA Container Toolkit
# ══════════════════════════════════════════════════════════════════════
if command -v nvidia-smi >/dev/null 2>&1; then
  if ! dpkg -s nvidia-container-toolkit >/dev/null 2>&1; then
    info "Installing NVIDIA Container Toolkit..."
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    wait_for_apt_lock
    retry 3 10 "apt-get update" sudo apt-get update -qq >/dev/null 2>&1
    retry 3 10 "install nvidia-container-toolkit" sudo apt-get install -y -qq nvidia-container-toolkit >/dev/null 2>&1
    sudo nvidia-ctk runtime configure --runtime=docker >/dev/null 2>&1
    sudo systemctl restart docker
    info "NVIDIA Container Toolkit installed"
  else
    info "NVIDIA Container Toolkit already installed"
  fi

  info "Validating GPU passthrough..."
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi || warn "GPU detected but not functioning"
    docker run --rm --gpus all nvidia/cuda:12.2.0-base nvidia-smi \
      || warn "Docker GPU passthrough failed"
  else
    warn "No GPU detected"
  fi
else
  warn "nvidia-smi not found, assuming a CPU-only instance or failed passthrough"
fi

# ══════════════════════════════════════════════════════════════════════
# 8. Ollama
# ══════════════════════════════════════════════════════════════════════
if ! command -v ollama >/dev/null 2>&1; then
  info "Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh >/dev/null 2>&1
  info "Ollama installed"
else
  info "Ollama already installed"
fi

info "Pulling Ollama model $OLLAMA_MODEL..."
if systemctl is-active --quiet ollama || pgrep -x ollama >/dev/null; then
  ollama pull "$OLLAMA_MODEL" >/dev/null 2>&1 || warn "Failed to pull $OLLAMA_MODEL (might fallback to qwen2.5:0.5b)"
  if ! ollama list | grep -q "${OLLAMA_MODEL}"; then
    # fallback if qwen3:0.6b doesn't exist yet
    if [ "$OLLAMA_MODEL" == "qwen3:0.6b" ]; then
      ollama pull "qwen2.5:0.5b" >/dev/null 2>&1 || true
    fi
  fi
else
  # Start Ollama briefly to pull model if not running
  ollama serve >/dev/null 2>&1 &
  OLLAMA_PID=$!
  info "Waiting for Ollama to start..."
  until curl -s http://localhost:11434 >/dev/null; do
    sleep 1
  done
  ollama pull "$OLLAMA_MODEL" >/dev/null 2>&1 || warn "Failed to pull $OLLAMA_MODEL (might fallback to qwen2.5:0.5b)"
  if ! ollama list | grep -q "${OLLAMA_MODEL}"; then
    if [ "$OLLAMA_MODEL" == "qwen3:0.6b" ]; then
      ollama pull "qwen2.5:0.5b" >/dev/null 2>&1 || true
    fi
  fi
  kill $OLLAMA_PID 2>/dev/null || true
fi
info "Ollama model pulling script complete."

# ══════════════════════════════════════════════════════════════════════
# 9. Readiness sentinel
# ══════════════════════════════════════════════════════════════════════
info "Running final validation..."

docker ps >/dev/null || fail "Docker not working"
node -v >/dev/null || fail "Node not working"

if command -v ollama >/dev/null; then
  ollama list >/dev/null || warn "Ollama not responding"
fi

info "Validation complete"

sudo touch "$SENTINEL"
echo "=== Ready ===" | sudo tee -a "$LAUNCH_LOG" >/dev/null

info "════════════════════════════════════════════════════"
info "  CI-Ready GPU launchable setup complete"
info "  NemoClaw:   $NEMOCLAW_CLONE_DIR (ref: $NEMOCLAW_REF)"
info "  OpenShell:  $(openshell --version 2>&1 || echo unknown)"
info "  Node.js:    $(node --version)"
info "  Docker:     $(docker --version 2>/dev/null | head -c 40)"
info "  Ollama:     $(ollama --version 2>/dev/null || echo unknown)"
info "  Sentinel:   $SENTINEL"
info "════════════════════════════════════════════════════"
