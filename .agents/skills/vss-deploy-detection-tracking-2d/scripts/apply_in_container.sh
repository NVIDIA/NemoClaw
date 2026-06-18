#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# apply_in_container.sh copies and invokes the in-container configuration helper.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# apply_in_container.sh — Step 4 host-side wrapper.
#
# Replaces FOUR chained docker calls (refresh scripts + chmod + ls
# config dirs + apply_config.sh) with ONE host-side script invocation
# so the user only sees one permission prompt for all of Step 4.
#
# Usage:
#   apply_in_container.sh --container <name> [apply_config.sh args...]
#
# Required args (forwarded to apply_config.sh):
#   --usecase <warehouse-2d|warehouse-3d|smartcity-rtdetr|smartcity-gdino>
#   --batch <N>
#   --sink <fakesink|eglsink|filedump>
#   --stream-mode <dynamic|static>
#   --onnx <container-onnx-path>      (optional — apply_config.sh auto-discovers if omitted)
#   --videos <container-videos-dir>   (optional — same)
#   --force-rebuild                   (optional — bypass engine cache)
#
# Wrapper-specific:
#   --container <name>                (default: rtvicv-perception-docker)
#   --skill-dir <path>                (default: $HOME/.claude/skills/vss-deploy-detection-tracking-2d)
#
# Exits with apply_config.sh's exit code. Forwards stdout + stderr.

set -euo pipefail

CONTAINER="${CONTAINER:-rtvicv-perception-docker}"
SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/vss-deploy-detection-tracking-2d}"

# Strip wrapper-specific flags; everything else goes through to apply_config.sh.
PASSTHROUGH=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --container) CONTAINER="$2"; shift 2 ;;
        --skill-dir) SKILL_DIR="$2"; shift 2 ;;
        -h|--help)   sed -n '18,40p' "$0"; exit 0 ;;   # skip SPDX header; full usage block
        *)           PASSTHROUGH+=("$1"); shift ;;
    esac
done

[[ -d "$SKILL_DIR/scripts" ]] || { echo "✖ scripts dir not found at $SKILL_DIR/scripts" >&2; exit 1; }
[[ -x "$SKILL_DIR/scripts/apply_config.sh" ]] \
    || { echo "✖ apply_config.sh not executable in $SKILL_DIR/scripts" >&2; exit 1; }
docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}' | grep -qx "$CONTAINER" \
    || { echo "✖ container $CONTAINER not running (docker ps)" >&2; exit 1; }

echo "→ apply_in_container: refresh scripts in $CONTAINER, then run apply_config.sh"

# 1. Refresh scripts inside container — `rm -rf /tmp/scripts` first
#    avoids the docker cp nesting bug (`/tmp/scripts/scripts/`) when
#    /tmp/scripts already exists from a prior session.
docker exec "$CONTAINER" rm -rf /tmp/scripts
docker cp   "$SKILL_DIR/scripts" "$CONTAINER:/tmp/"
docker exec "$CONTAINER" chmod -R +x /tmp/scripts/

# 2. Run apply_config.sh inside the container with all forwarded args.
#    apply_config.sh handles 4.a–4.f internally (one permission prompt).
exec docker exec "$CONTAINER" /tmp/scripts/apply_config.sh "${PASSTHROUGH[@]}"
