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
COLIMA_SOCKET="$HOME/.colima/default/docker.sock"

if [ -z "${DOCKER_HOST:-}" ]; then
  if [ -S "$COLIMA_SOCKET" ]; then
    export DOCKER_HOST="unix://$COLIMA_SOCKET"
  else
    echo "Skipping CoreDNS patch: Colima socket not found at $COLIMA_SOCKET."
    exit 0
  fi
fi

# Find the cluster container
CLUSTER=$(docker ps --filter "name=openshell-cluster" --format '{{.Names}}' | head -1)
if [ -z "$CLUSTER" ]; then
  echo "ERROR: No openshell cluster container found."
  exit 1
fi

# Get the container's upstream DNS from /etc/resolv.conf — this is the address
# the Docker/Colima VM uses for DNS and is reachable from k3s pods.
# The docker bridge gateway (172.17.0.1) does NOT serve DNS in Colima.
GATEWAY_IP=$(docker exec "$CLUSTER" grep nameserver /etc/resolv.conf | head -1 | awk '{print $2}')
if [ -z "$GATEWAY_IP" ]; then
  echo "ERROR: Could not determine container gateway IP."
  exit 1
fi

# Sanity check: don't use 127.x.x.x — it won't work from pods
if [[ "$GATEWAY_IP" == 127.* ]]; then
  echo "ERROR: Gateway IP is $GATEWAY_IP (loopback). Cannot use from k3s pods."
  echo "Falling back to public DNS (8.8.8.8)."
  GATEWAY_IP="8.8.8.8"
fi

echo "Patching CoreDNS to forward to $GATEWAY_IP..."

docker exec "$CLUSTER" kubectl patch configmap coredns -n kube-system --type merge -p "{\"data\":{\"Corefile\":\".:53 {\\n    errors\\n    health\\n    ready\\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\\n      pods insecure\\n      fallthrough in-addr.arpa ip6.arpa\\n    }\\n    hosts /etc/coredns/NodeHosts {\\n      ttl 60\\n      reload 15s\\n      fallthrough\\n    }\\n    prometheus :9153\\n    cache 30\\n    loop\\n    reload\\n    loadbalance\\n    forward . $GATEWAY_IP\\n}\\n\"}}" > /dev/null

docker exec "$CLUSTER" kubectl rollout restart deploy/coredns -n kube-system > /dev/null

echo "CoreDNS patched. Waiting for rollout..."
docker exec "$CLUSTER" kubectl rollout status deploy/coredns -n kube-system --timeout=30s > /dev/null

echo "Done. DNS should resolve in ~10 seconds."
