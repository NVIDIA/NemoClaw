#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Patch the OpenShell gateway image to use iptables-legacy.
#
# On Jetson devices the kernel lacks nf_tables NAT modules, so the
# container's default iptables-nft binary fails. This script rebuilds
# the gateway image with a single extra layer that symlinks iptables
# to iptables-legacy, then tags the result with the same image name so
# the next `openshell gateway start` picks it up from the local cache.
#
# Run this after an initial `openshell gateway start` that crashed
# because of the missing nf_tables modules.
#
# Usage: ./scripts/fix-iptables-jetson.sh [gateway-name]

set -euo pipefail

GATEWAY_NAME="${1:-nemoclaw}"
CONTAINER="openshell-cluster-${GATEWAY_NAME}"

# ── 1. Locate the crashed container and its image ────────────────

IMAGE=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)

if [ -z "$IMAGE" ]; then
  echo "  ERROR: Could not find gateway container '$CONTAINER'."
  echo "  Has 'openshell gateway start' been run at least once?"
  exit 1
fi

echo "  Patching image '${IMAGE}' to use iptables-legacy..."

# ── 2. Build a patched image on top of the original ──────────────
#
# The single RUN layer checks whether iptables-legacy exists inside
# the image and, if so, points the default iptables symlinks to it.
# If iptables-legacy is not present, the build still succeeds (the
# `|| true` ensures the layer is a no-op).

docker build -q -t "$IMAGE" --build-arg BASE="$IMAGE" - <<'DOCKERFILE'
ARG BASE
FROM ${BASE}
RUN set -e; \
    if [ -x /usr/sbin/iptables-legacy ]; then \
      ln -sf /usr/sbin/iptables-legacy /usr/sbin/iptables; \
      ln -sf /usr/sbin/ip6tables-legacy /usr/sbin/ip6tables; \
    elif command -v update-alternatives >/dev/null 2>&1; then \
      update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null || true; \
      update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null || true; \
    fi
DOCKERFILE

echo "  ✓ Image patched with iptables-legacy"
