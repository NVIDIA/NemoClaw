#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Fix CoreDNS on local OpenShell gateways running under Colima.
#
# Problem: k3s CoreDNS forwards to /etc/resolv.conf which inside the
# CoreDNS pod resolves to 127.0.0.11 (Docker's embedded DNS). That
# address is NOT reachable from k3s pods, causing DNS to fail and
# CoreDNS to CrashLoop.
#
# Fix: forward CoreDNS to the container's default gateway IP, which
# is reachable from pods and routes DNS through Docker to the host.
#
# Run this after `openshell gateway start` on Colima setups.
#
# Usage: ./scripts/fix-coredns.sh [gateway-name]

set -euo pipefail

GATEWAY_NAME="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib/runtime.sh
. "$SCRIPT_DIR/lib/runtime.sh"

COLIMA_SOCKET="$(find_colima_docker_socket || true)"

if [ -z "${DOCKER_HOST:-}" ]; then
  if [ -n "$COLIMA_SOCKET" ]; then
    export DOCKER_HOST="unix://$COLIMA_SOCKET"
  else
    echo "Skipping CoreDNS patch: Colima socket not found."
    exit 0
  fi
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
UPSTREAM_DNS="$(resolve_coredns_upstream "$CONTAINER_RESOLV_CONF" "$HOST_RESOLV_CONF" "colima" || true)"

if [ -z "$UPSTREAM_DNS" ]; then
  echo "ERROR: Could not determine a non-loopback DNS upstream for Colima."
  exit 1
fi

echo "Patching CoreDNS to forward to $UPSTREAM_DNS..."

docker exec "$CLUSTER" kubectl patch configmap coredns -n kube-system --type merge -p "{\"data\":{\"Corefile\":\".:53 {\\n    errors\\n    health\\n    ready\\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\\n      pods insecure\\n      fallthrough in-addr.arpa ip6.arpa\\n    }\\n    hosts /etc/coredns/NodeHosts {\\n      ttl 60\\n      reload 15s\\n      fallthrough\\n    }\\n    prometheus :9153\\n    cache 30\\n    loop\\n    reload\\n    loadbalance\\n    forward . $UPSTREAM_DNS\\n}\\n\"}}" > /dev/null

docker exec "$CLUSTER" kubectl rollout restart deploy/coredns -n kube-system > /dev/null

echo "CoreDNS patched. Waiting for rollout..."
docker exec "$CLUSTER" kubectl rollout status deploy/coredns -n kube-system --timeout=30s > /dev/null

echo "Done. DNS should resolve in ~10 seconds."
