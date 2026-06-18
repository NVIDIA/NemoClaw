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

# hf-list-files.sh — List model files in a HuggingFace repo.
# Uses the HF tree API with validated inputs, HTTPS+TLSv1.2, and a bounded
# timeout. Parses the JSON response via the stdlib json module (no shell pipe).
#
# Usage:
#   bash hf-list-files.sh <HF_ORG> <MODEL_NAME> [subpath]
#
# Examples:
#   bash hf-list-files.sh onnx-community yolov8n
#   bash hf-list-files.sh onnx-community yolov8n onnx        # check /onnx subdir
#
# Honors $HF_TOKEN if set (passed as Authorization: Bearer header).
set -euo pipefail

HF_ORG="${1:-}"
MODEL_NAME="${2:-}"
SUBPATH="${3:-}"

if [[ -z "$HF_ORG" || -z "$MODEL_NAME" ]]; then
    echo "Usage: $0 <HF_ORG> <MODEL_NAME> [subpath]" >&2
    exit 1
fi

# Input validation — reject anything that could escape the URL
for arg_name in HF_ORG MODEL_NAME SUBPATH; do
    val="${!arg_name:-}"
    if [[ -n "$val" ]] && ! [[ "$val" =~ ^[A-Za-z0-9._/-]+$ ]]; then
        echo "ERROR: $arg_name contains invalid characters (must match ^[A-Za-z0-9._/-]+\$): $val" >&2
        exit 1
    fi
done

URL="https://huggingface.co/api/models/${HF_ORG}/${MODEL_NAME}/tree/main"
[[ -n "$SUBPATH" ]] && URL="${URL}/${SUBPATH}"

# -sS: silent progress but still surface errors on stderr
# -w "%{http_code}": append HTTP status as the last 3 chars of the response body
# Drop -f so curl doesn't exit non-zero on 4xx — we inspect the status ourselves
# so 404 (missing subpath) can be distinguished from network/auth failures.
CURL_OPTS=(-sS --proto '=https' --tlsv1.2 --max-time 30 -w '%{http_code}')
if [[ -n "${HF_TOKEN:-}" ]]; then
    CURL_OPTS+=(-H "Authorization: Bearer ${HF_TOKEN}")
fi

# Separate exit-code capture from body so we can diagnose failures precisely.
RESPONSE="$(curl "${CURL_OPTS[@]}" "$URL")"
CURL_RC=$?

if [[ $CURL_RC -ne 0 ]]; then
    echo "ERROR: curl failed (exit $CURL_RC) while fetching $URL" >&2
    exit 1
fi

# -w appends the 3-digit status to the body; split them back apart.
HTTP_CODE="${RESPONSE: -3}"
JSON="${RESPONSE:0:${#RESPONSE}-3}"

case "$HTTP_CODE" in
    200) ;;  # fall through to parsing
    404)
        # Acceptable: the requested subpath (e.g. /onnx) doesn't exist.
        exit 0
        ;;
    401|403)
        echo "ERROR: HTTP $HTTP_CODE from HuggingFace for $URL (auth/permission)" >&2
        exit 1
        ;;
    *)
        echo "ERROR: HTTP $HTTP_CODE from HuggingFace for $URL" >&2
        exit 1
        ;;
esac

# 200 but empty body is unexpected — surface it rather than silently swallow.
if [[ -z "$JSON" ]]; then
    echo "ERROR: HTTP 200 but empty body from $URL" >&2
    exit 1
fi

# Parse via python3 (json module is stdlib). Each line: <path>
python3 - "$JSON" <<'PYEOF'
import json, sys
data = sys.argv[1]
try:
    entries = json.loads(data)
except json.JSONDecodeError as e:
    # Surface the decode error so callers can distinguish "empty repo" from
    # "HF returned something we can't parse" (upstream format change, captive
    # portal HTML, etc.). Truncate the raw data so we don't dump a multi-MB
    # response into logs.
    preview = data[:500] + ("... [truncated]" if len(data) > 500 else "")
    print(f"ERROR: failed to parse JSON from HuggingFace API: {e}", file=sys.stderr)
    print(f"  raw response: {preview!r}", file=sys.stderr)
    sys.exit(1)
if not isinstance(entries, list):
    preview = repr(entries)[:500]
    print(
        f"ERROR: unexpected response type from HuggingFace API: "
        f"{type(entries).__name__} (expected list)",
        file=sys.stderr,
    )
    print(f"  contents: {preview}", file=sys.stderr)
    sys.exit(1)
# Empty list is valid (directory exists but has no files) — exit 0 silently.
for e in entries:
    p = e.get("path") if isinstance(e, dict) else None
    if p:
        print(p)
PYEOF
