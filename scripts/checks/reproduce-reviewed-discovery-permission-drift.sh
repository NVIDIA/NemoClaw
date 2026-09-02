#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

reviewed_root="${1:-tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery}"
for artifact in \
  BUNDLED_PACKAGES.json \
  THIRD_PARTY_LICENSES.txt \
  mcp-tool-discovery.bundle; do
  artifact_path="${reviewed_root}/${artifact}"
  if [ ! -f "$artifact_path" ] || [ -L "$artifact_path" ]; then
    echo "ERROR: reviewed discovery permission fixture must be a regular non-symlink: ${artifact_path}" >&2
    exit 1
  fi
  chmod 0664 "$artifact_path"
done
