#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if (($# != 3)); then
  printf 'usage: %s <source-directory> <asset> <destination-directory>\n' "$0" >&2
  exit 64
fi

source_directory="$1"
asset="$2"
destination_directory="$3"

case "$asset" in
  "" | /* | . | .. | */*)
    printf 'Unsafe retained OpenShell asset name: %s\n' "$asset" >&2
    exit 64
    ;;
esac

source_asset="${source_directory}/${asset}"
destination_asset="${destination_directory}/${asset}"
if [[ "$source_directory" != /* || ! -d "$source_directory" || -L "$source_directory" || ! -f "$source_asset" || -L "$source_asset" || "$destination_directory" != /* || ! -d "$destination_directory" || -L "$destination_directory" || -e "$destination_asset" || -L "$destination_asset" ]]; then
  printf 'Unsafe retained OpenShell asset path: %s\n' "$asset" >&2
  exit 64
fi

cp -- "$source_asset" "$destination_asset"
