#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Fix CoreDNS on local OpenShell gateways.
#
# Problem: k3s CoreDNS forwards to /etc/resolv.conf which inside the
# CoreDNS pod resolves to a loopback address (127.0.0.11 on Docker,
# 127.0.0.53 on systemd-resolved hosts). That address is NOT reachable
# from k3s pods, causing DNS to fail and CoreDNS to CrashLoop.
#
# Fix: forward CoreDNS to a real upstream DNS server, discovered from
# the container's resolv.conf, the host's resolv.conf, or
# systemd-resolved's actual upstream.
#
# Run this after `openshell gateway start` on any Docker-based setup.
#
# Usage: ./scripts/fix-coredns.sh [gateway-name]

set -euo pipefail

GATEWAY_NAME="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib/runtime.sh
. "$SCRIPT_DIR/lib/runtime.sh"

if [ -z "${DOCKER_HOST:-}" ]; then
  if docker_host="$(detect_docker_host)"; then
    export DOCKER_HOST="$docker_host"
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

# Detect the container runtime so resolve_coredns_upstream can use
# runtime-specific fallbacks (e.g. Colima VM nameserver).
RUNTIME="unknown"
if command -v colima >/dev/null 2>&1 && [[ "${DOCKER_HOST:-}" == *colima* ]]; then
  RUNTIME="colima"
fi
UPSTREAM_DNS="$(resolve_coredns_upstream "$CONTAINER_RESOLV_CONF" "$HOST_RESOLV_CONF" "$RUNTIME" || true)"

# If all resolv.conf sources returned loopback only (common on systemd-resolved
# hosts where /etc/resolv.conf is 127.0.0.53), try resolvectl for real upstreams.
if [ -z "$UPSTREAM_DNS" ] && command -v resolvectl >/dev/null 2>&1; then
  UPSTREAM_DNS="$(resolvectl status 2>/dev/null \
    | awk '/Current DNS Server:/ { print $NF; exit }')"
fi

if [ -z "$UPSTREAM_DNS" ]; then
  echo "WARNING: Could not determine a non-loopback DNS upstream. Falling back to 8.8.8.8."
  UPSTREAM_DNS="8.8.8.8"
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
