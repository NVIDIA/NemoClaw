#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Fix inference.local DNS resolution inside k3s sandbox pods on macOS.
#
# Problem: On macOS (Docker Desktop / Colima), inference.local does not
# resolve inside sandbox pods. The OpenShell gateway on Linux injects
# this hostname into k3s CoreDNS automatically, but on macOS this step
# is skipped, causing sandbox pods to fail when reaching the inference
# proxy at https://inference.local/v1.
#
# Fix: Patch the CoreDNS Corefile configmap to add an inline hosts entry
# for inference.local, pointing to the Traefik ingress ClusterIP (which
# proxies inference requests through the OpenShell provider routing).
#
# See: https://github.com/NVIDIA/NemoClaw/issues/260
#
# Usage: ./scripts/fix-inference-dns-macos.sh [gateway-name]

set -euo pipefail

GATEWAY_NAME="${1:-nemoclaw}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib/runtime.sh
. "$SCRIPT_DIR/lib/runtime.sh"

# Only needed on macOS
if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

# Find the openshell cluster container
CLUSTERS="$(docker ps --filter "name=openshell-cluster" --format '{{.Names}}' 2>/dev/null || true)"
CLUSTER="$(select_openshell_cluster_container "$GATEWAY_NAME" "$CLUSTERS" || true)"
if [ -z "$CLUSTER" ]; then
  echo "WARN: Could not find openshell cluster container. Skipping inference.local DNS fix."
  exit 0
fi

# Get current CoreDNS Corefile from the configmap
COREFILE="$(docker exec "$CLUSTER" kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}' 2>/dev/null || true)"
if [ -z "$COREFILE" ]; then
  echo "WARN: Could not read CoreDNS Corefile. Skipping inference.local DNS fix."
  exit 0
fi

# Check if inference.local is already configured
if echo "$COREFILE" | grep -q 'inference\.local'; then
  echo "inference.local already in CoreDNS config."
  exit 0
fi

# Determine target IP for inference.local.
# Try Traefik service ClusterIP first (k3s default ingress controller that
# handles inference routing), then fall back to the k3s node internal IP.
TARGET_IP="$(docker exec "$CLUSTER" kubectl get svc traefik -n kube-system -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
if [ -z "$TARGET_IP" ]; then
  TARGET_IP="$(docker exec "$CLUSTER" kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)"
fi
if [ -z "$TARGET_IP" ]; then
  echo "WARN: Could not determine target IP for inference.local. DNS fix skipped."
  exit 0
fi

# Strict IPv4 validation — reject out-of-range octets and unexpected output
if ! echo "$TARGET_IP" | grep -qE '^((25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})$'; then
  echo "WARN: Invalid IP format '$TARGET_IP'. DNS fix skipped."
  exit 0
fi

echo "Patching CoreDNS: inference.local -> $TARGET_IP"

# Inject inference.local into the hosts block of the Corefile as an inline
# entry. CoreDNS processes inline entries alongside the hosts file.
export TARGET_IP
PATCHED_COREFILE="$(python3 -c "
import sys, os
corefile = sys.stdin.read()
target_ip = os.environ['TARGET_IP']
marker = 'hosts /etc/coredns/NodeHosts {'
if marker in corefile:
    corefile = corefile.replace(
        marker,
        marker + '\n      ' + target_ip + ' inference.local'
    )
else:
    # No NodeHosts block found — inject a standalone hosts block before
    # the forward directive so inference.local still resolves.
    inject = '    hosts {\n      ' + target_ip + ' inference.local\n      fallthrough\n    }\n'
    if 'forward .' in corefile:
        corefile = corefile.replace('    forward .', inject + '    forward .')
    else:
        # Last resort: append before closing brace
        corefile = corefile.rstrip().rstrip('}') + inject + '}\n'
print(corefile, end='')
" <<< "$COREFILE")"

# Build JSON patch with proper escaping
PATCH_JSON="$(python3 -c "
import json, sys
corefile = sys.stdin.read()
print(json.dumps({'data': {'Corefile': corefile}}))
" <<< "$PATCHED_COREFILE")"

docker exec "$CLUSTER" kubectl patch configmap coredns -n kube-system --type merge -p "$PATCH_JSON" > /dev/null

# Restart CoreDNS to pick up the change immediately (otherwise reload is 15s)
docker exec "$CLUSTER" kubectl rollout restart deploy/coredns -n kube-system > /dev/null 2>&1 || true
docker exec "$CLUSTER" kubectl rollout status deploy/coredns -n kube-system --timeout=30s > /dev/null 2>&1 || true

echo "Done: inference.local -> $TARGET_IP"
