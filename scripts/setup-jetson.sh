#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw setup for Jetson devices (Orin Nano, Orin NX, AGX Orin, etc.)
#
# Unlike setup.sh, this script is run as a NORMAL USER (not sudo).
# It uses sudo internally only for kernel module loading and Docker
# daemon configuration. All openshell commands run as the user so
# gateway metadata and mTLS certs land in the user's home dir.
#
# Usage:
#   export NVIDIA_API_KEY=nvapi-...
#   bash scripts/setup-jetson.sh
#
# What it does:
#   1. Autodetects Jetson (Tegra/L4T)
#   2. Loads required kernel modules for k3s (sudo)
#   3. Configures Docker daemon for cgroupns=host (sudo)
#   4. Starts the OpenShell gateway
#   5. Patches gateway image: iptables-nft → iptables-legacy, restarts
#   6. Sets up inference providers
#   7. Creates NemoClaw sandbox (with network policy)
#   8. Ensures Ollama is available for local inference
#   9. Fixes CoreDNS forwarding (same issue as Colima)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}>>>${NC} $1"; }
fail() { echo -e "${RED}>>>${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Pre-flight checks ────────────────────────────────────────────

if [ "$(uname -s)" != "Linux" ]; then
  fail "This script is for Jetson (Linux). Use 'nemoclaw setup' for macOS."
fi

if [ "$(id -u)" -eq 0 ]; then
  fail "Do not run as root. Run as your normal user: bash scripts/setup-jetson.sh"
fi

# Autodetect Jetson (L4T / Tegra)
if [ -f /etc/nv_tegra_release ]; then
  TEGRA_INFO=$(head -1 /etc/nv_tegra_release)
  info "Detected Jetson: $TEGRA_INFO"
elif uname -r 2>/dev/null | grep -qi tegra; then
  info "Detected Jetson kernel: $(uname -r)"
else
  warn "No Jetson/Tegra detected. This script is designed for Jetson devices."
  warn "If you're sure this is a Jetson, set FORCE_JETSON=1 to continue."
  [ "${FORCE_JETSON:-}" = "1" ] || fail "Not a Jetson device. Use 'scripts/setup.sh' for standard Linux."
fi

command -v docker > /dev/null || fail "Docker not found."
command -v openshell > /dev/null || fail "openshell CLI not found. Install from https://github.com/NVIDIA/OpenShell/releases"
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY not set. Get one from build.nvidia.com"

# Check docker group membership
if ! id -nG | grep -qw docker; then
  info "Adding you to the docker group (requires sudo)..."
  sudo usermod -aG docker "$USER"
  fail "Added to docker group. Please log out and back in (or 'newgrp docker'), then re-run this script."
fi

# ── 1. Kernel modules (requires sudo) ────────────────────────────
#
# L4T builds xt_comment, xt_conntrack, nf_conntrack etc. as modules
# but doesn't load them at boot.  k3s's kube-router panics without
# them because it can't insert iptables rules.

MODULES=(
  br_netfilter
  xt_comment xt_conntrack nf_conntrack xt_mark xt_nat xt_MASQUERADE
  ip_set_hash_net ip_set_hash_ip ip_set_hash_ipport
  ip_set_hash_ipportnet ip_set_hash_ipportip ip_set_bitmap_port
)
LOADED_ANY=false

for mod in "${MODULES[@]}"; do
  if ! lsmod | grep -qw "$mod"; then
    if sudo modprobe "$mod" 2>/dev/null; then
      info "Loaded kernel module: $mod"
      LOADED_ANY=true
    else
      warn "Could not load kernel module: $mod (may not be needed)"
    fi
  fi
done

if [ "$LOADED_ANY" = true ]; then
  for mod in "${MODULES[@]}"; do
    if ! grep -qx "$mod" /etc/modules-load.d/k3s-netfilter.conf 2>/dev/null; then
      echo "$mod" | sudo tee -a /etc/modules-load.d/k3s-netfilter.conf > /dev/null
    fi
  done
  info "Modules persisted to /etc/modules-load.d/k3s-netfilter.conf"
fi
info "Kernel modules OK"

# ── 2. Docker cgroup namespace (requires sudo) ───────────────────

if [ "$(stat -fc %T /sys/fs/cgroup/ 2>/dev/null)" = "cgroup2fs" ]; then
  DAEMON_JSON="/etc/docker/daemon.json"
  NEEDS_RESTART=false

  if [ -f "$DAEMON_JSON" ]; then
    CURRENT_MODE=$(python3 -c "import json; print(json.load(open('$DAEMON_JSON')).get('default-cgroupns-mode',''))" 2>/dev/null || echo "")
    if [ "$CURRENT_MODE" = "host" ]; then
      info "Docker daemon already configured for cgroupns=host"
    else
      info "Setting Docker daemon cgroupns=host (requires sudo)..."
      sudo python3 -c "
import json
with open('$DAEMON_JSON') as f:
    d = json.load(f)
d['default-cgroupns-mode'] = 'host'
with open('$DAEMON_JSON', 'w') as f:
    json.dump(d, f, indent=2)
"
      NEEDS_RESTART=true
    fi
  else
    info "Creating Docker daemon config with cgroupns=host (requires sudo)..."
    sudo mkdir -p "$(dirname "$DAEMON_JSON")"
    echo '{ "default-cgroupns-mode": "host" }' | sudo tee "$DAEMON_JSON" > /dev/null
    NEEDS_RESTART=true
  fi

  if [ "$NEEDS_RESTART" = true ]; then
    info "Restarting Docker daemon..."
    sudo systemctl restart docker
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if docker info > /dev/null 2>&1; then
        break
      fi
      [ "$i" -eq 10 ] && fail "Docker didn't come back after restart. Check 'systemctl status docker'."
      sleep 2
    done
    info "Docker restarted with cgroupns=host"
  fi
else
  info "cgroup v1 — no Docker changes needed"
fi

# ── No more sudo needed from here on ─────────────────────────────

# ── 3. Start gateway ─────────────────────────────────────────────

info "Starting OpenShell gateway..."
openshell gateway destroy -g nemoclaw > /dev/null 2>&1 || true
GATEWAY_ARGS=(--name nemoclaw)
command -v nvidia-smi > /dev/null 2>&1 && GATEWAY_ARGS+=(--gpu)
openshell gateway start "${GATEWAY_ARGS[@]}" 2>&1 | grep -E "Gateway|✓|Error|error" || true

# The gateway container will crash because of iptables-nft.
# That's expected — we patch and restart it in the next step.
sleep 3

# ── 4. Patch gateway image: iptables-nft → iptables-legacy ──────
#
# The OpenShell gateway image ships iptables v1.8.10 defaulting to
# the nf_tables backend. L4T's kernel uses iptables-legacy on the
# host and the nf_tables compat layer is incomplete (xt_addrtype
# etc.). k3s's kube-router panics when nft RULE_INSERT fails.
#
# We patch AFTER `openshell gateway start` because that command
# pulls the upstream image from the registry, which would overwrite
# any earlier patch.

# Derive the cluster image tag from the installed openshell CLI version
# so the patch targets the image that `openshell gateway start` actually pulls.
OPENSHELL_VERSION=$(openshell --version 2>&1 | grep -oP '\d+\.\d+\.\d+' | head -1)
GATEWAY_IMAGE="ghcr.io/nvidia/openshell/cluster:${OPENSHELL_VERSION:-0.0.8}"

CURRENT_IPT=$(docker run --rm --entrypoint iptables "$GATEWAY_IMAGE" --version 2>&1 || true)
if echo "$CURRENT_IPT" | grep -q "legacy"; then
  info "Gateway image already using iptables-legacy"
else
  info "Patching gateway image to use iptables-legacy..."

  PATCH_CTX="$(mktemp -d)"
  cat > "$PATCH_CTX/Dockerfile" <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# L4T's iptables uses the legacy backend; the nf_tables compat layer
# is incomplete, so switch k3s to iptables-legacy.
RUN update-alternatives --set iptables /usr/sbin/iptables-legacy \
 && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy

# L4T kernel only ships ip_set_hash_net — kube-router's network policy
# controller needs additional ipset types (hash:ip, hash:ipport, etc.)
# that don't exist. Disable the controller to avoid ipset panics.
# Egress policy enforcement still works via OpenShell's HTTP proxy
# (HTTP_PROXY/HTTPS_PROXY injected into the sandbox).
RUN mv /usr/local/bin/cluster-entrypoint.sh /usr/local/bin/cluster-entrypoint-orig.sh
COPY entrypoint-jetson.sh /usr/local/bin/cluster-entrypoint.sh
RUN chmod +x /usr/local/bin/cluster-entrypoint.sh
DOCKERFILE

  cat > "$PATCH_CTX/entrypoint-jetson.sh" <<'WRAPPER'
#!/bin/sh
# Jetson wrapper: disable kube-router network policy controller to avoid
# ipset panics (L4T lacks hash:ip, hash:ipport kernel modules).
# Egress is still enforced by OpenShell's HTTP proxy layer.
exec /usr/local/bin/cluster-entrypoint-orig.sh "$@" --disable-network-policy
WRAPPER

  docker build -t "$GATEWAY_IMAGE" \
    --build-arg "BASE_IMAGE=$GATEWAY_IMAGE" \
    "$PATCH_CTX" 2>&1 | tail -3
  rm -rf "$PATCH_CTX"

  # Verify
  PATCHED_IPT=$(docker run --rm --entrypoint iptables "$GATEWAY_IMAGE" --version 2>&1 || true)
  if echo "$PATCHED_IPT" | grep -q "legacy"; then
    info "Gateway patched: $PATCHED_IPT"
  else
    warn "Patch may have failed: $PATCHED_IPT"
  fi
fi

# Restart the gateway container with the patched image
CLUSTER_CONTAINER="openshell-cluster-nemoclaw"
info "Restarting gateway with patched image..."
docker rm -f "$CLUSTER_CONTAINER" > /dev/null 2>&1 || true
openshell gateway destroy -g nemoclaw > /dev/null 2>&1 || true
openshell gateway start "${GATEWAY_ARGS[@]}" 2>&1 | grep -E "Gateway|✓|Error|error" || true

# Verify gateway is healthy
for i in 1 2 3 4 5 6 7 8 9 10; do
  if openshell status 2>&1 | grep -q "Connected"; then
    break
  fi
  [ "$i" -eq 10 ] && fail "Gateway failed to start. Check 'docker logs $CLUSTER_CONTAINER'."
  sleep 3
done
info "Gateway is healthy"

# ── 5. Inference providers ───────────────────────────────────────

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

info "Setting up inference providers..."

upsert_provider \
  "nvidia-nim" \
  "openai" \
  "NVIDIA_API_KEY=$NVIDIA_API_KEY" \
  "OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1"

# Ollama provider (Jetson local inference)
if command -v ollama > /dev/null 2>&1; then
  upsert_provider \
    "ollama-local" \
    "openai" \
    "OPENAI_API_KEY=ollama" \
    "OPENAI_BASE_URL=http://host.openshell.internal:11434/v1"
fi

# vllm-local (if vLLM is running)
if curl -s http://localhost:8000/v1/models > /dev/null 2>&1; then
  upsert_provider \
    "vllm-local" \
    "openai" \
    "OPENAI_API_KEY=dummy" \
    "OPENAI_BASE_URL=http://host.openshell.internal:8000/v1"
fi

info "Setting inference route to nvidia-nim / Nemotron 3 Super..."
openshell inference set --no-verify --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b > /dev/null 2>&1

# ── 6. Create sandbox (with network policy) ─────────────────────

info "Deleting old nemoclaw sandbox (if any)..."
openshell sandbox delete nemoclaw > /dev/null 2>&1 || true

info "Building and creating NemoClaw sandbox (this takes a few minutes on first run)..."

# Stage a clean build context (openshell doesn't honor .dockerignore)
BUILD_CTX="$(mktemp -d)"
cp "$REPO_DIR/Dockerfile" "$BUILD_CTX/"
cp -r "$REPO_DIR/nemoclaw" "$BUILD_CTX/nemoclaw"
cp -r "$REPO_DIR/nemoclaw-blueprint" "$BUILD_CTX/nemoclaw-blueprint"
cp -r "$REPO_DIR/scripts" "$BUILD_CTX/scripts"
rm -rf "$BUILD_CTX/nemoclaw/node_modules"

# Verify nemoclaw/src/ exists (Dockerfile builds from source in a multi-stage build)
if [ ! -d "$BUILD_CTX/nemoclaw/src" ] || [ -z "$(ls -A "$BUILD_CTX/nemoclaw/src" 2>/dev/null)" ]; then
  rm -rf "$BUILD_CTX"
  fail "nemoclaw/src/ is missing or empty. Are you running from a valid NemoClaw checkout?"
fi

CREATE_LOG=$(mktemp /tmp/nemoclaw-create-XXXXXX.log)
set +e
openshell sandbox create --from "$BUILD_CTX/Dockerfile" --name nemoclaw \
  --provider nvidia-nim \
  --policy "$REPO_DIR/nemoclaw-blueprint/policies/openclaw-sandbox.yaml" \
  -- env NVIDIA_API_KEY="$NVIDIA_API_KEY" > "$CREATE_LOG" 2>&1
CREATE_RC=$?
set -e
rm -rf "$BUILD_CTX"

grep -E "^  (Step |Building |Built |Pushing |\[progress\]|Successfully |Created sandbox|Image )|✓" "$CREATE_LOG" || true

if [ "$CREATE_RC" != "0" ]; then
  echo ""
  warn "Last 20 lines of build output:"
  tail -20 "$CREATE_LOG" | grep -v "NVIDIA_API_KEY"
  echo ""
  fail "Sandbox creation failed (exit $CREATE_RC). Full log: $CREATE_LOG"
fi
rm -f "$CREATE_LOG"

# Verify sandbox is Ready
SANDBOX_LINE=$(openshell sandbox list 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep "nemoclaw")
if ! echo "$SANDBOX_LINE" | grep -q "Ready"; then
  SANDBOX_PHASE=$(echo "$SANDBOX_LINE" | awk '{print $NF}')
  fail "Sandbox created but not Ready (phase: ${SANDBOX_PHASE:-unknown}). Check 'openshell sandbox get nemoclaw'."
fi

# ── 6b. Pre-populate network policy draft rules ──────────────────
#
# On Jetson, kube-router's network policy controller is disabled (ipset
# panics on L4T), so egress goes through OpenShell's HTTP proxy. The
# proxy generates draft rules only when traffic actually hits it.
# Trigger connections to every endpoint in the policy so the rules are
# ready and waiting when the user opens `openshell term` to approve.

info "Triggering network policy rule generation..."
POLICY_HOSTS=(
  api.anthropic.com statsig.anthropic.com sentry.io
  integrate.api.nvidia.com inference-api.nvidia.com
  github.com api.github.com
  clawhub.com openclaw.ai docs.openclaw.ai
  registry.npmjs.org
  api.telegram.org
  discord.com gateway.discord.gg cdn.discordapp.com
)

# Build a one-liner that curls every host from inside the sandbox
CURL_CMDS=""
for host in "${POLICY_HOSTS[@]}"; do
  CURL_CMDS="${CURL_CMDS}curl -sf -o /dev/null --connect-timeout 3 https://${host} 2>/dev/null || true; "
done

# SSH into the sandbox and fire off all the requests (they'll all 403,
# but that's the point — the proxy records each as a draft rule)
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o "ProxyCommand=openshell ssh-proxy --gateway-name nemoclaw --name nemoclaw" \
  sandbox@openshell-nemoclaw "$CURL_CMDS" > /dev/null 2>&1 || true

info "Draft rules generated — approve them in 'openshell term'"

# ── 7. Ollama (optional local inference) ──────────────────────────

if ! command -v ollama > /dev/null 2>&1; then
  info "Installing Ollama (requires sudo)..."
  curl -fsSL https://ollama.com/install.sh | sudo sh
fi

if command -v ollama > /dev/null 2>&1; then
  info "Ollama available (no model pulled — use 'ollama pull <model>' for local inference)"
fi

# ── 8. Fix CoreDNS (Jetson-specific) ────────────────────────────

CLUSTER=$(docker ps --filter "name=openshell-cluster" --format '{{.Names}}' | head -1)
if [ -n "$CLUSTER" ]; then
  DNS_IP=$(docker exec "$CLUSTER" cat /etc/rancher/k3s/resolv.conf 2>/dev/null \
    | grep nameserver | awk '{print $2}')

  if [ -n "$DNS_IP" ] && [[ "$DNS_IP" != 127.* ]]; then
    CURRENT_FWD=$(docker exec "$CLUSTER" kubectl get configmap coredns -n kube-system \
      -o jsonpath='{.data.Corefile}' 2>/dev/null | grep -oP 'forward \. \K\S+' || true)

    if [ "$CURRENT_FWD" != "$DNS_IP" ]; then
      info "Patching CoreDNS to forward to $DNS_IP..."
      docker exec "$CLUSTER" kubectl patch configmap coredns -n kube-system --type merge \
        -p "{\"data\":{\"Corefile\":\".:53 {\\n    errors\\n    health\\n    ready\\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\\n      pods insecure\\n      fallthrough in-addr.arpa ip6.arpa\\n    }\\n    hosts /etc/coredns/NodeHosts {\\n      ttl 60\\n      reload 15s\\n      fallthrough\\n    }\\n    prometheus :9153\\n    cache 30\\n    loop\\n    reload\\n    loadbalance\\n    forward . $DNS_IP\\n}\\n\"}}" > /dev/null
      docker exec "$CLUSTER" kubectl rollout restart deploy/coredns -n kube-system > /dev/null
      docker exec "$CLUSTER" kubectl rollout status deploy/coredns -n kube-system --timeout=30s > /dev/null 2>&1
      info "CoreDNS patched"

      docker exec "$CLUSTER" kubectl delete pod -n openshell -l app=nemoclaw --ignore-not-found > /dev/null 2>&1 || true
    else
      info "CoreDNS already forwarding to $DNS_IP"
    fi
  fi
fi

# ── Done ─────────────────────────────────────────────────────────

echo ""
info "Jetson setup complete!"
echo ""
echo "  Next steps:"
echo "    1. Run 'openshell term' and approve the pending network policy rules."
echo "       (The sandbox blocks all egress until you approve.)"
echo "    2. Connect to the sandbox:"
echo "       openshell sandbox connect nemoclaw"
echo "    3. Test the agent:"
echo "       openclaw agent --agent main --local -m 'hello' --session-id s1"
echo ""
