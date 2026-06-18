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

# ngc-list-files.sh — List files in a public NGC model version.
# Safer replacement for the inline curl+python snippet.
#
# Usage:
#   bash ngc-list-files.sh <NGC_ORG> <NGC_TEAM> <MODEL_NAME> <NGC_VERSION>
#
# Example:
#   bash ngc-list-files.sh nvidia tao peoplenet trainable_v2.6
#
# Output: one filename per line.
set -euo pipefail

NGC_ORG="${1:-}"
NGC_TEAM="${2:-}"
MODEL_NAME="${3:-}"
NGC_VERSION="${4:-}"

if [[ -z "$NGC_ORG" || -z "$MODEL_NAME" || -z "$NGC_VERSION" ]]; then
    echo "Usage: $0 <NGC_ORG> <NGC_TEAM> <MODEL_NAME> <NGC_VERSION>" >&2
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

if [[ -n "$NGC_TEAM" ]]; then
    NGC_BASE="https://api.ngc.nvidia.com/v2/models/${NGC_ORG}/${NGC_TEAM}/${MODEL_NAME}/versions/${NGC_VERSION}/files"
else
    NGC_BASE="https://api.ngc.nvidia.com/v2/models/${NGC_ORG}/${MODEL_NAME}/versions/${NGC_VERSION}/files"
fi

JSON="$(curl -fsSL --proto '=https' --tlsv1.2 --max-time 30 "${NGC_BASE}/" 2>/dev/null || true)"

if [[ -z "$JSON" ]]; then
    echo "ERROR: Could not retrieve file list from NGC API" >&2
    echo "URL: ${NGC_BASE}/" >&2
    exit 1
fi

python3 - "$JSON" <<'PYEOF'
import json, sys
data = sys.argv[1]
try:
    files = json.loads(data)
except json.JSONDecodeError as e:
    print(f"ERROR parsing NGC file list: {e}", file=sys.stderr)
    sys.exit(1)
if isinstance(files, list):
    names = [f.get("name", "") for f in files if isinstance(f, dict)]
else:
    names = [f.get("name", "") for f in files.get("modelFiles", []) if isinstance(f, dict)]
for n in names:
    if n:
        print(n)
PYEOF
