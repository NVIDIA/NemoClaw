#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

target_dir="${1:-}"

if [ -z "$target_dir" ]; then
  echo "usage: $0 <directory>" >&2
  exit 1
fi

rm -rf "$target_dir/.venv" "$target_dir/.pytest_cache"
find "$target_dir" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
