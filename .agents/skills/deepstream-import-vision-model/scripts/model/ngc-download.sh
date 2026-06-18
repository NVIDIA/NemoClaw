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

# ngc-download.sh — Download all files from a public NGC model version.
# Prefers the official `ngc` CLI. Falls back to authenticated HTTPS via curl
# only when the CLI is not installed; the fallback is explicitly warned about.
#
# Usage:
#   bash ngc-download.sh <NGC_ORG> <NGC_TEAM> <MODEL_NAME> <NGC_VERSION> <DEST_DIR>
#
# Example:
#   bash ngc-download.sh nvidia tao peoplenet trainable_v2.6 models/peoplenet/ngc_download
set -euo pipefail

NGC_ORG="${1:-}"
NGC_TEAM="${2:-}"
MODEL_NAME="${3:-}"
NGC_VERSION="${4:-}"
DEST_DIR="${5:-}"

if [[ -z "$NGC_ORG" || -z "$MODEL_NAME" || -z "$NGC_VERSION" || -z "$DEST_DIR" ]]; then
    echo "Usage: $0 <NGC_ORG> <NGC_TEAM> <MODEL_NAME> <NGC_VERSION> <DEST_DIR>" >&2
    echo "  NGC_TEAM may be empty-string if the model has no team segment." >&2
    exit 1
fi

for var in NGC_ORG MODEL_NAME NGC_VERSION; do
    val="${!var}"
    if ! [[ "$val" =~ ^[A-Za-z0-9._-]+$ ]]; then
        echo "ERROR: $var contains invalid characters: $val" >&2
        exit 1
    fi
done
if [[ -n "$NGC_TEAM" ]] && ! [[ "$NGC_TEAM" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "ERROR: NGC_TEAM contains invalid characters: $NGC_TEAM" >&2
    exit 1
fi

case "$DEST_DIR" in
    ""|"/"|*..*)
        echo "ERROR: invalid DEST_DIR: $DEST_DIR" >&2
        exit 1
        ;;
esac

mkdir -p "$DEST_DIR"

# Preferred: ngc CLI (authenticated, verified)
if command -v ngc >/dev/null 2>&1 && ngc --version >/dev/null 2>&1; then
    if [[ -n "$NGC_TEAM" ]]; then
        SPEC="${NGC_ORG}/${NGC_TEAM}/${MODEL_NAME}:${NGC_VERSION}"
    else
        SPEC="${NGC_ORG}/${MODEL_NAME}:${NGC_VERSION}"
    fi
    echo "Using ngc CLI to download $SPEC -> $DEST_DIR"
    ngc registry model download-version "$SPEC" --dest "$DEST_DIR"
    exit 0
fi

# Fallback: HTTPS via curl, public NGC catalog API only
echo "WARNING: ngc CLI not available — falling back to unauthenticated HTTPS for public files." >&2
echo "  For gated/private models, install the ngc CLI: https://ngc.nvidia.com/setup/installers/cli" >&2

if [[ -n "$NGC_TEAM" ]]; then
    NGC_BASE="https://api.ngc.nvidia.com/v2/models/${NGC_ORG}/${NGC_TEAM}/${MODEL_NAME}/versions/${NGC_VERSION}/files"
else
    NGC_BASE="https://api.ngc.nvidia.com/v2/models/${NGC_ORG}/${MODEL_NAME}/versions/${NGC_VERSION}/files"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FILES="$("$SCRIPT_DIR/ngc-list-files.sh" "$NGC_ORG" "$NGC_TEAM" "$MODEL_NAME" "$NGC_VERSION")"

if [[ -z "$FILES" ]]; then
    echo "ERROR: No files returned from NGC catalog" >&2
    exit 1
fi

echo "NGC files available:"
echo "$FILES"

while IFS= read -r FNAME; do
    [[ -z "$FNAME" ]] && continue
    # Skip anything with traversal characters
    case "$FNAME" in
        */..*|..*|*..|/*)
            echo "  skipping suspicious filename: $FNAME"
            continue
            ;;
    esac
    DEST_PATH="$DEST_DIR/$FNAME"
    mkdir -p "$(dirname "$DEST_PATH")"
    echo "Downloading: $FNAME"
    if ! curl -fsSL --proto '=https' --tlsv1.2 --max-time 600 \
             -o "$DEST_PATH" "${NGC_BASE}/${FNAME}"; then
        echo "  WARNING: failed to download $FNAME — skipping"
    fi
done <<< "$FILES"

echo "Done. Files in $DEST_DIR:"
ls -lh "$DEST_DIR" 2>/dev/null || true
