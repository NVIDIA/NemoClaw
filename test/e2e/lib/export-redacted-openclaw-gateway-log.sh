#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Export the OpenClaw gateway log from a live sandbox, redact it, and fail
# closed if redaction fails so CI never prints/uploads stale or raw diagnostics.

nemoclaw_export_redacted_openclaw_gateway_log() {
  local sandbox_name="$1"
  local output_file="$2"
  local redactor_script="${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/redact-openclaw-gateway-log.sh}"
  local raw_file

  raw_file="$(mktemp "${output_file}.raw.XXXXXX")"
  rm -f "$output_file"
  openshell sandbox exec --name "$sandbox_name" -- sh -lc \
    'tail -n 400 /tmp/openclaw-issue2603-gateway.log 2>/dev/null || echo "gateway log missing"' \
    >"$raw_file" 2>&1 || true

  if bash "$redactor_script" "$raw_file" "$output_file"; then
    rm -f "$raw_file"
    return 0
  fi

  rm -f "$raw_file" "$output_file"
  return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "usage: $0 <sandbox-name> <redacted-output> [redactor-script]" >&2
    exit 2
  fi
  nemoclaw_export_redacted_openclaw_gateway_log "$@"
fi
