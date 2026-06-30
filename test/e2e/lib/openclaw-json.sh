#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Extract human-readable assistant text from `openclaw agent --json` output.
# OpenClaw's JSON envelope has moved between result.payloads[] and top-level
# payloads[]; keep E2E assertions focused on visible reply/provenance text
# instead of one exact envelope shape. This also tolerates wrapper output before
# the JSON blob while preserving failed-tool and untrusted-child provenance so
# plausible assistant text cannot hide incomplete or unverified work. Metadata
# fields such as IDs, durations, session names, and model/provider details
# should not satisfy reply assertions.
e2e_text_contains_integer_42() {
  local compact
  compact="$(printf '%s' "${1:-}" | tr -d '[:space:]')"
  grep -qE '(^|[^0-9])42([^0-9]|$)' <<<"$compact"
}

parse_openclaw_agent_text() {
  local helper_dir
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  python3 "${helper_dir}/openclaw-agent-json.py"
}

nemoclaw_e2e_compact_agent_reply() {
  tr -d '[:space:]'
}

nemoclaw_e2e_agent_reply_contains_token() {
  local reply="${1:-}"
  local expected="${2:-}"
  local compact_reply compact_expected

  compact_reply="$(printf '%s' "$reply" | nemoclaw_e2e_compact_agent_reply)"
  compact_expected="$(printf '%s' "$expected" | nemoclaw_e2e_compact_agent_reply)"
  [ -n "$compact_expected" ] && grep -Fq -- "$compact_expected" <<<"$compact_reply"
}

openclaw_agent_text_has_integer_42() {
  local reply
  reply="$(cat)"
  e2e_text_contains_integer_42 "$reply"
}

openclaw_agent_text_has_token() {
  local expected="$1"
  local reply
  reply="$(cat)"
  nemoclaw_e2e_agent_reply_contains_token "$reply" "$expected"
}
