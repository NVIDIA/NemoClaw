#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Export the OpenClaw gateway log from a live sandbox, redact it, and fail
# closed if redaction fails so CI never prints/uploads stale or raw diagnostics.

nemoclaw_clear_redacted_openclaw_gateway_log_artifacts() {
  local output_file="$1"
  rm -f "$output_file"
  rm -f "${output_file}.raw".* "${output_file}.tmp".* 2>/dev/null || true
}

nemoclaw_export_redacted_openclaw_gateway_log() {
  local sandbox_name="$1"
  local output_file="$2"
  local redactor_script="${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/redact-openclaw-gateway-log.sh}"
  local raw_file
  local sandbox_gateway_token

  nemoclaw_clear_redacted_openclaw_gateway_log_artifacts "$output_file"
  raw_file="$(mktemp "${output_file}.raw.XXXXXX")"

  sandbox_gateway_token="$(
    openshell sandbox exec --name "$sandbox_name" -- sh -lc \
      'node -e '\''const fs = require("fs"); const cfg = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8")); process.stdout.write(cfg.gateway?.auth?.token || cfg.gateway?.authToken || "");'\'' 2>/dev/null' \
      2>/dev/null || true
  )"
  sandbox_gateway_token="${sandbox_gateway_token//$'\r'/}"
  sandbox_gateway_token="${sandbox_gateway_token%%$'\n'*}"

  openshell sandbox exec --name "$sandbox_name" -- sh -lc \
    'tail -n 400 /tmp/openclaw-issue2603-gateway.log 2>/dev/null || echo "gateway log missing"' \
    >"$raw_file" 2>&1 || true

  if OPENCLAW_GATEWAY_AUTH_TOKEN="${sandbox_gateway_token:-${OPENCLAW_GATEWAY_AUTH_TOKEN:-}}" \
    bash "$redactor_script" "$raw_file" "$output_file"; then
    rm -f "$raw_file"
    return 0
  fi

  rm -f "$raw_file"
  nemoclaw_clear_redacted_openclaw_gateway_log_artifacts "$output_file"
  return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "${1:-}" = "--clear" ]; then
    if [ "$#" -ne 2 ]; then
      echo "usage: $0 --clear <redacted-output>" >&2
      exit 2
    fi
    nemoclaw_clear_redacted_openclaw_gateway_log_artifacts "$2"
    exit 0
  fi
  if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "usage: $0 <sandbox-name> <redacted-output> [redactor-script]" >&2
    exit 2
  fi
  nemoclaw_export_redacted_openclaw_gateway_log "$@"
fi
