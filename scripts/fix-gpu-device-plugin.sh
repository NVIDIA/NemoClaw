#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# fix-gpu-device-plugin.sh
#
# Patches the nvidia-device-plugin HelmChart in the gateway's k3s cluster
# to use a direct chart URL instead of the dead GitHub Pages Helm repo.
#
# The old repo URL (https://nvidia.github.io/k8s-device-plugin) returns 404,
# preventing GPU device plugin installation on GPU-enabled gateways.
#
# See: https://github.com/NVIDIA/NemoClaw/issues/241
#
# Usage:
#   ./scripts/fix-gpu-device-plugin.sh
#
# Prerequisites:
#   - openshell CLI on PATH
#   - A running gateway with GPU support

set -euo pipefail

CHART_VERSION="0.18.2"
CHART_URL="https://github.com/NVIDIA/k8s-device-plugin/releases/download/v${CHART_VERSION}/nvidia-device-plugin-${CHART_VERSION}.tgz"
CHART_TGZ="$(mktemp -t "nvidia-device-plugin-${CHART_VERSION}.XXXXXX.tgz")"
trap 'rm -f "$CHART_TGZ"' EXIT

echo "Downloading nvidia-device-plugin chart v${CHART_VERSION}..."
if ! curl -sfL "$CHART_URL" -o "$CHART_TGZ"; then
  echo "✗ Failed to download chart from ${CHART_URL}"
  exit 1
fi

# Verify the download produced a non-empty file
if [ ! -s "$CHART_TGZ" ]; then
  echo "✗ Downloaded chart file is empty"
  exit 1
fi

echo "Encoding chart..."
CHART_B64=$(base64 -w0 "$CHART_TGZ" 2>/dev/null || base64 "$CHART_TGZ" | tr -d '\n')

echo "Patching HelmChart in gateway cluster..."
if ! openshell doctor exec -- kubectl patch helmchart nvidia-device-plugin \
  -n kube-system \
  --type merge \
  --patch "{\"spec\":{\"chartContent\":\"${CHART_B64}\",\"repo\":\"\"}}"; then
  echo "✗ Failed to patch HelmChart — is the gateway running with GPU support?"
  exit 1
fi

# Wait for device plugin to come up
echo "Waiting for device plugin pods..."
for i in $(seq 1 30); do
  status=$(openshell doctor exec -- kubectl get pods -n nvidia-device-plugin -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "Pending")
  if [ "$status" = "Running" ]; then
    echo "✓ nvidia-device-plugin is running"
    exit 0
  fi
  sleep 2
done

echo "⚠ Device plugin did not reach Running state within 60s."
echo "  Check: openshell doctor exec -- kubectl get pods -A | grep nvidia"
exit 1
