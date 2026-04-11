#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Fix CoreDNS on local OpenShell gateways running under Colima or Podman.
#
# Problem: k3s CoreDNS forwards to /etc/resolv.conf which inside the
# CoreDNS pod resolves to 127.0.0.11 (Docker/Podman's embedded DNS).
# That address is NOT reachable from k3s pods, causing DNS to fail and
# CoreDNS to CrashLoop.
#
# Fix: forward CoreDNS to a non-loopback upstream resolver derived from
# the container's resolv.conf, the host's resolv.conf, or systemd-resolved's
# actual upstream (via resolve_coredns_upstream). This avoids the loopback
# address that is unreachable from k3s pods.
#
# Run this after `openshell gateway start` on Colima or Podman setups.
#
# Usage: ./scripts/fix-coredns.sh [gateway-name]

set -euo pipefail

GATEWAY_NAME="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib/runtime.sh
. "$SCRIPT_DIR/lib/runtime.sh"

DETECTED_RUNTIME="unknown"

if [ -z "${DOCKER_HOST:-}" ]; then
  COLIMA_SOCKET="$(find_colima_docker_socket || true)"
  if [ -n "$COLIMA_SOCKET" ]; then
    export DOCKER_HOST="unix://$COLIMA_SOCKET"
    DETECTED_RUNTIME="colima"
  else
    PODMAN_SOCKET="$(find_podman_socket || true)"
    if [ -n "$PODMAN_SOCKET" ]; then
      export DOCKER_HOST="unix://$PODMAN_SOCKET"
      DETECTED_RUNTIME="podman"
    else
      echo "Skipping CoreDNS patch: no Colima or Podman socket found."
      exit 0
    fi
  fi
else
  DETECTED_RUNTIME="$(docker_host_runtime "$DOCKER_HOST" || echo "custom")"
fi

# Find the cluster container
CLUSTERS="$(docker ps --filter "name=openshell-cluster" --format '{{.Names}}')"
CLUSTER="$(select_openshell_cluster_container "$GATEWAY_NAME" "$CLUSTERS" || true)"
if [ -z "$CLUSTER" ]; then
  if [ -n "$GATEWAY_NAME" ]; then
    echo "ERROR: Could not uniquely determine the openshell cluster container for gateway '$GATEWAY_NAME'."
  else
    echo "ERROR: Could not uniquely determine the openshell cluster container."
  fi
  exit 1
fi

CONTAINER_RESOLV_CONF="$(docker exec "$CLUSTER" cat /etc/resolv.conf 2>/dev/null || true)"
HOST_RESOLV_CONF="$(cat /etc/resolv.conf 2>/dev/null || true)"
UPSTREAM_DNS="$(resolve_coredns_upstream "$CONTAINER_RESOLV_CONF" "$HOST_RESOLV_CONF" "$DETECTED_RUNTIME" || true)"

if [ -z "$UPSTREAM_DNS" ]; then
  echo "ERROR: Could not determine a non-loopback DNS upstream for $DETECTED_RUNTIME."
  exit 1
fi

# Defense-in-depth: reject values with characters that are never valid in
# an IP address or DNS hostname.  The real injection fix is the jq-based
# JSON construction below — this just catches obvious garbage early.
if ! printf '%s' "$UPSTREAM_DNS" | grep -qE '^[a-zA-Z0-9.:_-]+$'; then
  echo "ERROR: UPSTREAM_DNS='$UPSTREAM_DNS' contains invalid characters. Aborting."
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to safely construct the kubectl patch payload."
  exit 1
fi

echo "Patching CoreDNS to forward to $UPSTREAM_DNS..."

# Build the Corefile as a plain string, then let jq handle all JSON
# escaping (CWE-78, NVBUG 6009988).  This avoids interpolating
# UPSTREAM_DNS into a shell-constructed JSON/string literal.
read -r -d '' COREFILE <<COREFILE_EOF || true
.:53 {
    errors
    health
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
      pods insecure
      fallthrough in-addr.arpa ip6.arpa
    }
    hosts /etc/coredns/NodeHosts {
      ttl 60
      reload 15s
      fallthrough
    }
    prometheus :9153
    cache 30
    loop
    reload
    loadbalance
    forward . ${UPSTREAM_DNS}
}
COREFILE_EOF

PATCH_JSON="$(jq -n --arg corefile "$COREFILE" '{"data":{"Corefile":$corefile}}')"

docker exec "$CLUSTER" kubectl patch configmap coredns -n kube-system \
  --type merge -p "$PATCH_JSON" >/dev/null

docker exec "$CLUSTER" kubectl rollout restart deploy/coredns -n kube-system >/dev/null

echo "CoreDNS patched. Waiting for rollout..."
docker exec "$CLUSTER" kubectl rollout status deploy/coredns -n kube-system --timeout=30s >/dev/null

echo "Done. DNS should resolve in ~10 seconds."
