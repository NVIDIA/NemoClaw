#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# cleanup.sh — Remove build/models artifacts for a given model name.
# Validated replacement for ad-hoc directory removal after ONNX export.
#
# Only removes paths that:
#   - are non-empty
#   - exist
#   - resolve under ./build/ or ./models/
#   - match the given MODEL_NAME (regex-validated)
#
# Usage:
#   bash cleanup.sh <MODEL_NAME> [--dry-run]
#
# Example:
#   bash cleanup.sh yolov8n
#   bash cleanup.sh yolov8n --dry-run
set -euo pipefail

MODEL_NAME="${1:-}"
DRY_RUN=false
if [[ "${2:-}" == "--dry-run" ]]; then
    DRY_RUN=true
fi

if [[ -z "$MODEL_NAME" ]]; then
    echo "Usage: $0 <MODEL_NAME> [--dry-run]" >&2
    exit 1
fi

if ! [[ "$MODEL_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "ERROR: MODEL_NAME must match ^[A-Za-z0-9._-]+$ (got: $MODEL_NAME)" >&2
    exit 1
fi

# The regex above accepts "." and ".." — reject them explicitly since those
# would make the candidate paths (build/.venv_$MODEL_NAME, models/$MODEL_NAME/*)
# point at directories we don't own.
if [[ "$MODEL_NAME" == "." || "$MODEL_NAME" == ".." ]]; then
    echo "ERROR: MODEL_NAME cannot be '.' or '..' (got: $MODEL_NAME)" >&2
    exit 1
fi

CWD="$(pwd -P)"

# Paths eligible for removal — all are scoped under CWD's build/ or models/
CANDIDATES=(
    "build/.venv_${MODEL_NAME}"
    "models/${MODEL_NAME}/hf_model"
    "models/${MODEL_NAME}/onnx_export"
)

echo "=== cleanup.sh — MODEL_NAME=$MODEL_NAME dry-run=$DRY_RUN ==="
for rel in "${CANDIDATES[@]}"; do
    abs="$CWD/$rel"
    if [[ ! -e "$abs" ]]; then
        echo "  skip (not present): $rel"
        continue
    fi

    # Assert the resolved path is still under CWD's build/ or models/
    resolved="$(cd "$(dirname "$abs")" && pwd -P)/$(basename "$abs")"
    case "$resolved" in
        "$CWD"/build/*|"$CWD"/models/*) ;;
        *)
            echo "  SKIP (outside build/ or models/): $resolved"
            continue
            ;;
    esac

    if $DRY_RUN; then
        echo "  [dry-run] rm -rf $resolved"
    else
        echo "  removing: $resolved"
        rm -rf -- "$resolved"
    fi
done

echo "Done."
