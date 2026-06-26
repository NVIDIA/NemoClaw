#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Redact live OpenClaw gateway logs before printing or artifact upload. The
# gateway log is a diagnostic fallback for #4881's live E2E capture failures:
# it belongs to the pinned OpenClaw gateway/inference boundary rather than the
# #2603/#3145 correlation assertions. Remove this helper when that boundary
# emits a structured, already-sanitized failure reason for aborted/delayed
# chat.send runs.

nemoclaw_redact_openclaw_gateway_log() (
  set -euo pipefail

  local source_file="$1"
  local output_file="$2"
  local tmp_file

  tmp_file="$(mktemp "${output_file}.tmp.XXXXXX")"
  # shellcheck disable=SC2329 # invoked indirectly by the trap below
  cleanup_failed_redaction() {
    rm -f "$tmp_file" "$output_file"
  }
  trap cleanup_failed_redaction ERR INT TERM

  rm -f "$output_file"
  if [ -f "$source_file" ]; then
    cp "$source_file" "$tmp_file"
  else
    printf 'gateway log missing\n' >"$tmp_file"
  fi

  local secret_name
  for secret_name in \
    NVIDIA_INFERENCE_API_KEY \
    COMPATIBLE_API_KEY \
    GITHUB_TOKEN \
    OPENCLAW_GATEWAY_AUTH_TOKEN \
    OPENSHELL_GATEWAY_AUTH_TOKEN; do
    local secret_value="${!secret_name:-}"
    [ -n "$secret_value" ] || continue
    NEMOCLAW_REDACT_SECRET="$secret_value" \
      NEMOCLAW_REDACT_LABEL="$secret_name" \
      perl -0pi -e 'BEGIN { $secret = $ENV{"NEMOCLAW_REDACT_SECRET"} // ""; $label = $ENV{"NEMOCLAW_REDACT_LABEL"} // "SECRET"; } if (length $secret) { s/\Q$secret\E/[REDACTED_$label]/g; }' \
      "$tmp_file"
  done

  perl -0pi -e 's/nvapi-[A-Za-z0-9._-]+/[REDACTED_NVIDIA_INFERENCE_API_KEY]/g; s/gh[pousr]_[A-Za-z0-9_]+/[REDACTED_GITHUB_TOKEN]/g' "$tmp_file"
  perl -0pi -e 's/((?:Authorization|Proxy-Authorization)\s*[:=]\s*)(?:Bearer\s+)?[A-Za-z0-9._~+\/=:-]+/${1}[REDACTED_AUTHORIZATION]/gi' "$tmp_file"
  perl -0pi -e 's/("(?:Authorization|Proxy-Authorization)"\s*:\s*")(?:(?:Bearer)\s+)?(?:\\.|[^"\\])*(")/${1}[REDACTED_AUTHORIZATION]${2}/gi' "$tmp_file"
  perl -0pi -e 's/((?:x-)?api[-_]?key\s*[:=]\s*)[A-Za-z0-9._-]+/${1}[REDACTED_API_KEY]/gi' "$tmp_file"
  perl -0pi -e 's/("(?:x-)?api[-_]?key"\s*:\s*")(?:\\.|[^"\\])*(")/${1}[REDACTED_API_KEY]${2}/gi' "$tmp_file"
  perl -0pi -e 's/([?&](?:token|auth_token|gateway_token|gatewayAuthToken|access_token)=)[^ \t\r\n&"'"'"'<>]+/${1}[REDACTED_TOKEN]/gi' "$tmp_file"
  perl -0pi -e 's/("(?:token|auth_token|gateway_token|gatewayAuthToken|access_token)"\s*:\s*")(?:\\.|[^"\\])*(")/${1}[REDACTED_TOKEN]${2}/gi' "$tmp_file"
  perl -0pi -e 's/((?:prompt|content|message|text)\s*[:=]\s*)("[^"]*"|'"'"'[^'"'"']*'"'"'|[^\r\n]+)/${1}[REDACTED_TEXT]/gi' "$tmp_file"
  perl -0pi -e 's/("(?:prompt|content|message|text)"\s*:\s*")(?:\\.|[^"\\])*(")/${1}[REDACTED_TEXT]${2}/gi' "$tmp_file"

  mv "$tmp_file" "$output_file"
  trap - ERR INT TERM
)

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -ne 2 ]; then
    echo "usage: $0 <source-log> <redacted-output>" >&2
    exit 2
  fi
  nemoclaw_redact_openclaw_gateway_log "$1" "$2"
fi
