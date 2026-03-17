#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw setup for Jetson devices (Orin Nano, Orin NX, AGX Orin, etc.)
#
# Jetson's L4T kernel ships the iptables/netfilter modules that k3s needs
# (xt_comment, xt_conntrack, etc.) but doesn't load them by default.
# Without them, OpenShell's k3s gateway panics on network policy setup.
#
# This script loads the missing modules, configures Docker for cgroup v2
# (same as setup-spark.sh), sets up Ollama for local inference, then
# hands off to the normal setup.sh for the full OpenShell/k3s path.
#
# Usage:
#   sudo bash scripts/setup-jetson.sh
#
# What it does (beyond setup.sh):
#   1. Autodetects Jetson (Tegra/L4T)
#   2. Loads required kernel modules for k3s (iptables + ipset)
#   3. Configures Docker daemon for cgroupns=host (if cgroup v2)
#   4. Patches OpenShell gateway image: iptables-nft → iptables-legacy
#   5. Ensures Ollama is running with a suitable model
#   6. Runs the normal setup.sh (full OpenShell/k3s path)
#   7. Fixes CoreDNS forwarding (same issue as Colima)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}>>>${NC} $1"; }
fail() { echo -e "${RED}>>>${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Pre-flight checks ────────────────────────────────────────────

if [ "$(uname -s)" != "Linux" ]; then
  fail "This script is for Jetson (Linux). Use 'nemoclaw setup' for macOS."
fi

if [ "$(id -u)" -ne 0 ]; then
  fail "Must run as root: sudo bash scripts/setup-jetson.sh"
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

# Detect the real user (not root) for docker group / handoff
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo "")}"
if [ -z "$REAL_USER" ]; then
  warn "Could not detect non-root user. Docker group will not be configured."
fi

# ── 1. Docker group ──────────────────────────────────────────────

if [ -n "$REAL_USER" ]; then
  if id -nG "$REAL_USER" | grep -qw docker; then
    info "User '$REAL_USER' already in docker group"
  else
    info "Adding '$REAL_USER' to docker group..."
    usermod -aG docker "$REAL_USER"
    info "Added. Group will take effect on next login (or use 'newgrp docker')."
  fi
fi

# ── 2. Kernel modules for k3s iptables ──────────────────────────
#
# L4T builds xt_comment, xt_conntrack, nf_conntrack etc. as modules
# but doesn't load them at boot.  k3s's kube-router panics without
# them because it can't insert iptables rules.

MODULES=(
  # Bridge netfilter — required for pod-to-pod and ClusterIP routing
  br_netfilter
  # iptables matches for kube-router / kube-proxy
  xt_comment xt_conntrack nf_conntrack xt_mark xt_nat xt_MASQUERADE
  # ipset types for kube-router network policy (load what's available)
  ip_set_hash_net ip_set_hash_ip ip_set_hash_ipport
  ip_set_hash_ipportnet ip_set_hash_ipportip ip_set_bitmap_port
)
LOADED_ANY=false

for mod in "${MODULES[@]}"; do
  if ! lsmod | grep -qw "$mod"; then
    if modprobe "$mod" 2>/dev/null; then
      info "Loaded kernel module: $mod"
      LOADED_ANY=true
    else
      warn "Could not load kernel module: $mod (may not be needed)"
    fi
  fi
done

if [ "$LOADED_ANY" = true ]; then
  # Persist across reboots
  for mod in "${MODULES[@]}"; do
    if ! grep -qx "$mod" /etc/modules-load.d/k3s-netfilter.conf 2>/dev/null; then
      echo "$mod" >> /etc/modules-load.d/k3s-netfilter.conf
    fi
  done
  info "Modules persisted to /etc/modules-load.d/k3s-netfilter.conf"
fi
info "Kernel modules OK"

# ── 3. Docker cgroup namespace (same as setup-spark.sh) ──────────
#
# If cgroup v2, k3s-in-Docker needs cgroupns=host.

if [ "$(stat -fc %T /sys/fs/cgroup/ 2>/dev/null)" = "cgroup2fs" ]; then
  DAEMON_JSON="/etc/docker/daemon.json"
  NEEDS_RESTART=false

  if [ -f "$DAEMON_JSON" ]; then
    CURRENT_MODE=$(python3 -c "import json; print(json.load(open('$DAEMON_JSON')).get('default-cgroupns-mode',''))" 2>/dev/null || echo "")
    if [ "$CURRENT_MODE" = "host" ]; then
      info "Docker daemon already configured for cgroupns=host"
    else
      info "Setting Docker daemon cgroupns=host..."
      python3 -c "
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
    info "Creating Docker daemon config with cgroupns=host..."
    mkdir -p "$(dirname "$DAEMON_JSON")"
    echo '{ "default-cgroupns-mode": "host" }' > "$DAEMON_JSON"
    NEEDS_RESTART=true
  fi

  if [ "$NEEDS_RESTART" = true ]; then
    info "Restarting Docker daemon..."
    systemctl restart docker
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

# ── 4. Patch gateway image: iptables-nft → iptables-legacy ───────
#
# The OpenShell gateway image ships iptables v1.8.10 defaulting to
# the nf_tables backend. L4T's kernel uses iptables-legacy on the
# host and the nf_tables compat layer is incomplete (xt_addrtype
# etc.). k3s's kube-router panics when nft RULE_INSERT fails.
#
# Fix: build a one-layer wrapper that switches the alternative to
# iptables-legacy, then tag it over the upstream image name so
# `openshell gateway start` uses it. The upstream layers are
# preserved — `docker pull` restores the original at any time.

GATEWAY_IMAGE="ghcr.io/nvidia/openshell/cluster:0.0.8"

# Pull upstream image if not present
if ! docker image inspect "$GATEWAY_IMAGE" > /dev/null 2>&1; then
  info "Pulling OpenShell gateway image..."
  docker pull "$GATEWAY_IMAGE"
fi

# Check if already patched (iptables-legacy inside the image)
CURRENT_IPT=$(docker run --rm --entrypoint iptables "$GATEWAY_IMAGE" --version 2>&1 || true)
if echo "$CURRENT_IPT" | grep -q "legacy"; then
  info "Gateway image already using iptables-legacy"
else
  info "Patching gateway image to use iptables-legacy..."
  # Save upstream image ID so we can verify we're wrapping the right thing
  UPSTREAM_ID=$(docker image inspect --format='{{.Id}}' "$GATEWAY_IMAGE")

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
# that don't exist. Disable the controller so it doesn't block pod traffic.
# Wrap the original entrypoint to inject --disable-network-policy.
RUN mv /usr/local/bin/cluster-entrypoint.sh /usr/local/bin/cluster-entrypoint-orig.sh
COPY entrypoint-jetson.sh /usr/local/bin/cluster-entrypoint.sh
RUN chmod +x /usr/local/bin/cluster-entrypoint.sh
DOCKERFILE

  cat > "$PATCH_CTX/entrypoint-jetson.sh" <<'WRAPPER'
#!/bin/sh
# Jetson wrapper: inject --disable-network-policy then call original entrypoint.
# The original entrypoint ends with: exec /bin/k3s "$@" ...
# We append our flag to the args passed through.
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

# ── 5. Ollama (optional local inference) ──────────────────────────
#
# Ollama is installed if not present but no model is pulled by default.
# To use local inference after setup, pull a model and switch:
#   ollama pull nemotron-3-nano:4b
#   openshell inference set --provider vllm-local --model nemotron-3-nano:4b

if ! command -v ollama > /dev/null 2>&1; then
  info "Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

if command -v ollama > /dev/null 2>&1; then
  info "Ollama available (no model pulled — use 'ollama pull <model>' for local inference)"
fi

# ── 6. Run normal setup.sh ───────────────────────────────────────

info "Running NemoClaw setup..."
echo ""

if [ -n "$REAL_USER" ]; then
  sudo -u "$REAL_USER" -E \
    NVIDIA_API_KEY="${NVIDIA_API_KEY:-}" \
    DOCKER_HOST="${DOCKER_HOST:-}" \
    bash "$SCRIPT_DIR/setup.sh"
else
  bash "$SCRIPT_DIR/setup.sh"
fi

# ── 7. Fix CoreDNS (Jetson-specific) ────────────────────────────
#
# Same problem as Colima: k3s CoreDNS forwards to /etc/resolv.conf
# which contains 127.0.0.11 (Docker's internal DNS), unreachable
# from k3s pods. The entrypoint sets up a DNS proxy on the
# container's eth0 IP — point CoreDNS there instead.
#
# setup.sh only runs fix-coredns.sh for Colima. On Jetson the
# Docker engine also uses 127.0.0.11 in /etc/resolv.conf, so
# the same fix is needed.

CLUSTER=$(docker ps --filter "name=openshell-cluster" --format '{{.Names}}' | head -1)
if [ -n "$CLUSTER" ]; then
  DNS_IP=$(docker exec "$CLUSTER" cat /etc/rancher/k3s/resolv.conf 2>/dev/null \
    | grep nameserver | awk '{print $2}')

  if [ -n "$DNS_IP" ] && [[ "$DNS_IP" != 127.* ]]; then
    # Check if CoreDNS is already forwarding to the right IP
    CURRENT_FWD=$(docker exec "$CLUSTER" kubectl get configmap coredns -n kube-system \
      -o jsonpath='{.data.Corefile}' 2>/dev/null | grep -oP 'forward \. \K\S+' || true)

    if [ "$CURRENT_FWD" != "$DNS_IP" ]; then
      info "Patching CoreDNS to forward to $DNS_IP..."
      docker exec "$CLUSTER" kubectl patch configmap coredns -n kube-system --type merge \
        -p "{\"data\":{\"Corefile\":\".:53 {\\n    errors\\n    health\\n    ready\\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\\n      pods insecure\\n      fallthrough in-addr.arpa ip6.arpa\\n    }\\n    hosts /etc/coredns/NodeHosts {\\n      ttl 60\\n      reload 15s\\n      fallthrough\\n    }\\n    prometheus :9153\\n    cache 30\\n    loop\\n    reload\\n    loadbalance\\n    forward . $DNS_IP\\n}\\n\"}}" > /dev/null
      docker exec "$CLUSTER" kubectl rollout restart deploy/coredns -n kube-system > /dev/null
      docker exec "$CLUSTER" kubectl rollout status deploy/coredns -n kube-system --timeout=30s > /dev/null 2>&1
      info "CoreDNS patched"

      # Bounce the sandbox pod so it picks up working DNS immediately
      # instead of waiting for CrashLoopBackOff to expire
      docker exec "$CLUSTER" kubectl delete pod -n openshell -l app=nemoclaw --ignore-not-found > /dev/null 2>&1 || true
    else
      info "CoreDNS already forwarding to $DNS_IP"
    fi
  fi
fi
