#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# check_container_gpu.sh verifies that a running container still sees the GPU.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# check_container_gpu.sh — verify CUDA / NVML access inside a running container.
#
# Long-lived containers can lose their GPU handle silently after a host
# driver service restart or runtime drift (cgroup re-mount, CDI re-init,
# etc.). The container itself stays "Up" in `docker ps`, but
# `nvidia-smi` and CUDA initialisation fail inside it with
# `NVML: Unknown Error` / `Cuda failure: status=100`. The deepest the
# perception app gets in this state is a few `NvBufSurfaceGetDeviceInfoImpl`
# log lines before exiting in PAUSED.
#
# This probe lets the Step 3 reuse decision detect the situation in
# ~0.5 s, BEFORE config-apply / app-launch, and steer the user to
# "Restart fresh" instead.
#
# Usage:
#   check_container_gpu.sh --container <name>
#
# Exit codes:
#   0  GPU visible inside the container — reuse is safe to proceed
#   1  invalid args / container not running
#   2  GPU NOT visible — container has stale GPU handle, recommend restart
#
# Output markers (parseable by the skill):
#   GPU_OK <container> <gpu-id>=<name>
#   GPU_STALE <container> — NVML init failed (stale GPU handle); restart container

set -euo pipefail

CONTAINER=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --container) CONTAINER="$2"; shift 2 ;;
        -h|--help)   sed -n '18,40p' "$0"; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

[[ -n "$CONTAINER" ]] || { echo "✖ --container is required" >&2; exit 1; }

docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}' | grep -qx "$CONTAINER" \
    || { echo "✖ container $CONTAINER not running (docker ps)" >&2; exit 1; }

# Probe with nvidia-smi -L (lightweight: queries NVML, no work submitted).
# Capture both stdout and stderr — when NVML init fails, the error goes
# to stderr ("Failed to initialize NVML: Unknown Error") and nothing
# reaches stdout. Any non-zero exit or empty stdout means the container
# can't see the GPU.
SMI_OUT=$(docker exec "$CONTAINER" nvidia-smi -L 2>&1) && SMI_RC=0 || SMI_RC=$?

if [[ $SMI_RC -eq 0 && -n "$SMI_OUT" ]] && echo "$SMI_OUT" | grep -q '^GPU '; then
    # Print the first GPU line as the OK marker (typical form:
    # "GPU 0: NVIDIA GeForce RTX 3050 (UUID: GPU-xxxx)").
    FIRST=$(echo "$SMI_OUT" | grep -m1 '^GPU ')
    echo "✔ Container $CONTAINER has GPU access: $FIRST"
    echo "GPU_OK $CONTAINER $FIRST"
    exit 0
fi

# GPU not visible — print the failure mode the agent should surface.
echo "✖ Container $CONTAINER cannot access the GPU (NVML init failed)." >&2
echo "  nvidia-smi -L output:" >&2
echo "$SMI_OUT" | sed 's/^/    /' >&2
echo "  Likely cause: host driver service restarted since the container was created," >&2
echo "  or the NVIDIA Container Toolkit state drifted. Restart the container fresh." >&2
echo "GPU_STALE $CONTAINER — NVML init failed (stale GPU handle); restart container"
exit 2
