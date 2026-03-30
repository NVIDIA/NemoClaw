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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./lib/runtime.sh
. "$SCRIPT_DIR/lib/runtime.sh"

_ts() { date '+%H:%M:%S'; }
info() { echo -e "${GREEN}[$(_ts)]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(_ts)]${NC} $1"; }
fail() {
  echo -e "${RED}[$(_ts)]${NC} $1"
  exit 1
}

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
      --config "$config" >/dev/null
    info "Updated $name provider"
  else
    info "Created $name provider"
  fi
}

# Resolve DOCKER_HOST for macOS user-scoped runtimes when needed.
ORIGINAL_DOCKER_HOST="${DOCKER_HOST:-}"
if docker_host="$(detect_docker_host)"; then
  export DOCKER_HOST="$docker_host"
  if [ -n "$ORIGINAL_DOCKER_HOST" ]; then
    warn "Using DOCKER_HOST from environment: $docker_host"
  else
    case "$(docker_host_runtime "$docker_host" || true)" in
      colima)
        warn "Using Colima Docker socket: ${docker_host#unix://}"
        ;;
      docker-desktop)
        warn "Using Docker Desktop socket: ${docker_host#unix://}"
        ;;
      custom)
        warn "Using Docker host: $docker_host"
        ;;
    esac
  fi
fi

# Check prerequisites
command -v openshell >/dev/null || fail "openshell CLI not found. Install the binary from https://github.com/NVIDIA/OpenShell/releases"
command -v docker >/dev/null || fail "docker not found"
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY not set. Get one from build.nvidia.com"

CONTAINER_RUNTIME="$(infer_container_runtime_from_info "$(docker info 2>/dev/null || true)")"
if is_unsupported_macos_runtime "$(uname -s)" "$CONTAINER_RUNTIME"; then
  fail "Podman on macOS is not supported yet. NemoClaw currently depends on OpenShell support for Podman on macOS. Use Colima or Docker Desktop instead."
fi
if [ "$CONTAINER_RUNTIME" != "unknown" ]; then
  info "Container runtime: $CONTAINER_RUNTIME"
fi
SANDBOX_NAME="${1:-${NEMOCLAW_SANDBOX_NAME:-nemoclaw}}"
info "Using sandbox name: ${SANDBOX_NAME}"

OPEN_SHELL_VERSION_RAW="$(openshell -V 2>/dev/null || true)"
OPEN_SHELL_VERSION_LOWER="${OPEN_SHELL_VERSION_RAW,,}"
if [[ "$OPEN_SHELL_VERSION_LOWER" =~ openshell[[:space:]]+([0-9]+\.[0-9]+\.[0-9]+) ]]; then
  export IMAGE_TAG="${BASH_REMATCH[1]}"
  export OPENSHELL_CLUSTER_IMAGE="ghcr.io/nvidia/openshell/cluster:${BASH_REMATCH[1]}"
  info "Using pinned OpenShell gateway image: ${OPENSHELL_CLUSTER_IMAGE}"
elif [[ -n "$OPEN_SHELL_VERSION_RAW" ]]; then
  warn "Could not parse openshell version from 'openshell -V': ${OPEN_SHELL_VERSION_RAW}"
  warn "Skipping OpenShell gateway image pinning."
fi

# 1. Gateway — always start fresh to avoid stale state
info "Starting OpenShell gateway..."
openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true
docker volume ls -q --filter "name=openshell-cluster-nemoclaw" | grep . && docker volume ls -q --filter "name=openshell-cluster-nemoclaw" | xargs docker volume rm || true
GATEWAY_ARGS=(--name nemoclaw)
command -v nvidia-smi >/dev/null 2>&1 && GATEWAY_ARGS+=(--gpu)
if ! openshell gateway start "${GATEWAY_ARGS[@]}" 2>&1 | grep -E "Gateway|✓|Error|error"; then
  warn "Gateway start failed. Cleaning up stale state..."
  openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true
  docker volume ls -q --filter "name=openshell-cluster-nemoclaw" | grep . && docker volume ls -q --filter "name=openshell-cluster-nemoclaw" | xargs docker volume rm || true
  fail "Stale state removed. Please rerun: nemoclaw onboard"
fi

# Verify gateway is actually healthy (may need a moment after start)
for i in 1 2 3 4 5; do
  if openshell status 2>&1 | grep -q "Connected"; then
    break
  fi
  if [ "$i" -eq 5 ]; then
    warn "Gateway health check failed. Cleaning up stale state..."
    openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true
    docker volume ls -q --filter "name=openshell-cluster-nemoclaw" | grep . && docker volume ls -q --filter "name=openshell-cluster-nemoclaw" | xargs docker volume rm || true
    fail "Stale state removed. Please rerun: nemoclaw onboard"
  fi
  sleep 2
done
info "Gateway is healthy"

# 2. CoreDNS fix — k3s-inside-Docker has broken DNS forwarding on all platforms
if [ "$CONTAINER_RUNTIME" != "unknown" ]; then
  info "Patching CoreDNS DNS forwarding..."
  bash "$SCRIPT_DIR/fix-coredns.sh" nemoclaw 2>&1 || warn "CoreDNS patch failed (may not be needed)"
fi

# 3. Providers
info "Setting up inference providers..."

# nvidia-nim (build.nvidia.com)
# Use env-name-only form so openshell reads the value from the environment
# internally — the literal key value never appears in the process argument list.
upsert_provider \
  "nvidia-nim" \
  "openai" \
  "NVIDIA_API_KEY" \
  "OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1"

# vllm-local (if vLLM is installed or running)
if check_local_provider_health "vllm-local" || python3 -c "import vllm" 2>/dev/null; then
  VLLM_LOCAL_BASE_URL="$(get_local_provider_base_url "vllm-local")"
  upsert_provider \
    "vllm-local" \
    "openai" \
    "OPENAI_API_KEY=dummy" \
    "OPENAI_BASE_URL=$VLLM_LOCAL_BASE_URL"
fi

# 4a. Ollama (macOS local inference)
if [ "$(uname -s)" = "Darwin" ]; then
  if ! command -v ollama >/dev/null 2>&1; then
    info "Installing Ollama..."
    brew install ollama 2>/dev/null || warn "Ollama install failed (brew required). Install manually: https://ollama.com"
  fi
  if command -v ollama >/dev/null 2>&1; then
    # Start Ollama service if not running
    if ! check_local_provider_health "ollama-local"; then
      info "Starting Ollama service..."
      OLLAMA_HOST=0.0.0.0:11434 ollama serve >/dev/null 2>&1 &
      sleep 2
    fi
    OLLAMA_LOCAL_BASE_URL="$(get_local_provider_base_url "ollama-local")"
    upsert_provider \
      "ollama-local" \
      "openai" \
      "OPENAI_API_KEY=ollama" \
      "OPENAI_BASE_URL=$OLLAMA_LOCAL_BASE_URL"
  fi
fi

# 4b. Inference route — default to nvidia-nim
info "Setting inference route to nvidia-nim / Nemotron 3 Super..."
openshell inference set --no-verify --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b >/dev/null 2>&1

# 5. Build and create sandbox
info "Deleting old ${SANDBOX_NAME} sandbox (if any)..."
openshell sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1 || true

# Pre-build the base image if it's not available (GHCR image may not exist on
# forks or before the first base-image workflow run). This ensures the
# Dockerfile's `FROM ${BASE_IMAGE}` can resolve locally.
BASE_IMAGE="${BASE_IMAGE:-ghcr.io/nvidia/nemoclaw/sandbox-base:latest}"
if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 && ! docker pull "$BASE_IMAGE" 2>/dev/null; then
  if [ -f "$REPO_DIR/Dockerfile.base" ]; then
    info "Base image not in registry — building Dockerfile.base locally..."
    docker build -f "$REPO_DIR/Dockerfile.base" -t "$BASE_IMAGE" "$REPO_DIR" 2>&1 | tail -5
    info "Local base image built"
  else
    warn "Dockerfile.base not found — sandbox build may fall back to full rebuild"
  fi
fi

info "Building and creating NemoClaw sandbox (this takes a few minutes on first run)..."

# Stage a clean build context (openshell doesn't honor .dockerignore)
BUILD_CTX="$(mktemp -d)"
cp "$REPO_DIR/Dockerfile" "$BUILD_CTX/"
cp -r "$REPO_DIR/nemoclaw" "$BUILD_CTX/nemoclaw"
cp -r "$REPO_DIR/nemoclaw-blueprint" "$BUILD_CTX/nemoclaw-blueprint"
cp -r "$REPO_DIR/scripts" "$BUILD_CTX/scripts"
rm -rf "$BUILD_CTX/nemoclaw/node_modules"
bash "$BUILD_CTX/scripts/clean-staged-tree.sh" "$BUILD_CTX/nemoclaw-blueprint" 2>/dev/null || true

# Capture full output to a temp file so we can filter for display but still
# detect failures. The raw log is kept on failure for debugging.
CREATE_LOG=$(mktemp /tmp/nemoclaw-create-XXXXXX.log)
SANDBOX_BUILD_START=$(date +%s)

# Background progress reporter: tails the log for Docker build steps and
# prints a heartbeat every 30s so CI (and humans) can see what's happening.
(
  while true; do
    sleep 30
    if [ ! -f "$CREATE_LOG" ]; then break; fi
    ELAPSED=$(($(date +%s) - SANDBOX_BUILD_START))
    LAST_STEP=$(grep -oE "^Step [0-9]+/[0-9]+" "$CREATE_LOG" 2>/dev/null | tail -1 || true)
    LAST_LINE=$(tail -1 "$CREATE_LOG" 2>/dev/null | head -c 120 || true)
    # Filter out lines that might contain secrets
    if echo "$LAST_LINE" | grep -qi "API_KEY\|TOKEN\|SECRET\|CREDENTIAL"; then
      LAST_LINE="[filtered]"
    fi
    echo -e "${GREEN}[$(_ts)]${NC} ⏳ Sandbox build ${ELAPSED}s elapsed${LAST_STEP:+ — $LAST_STEP}${LAST_LINE:+ — $LAST_LINE}"
  done
) &
PROGRESS_PID=$!

set +e
# NVIDIA_API_KEY is NOT passed into the sandbox. Inference is proxied through
# the OpenShell gateway which injects the stored credential server-side.
openshell sandbox create --from "$BUILD_CTX/Dockerfile" --name "$SANDBOX_NAME" \
  --provider nvidia-nim \
  --no-tty -- true \
  >"$CREATE_LOG" 2>&1
CREATE_RC=$?
set -e

# Stop progress reporter
kill "$PROGRESS_PID" 2>/dev/null || true
wait "$PROGRESS_PID" 2>/dev/null || true

SANDBOX_BUILD_ELAPSED=$(($(date +%s) - SANDBOX_BUILD_START))
info "Sandbox build finished in ${SANDBOX_BUILD_ELAPSED}s (exit code: $CREATE_RC)"

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

# 6. DNS proxy — run a forwarder in the sandbox pod so the isolated
# sandbox namespace can resolve hostnames (fixes #626).
info "Setting up sandbox DNS proxy..."
bash "$SCRIPT_DIR/setup-dns-proxy.sh" nemoclaw "$SANDBOX_NAME" 2>&1 || warn "DNS proxy setup failed (sandbox DNS may not work)"

# 7. Done
echo ""
info "Setup complete!"
echo ""
echo "  openclaw agent --agent main --local -m 'how many rs are there in strawberry?' --session-id s1"
echo ""
