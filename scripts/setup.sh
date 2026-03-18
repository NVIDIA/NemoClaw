#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw setup — run this on the HOST to set up everything.
#
# Prerequisites:
#   - Docker running (Colima, Docker Desktop, or native)
#   - openshell CLI installed (pip install openshell @ git+https://github.com/NVIDIA/OpenShell.git)
#   - NVIDIA_API_KEY set in environment (from build.nvidia.com)
#
# Usage:
#   export NVIDIA_API_KEY=nvapi-...
#   ./scripts/setup.sh [sandbox-name]
#
# What it does:
#   1. Starts an OpenShell gateway (or reuses existing)
#   2. Fixes CoreDNS for Colima environments
#   3. Creates nvidia-nim provider (build.nvidia.com)
#   4. Creates vllm-local provider (if vLLM is running)
#   5. Sets inference route to nvidia-nim by default
#   6. Builds and creates the NemoClaw sandbox
#   7. Prints next steps

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}>>>${NC} $1"; }
fail() { echo -e "${RED}>>>${NC} $1"; exit 1; }

upsert_provider() {
  local name="$1"
  local type="$2"
  local credential="$3"
  local config="$4"

  if openshell provider create --name "$name" --type "$type" \
    --credential "$credential" \
    --config "$config" 2>&1 | grep -q "AlreadyExists"; then
    openshell provider update "$name" \
      --credential "$credential" \
      --config "$config" > /dev/null
    info "Updated $name provider"
  else
    info "Created $name provider"
  fi
}

# Resolve DOCKER_HOST for Colima if needed (legacy ~/.colima or XDG ~/.config/colima)
if [ -z "${DOCKER_HOST:-}" ]; then
  for _sock in "$HOME/.colima/default/docker.sock" "$HOME/.config/colima/default/docker.sock"; do
    if [ -S "$_sock" ]; then
      export DOCKER_HOST="unix://$_sock"
      warn "Using Colima Docker socket: $_sock"
      break
    fi
  done
  unset _sock
fi

# Check prerequisites
command -v openshell > /dev/null || fail "openshell CLI not found. Install the binary from https://github.com/NVIDIA/OpenShell/releases"
command -v docker > /dev/null || fail "docker not found"
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY not set. Get one from build.nvidia.com"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_NAME="${1:-nemoclaw}"
info "Using sandbox name: ${SANDBOX_NAME}"

# 1. Gateway — always start fresh to avoid stale state
info "Starting OpenShell gateway..."
openshell gateway destroy -g nemoclaw > /dev/null 2>&1 || true
GATEWAY_ARGS=(--name nemoclaw)
command -v nvidia-smi > /dev/null 2>&1 && GATEWAY_ARGS+=(--gpu)
openshell gateway start "${GATEWAY_ARGS[@]}" 2>&1 | grep -E "Gateway|✓|Error|error" || true

# Verify gateway is actually healthy (may need a moment after start)
for i in 1 2 3 4 5; do
  if openshell status 2>&1 | grep -q "Connected"; then
    break
  fi
  [ "$i" -eq 5 ] && fail "Gateway failed to start. Check 'openshell gateway info' and Docker logs."
  sleep 2
done
info "Gateway is healthy"

# 2. CoreDNS fix (Colima only)
if [ -S "$HOME/.colima/default/docker.sock" ]; then
  info "Patching CoreDNS for Colima..."
  bash "$SCRIPT_DIR/fix-coredns.sh" 2>&1 || warn "CoreDNS patch failed (may not be needed)"
fi

# 3. Providers
info "Setting up inference providers..."

# nvidia-nim (build.nvidia.com)
upsert_provider \
  "nvidia-nim" \
  "openai" \
  "NVIDIA_API_KEY=$NVIDIA_API_KEY" \
  "OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1"

# vllm-local (if vLLM is installed or running)
if curl -s http://localhost:8000/v1/models > /dev/null 2>&1 || python3 -c "import vllm" 2>/dev/null; then
  upsert_provider \
    "vllm-local" \
    "openai" \
    "OPENAI_API_KEY=dummy" \
    "OPENAI_BASE_URL=http://host.openshell.internal:8000/v1"
fi

# 4a. Ollama (macOS local inference)
if [ "$(uname -s)" = "Darwin" ]; then
  if ! command -v ollama > /dev/null 2>&1; then
    info "Installing Ollama..."
    brew install ollama 2>/dev/null || warn "Ollama install failed (brew required). Install manually: https://ollama.com"
  fi
  if command -v ollama > /dev/null 2>&1; then
    # Start Ollama service if not running
    if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
      info "Starting Ollama service..."
      OLLAMA_HOST=0.0.0.0:11434 ollama serve > /dev/null 2>&1 &
      sleep 2
    fi
    upsert_provider \
      "ollama-local" \
      "openai" \
      "OPENAI_API_KEY=ollama" \
      "OPENAI_BASE_URL=http://host.openshell.internal:11434/v1"
  fi
fi

# 4b. Inference route — default to nvidia-nim
info "Setting inference route to nvidia-nim / Nemotron 3 Super..."
openshell inference set --no-verify --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b > /dev/null 2>&1

# 5. Build and create sandbox
info "Deleting old ${SANDBOX_NAME} sandbox (if any)..."
openshell sandbox delete "$SANDBOX_NAME" > /dev/null 2>&1 || true

info "Building and creating NemoClaw sandbox (this takes a few minutes on first run)..."

# Stage a clean build context (openshell doesn't honor .dockerignore)
BUILD_CTX="$(mktemp -d)"
cp "$REPO_DIR/Dockerfile" "$BUILD_CTX/"
cp -r "$REPO_DIR/nemoclaw" "$BUILD_CTX/nemoclaw"
cp -r "$REPO_DIR/nemoclaw-blueprint" "$BUILD_CTX/nemoclaw-blueprint"
cp -r "$REPO_DIR/scripts" "$BUILD_CTX/scripts"
rm -rf "$BUILD_CTX/nemoclaw/node_modules" "$BUILD_CTX/nemoclaw/src"

# Verify nemoclaw/dist/ exists (TypeScript must be pre-built)
if [ ! -d "$BUILD_CTX/nemoclaw/dist" ] || [ -z "$(ls -A "$BUILD_CTX/nemoclaw/dist" 2>/dev/null)" ]; then
  rm -rf "$BUILD_CTX"
  fail "nemoclaw/dist/ is missing or empty. Run 'cd nemoclaw && npm install && npm run build' first."
fi

# Capture full output to a temp file so we can filter for display but still
# detect failures. The raw log is kept on failure for debugging.
CREATE_LOG=$(mktemp /tmp/nemoclaw-create-XXXXXX.log)
set +e
openshell sandbox create --from "$BUILD_CTX/Dockerfile" --name "$SANDBOX_NAME" \
  --provider nvidia-nim \
  -- env NVIDIA_API_KEY="$NVIDIA_API_KEY" > "$CREATE_LOG" 2>&1
CREATE_RC=$?
set -e
rm -rf "$BUILD_CTX"

# Show progress lines (filter apt noise and env var dumps that contain NVIDIA_API_KEY)
grep -E "^  (Step |Building |Built |Pushing |\[progress\]|Successfully |Created sandbox|Image )|✓" "$CREATE_LOG" || true

if [ "$CREATE_RC" != "0" ]; then
  echo ""
  warn "Last 20 lines of build output:"
  tail -20 "$CREATE_LOG" | grep -v "NVIDIA_API_KEY"
  echo ""
  fail "Sandbox creation failed (exit $CREATE_RC). Full log: $CREATE_LOG"
fi
rm -f "$CREATE_LOG"

# Verify sandbox is Ready (not just that a record exists)
# Strip ANSI color codes before checking phase
SANDBOX_LINE=$(openshell sandbox list 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | awk -v name="$SANDBOX_NAME" '$1 == name { print; exit }')
if ! echo "$SANDBOX_LINE" | grep -q "Ready"; then
  SANDBOX_PHASE=$(echo "$SANDBOX_LINE" | awk '{print $NF}')
  echo ""
  warn "Sandbox phase: ${SANDBOX_PHASE:-unknown}"
  # Check for common failure modes
  SB_DETAIL=$(openshell sandbox get "$SANDBOX_NAME" 2>&1 || true)
  if echo "$SB_DETAIL" | grep -qi "ImagePull\|ErrImagePull\|image.*not found"; then
    warn "Image pull failure detected. The sandbox image was built inside the"
    warn "gateway but k3s can't find it. This is a known openshell issue."
    warn "Workaround: run 'openshell gateway destroy && openshell gateway start'"
    warn "and re-run this script."
  fi
  fail "Sandbox created but not Ready (phase: ${SANDBOX_PHASE:-unknown}). Check 'openshell sandbox get ${SANDBOX_NAME}'."
fi

# 6. Done
echo ""
info "Setup complete!"
echo ""
echo "  openclaw agent --agent main --local -m 'how many rs are there in strawberry?' --session-id s1"
echo ""
