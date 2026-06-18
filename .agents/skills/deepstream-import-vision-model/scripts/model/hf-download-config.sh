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

# hf-download-config.sh — Download config.json from a HuggingFace repo.
# Safer replacement for the inline `curl -fsSL ... -o ...` snippet.
#
# Usage:
#   bash hf-download-config.sh <HF_ORG> <MODEL_NAME> <DEST_PATH>
#
# Example:
#   bash hf-download-config.sh onnx-community yolov8n models/yolov8n/config/config.json
#
# Honors $HF_TOKEN if set.
set -euo pipefail

HF_ORG="${1:-}"
MODEL_NAME="${2:-}"
DEST="${3:-}"

if [[ -z "$HF_ORG" || -z "$MODEL_NAME" || -z "$DEST" ]]; then
    echo "Usage: $0 <HF_ORG> <MODEL_NAME> <DEST_PATH>" >&2
    exit 1
fi

for arg_name in HF_ORG MODEL_NAME; do
    val="${!arg_name}"
    if ! [[ "$val" =~ ^[A-Za-z0-9._/-]+$ ]]; then
        echo "ERROR: $arg_name contains invalid characters: $val" >&2
        exit 1
    fi
done

# DEST must be a relative path and must not contain .. segments
# (prevents writes outside the project tree)
case "$DEST" in
    /*)
        echo "ERROR: DEST_PATH must be relative (absolute paths are rejected): $DEST" >&2
        exit 1
        ;;
    *..*)
        echo "ERROR: DEST_PATH contains '..' — refusing: $DEST" >&2
        exit 1
        ;;
esac

URL="https://huggingface.co/${HF_ORG}/${MODEL_NAME}/resolve/main/config.json"

CURL_OPTS=(-fsSL --proto '=https' --tlsv1.2 --max-time 60 -o "$DEST")
if [[ -n "${HF_TOKEN:-}" ]]; then
    CURL_OPTS+=(-H "Authorization: Bearer ${HF_TOKEN}")
fi

mkdir -p "$(dirname "$DEST")"

if ! curl "${CURL_OPTS[@]}" "$URL"; then
    echo "ERROR: config.json not found at ${HF_ORG}/${MODEL_NAME} — cannot extract labels" >&2
    exit 1
fi

echo "Downloaded: $DEST"
