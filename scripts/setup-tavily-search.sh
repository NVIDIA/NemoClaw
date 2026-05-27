#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Enable Tavily web search on an existing sandbox (interactive API key + rebuild).
#
# Usage:
#   ./scripts/setup-tavily-search.sh <sandbox-name>
#
# Environment:
#   TAVILY_API_KEY                  Optional; prompted when unset
#   NEMOCLAW_WEB_SEARCH_PROVIDER    Set to tavily for rebuild

set -euo pipefail

SANDBOX="${1:-}"
if [[ -z "$SANDBOX" ]]; then
  echo "Usage: $0 <sandbox-name>" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$REPO_ROOT/nemoclaw-blueprint/policies/presets/tavily.yaml" ]] && [[ -f "$REPO_ROOT/bin/nemoclaw.js" ]]; then
  NEMOCLAW=(node "$REPO_ROOT/bin/nemoclaw.js")
  echo "  Using NemoClaw from: $REPO_ROOT"
elif command -v nemoclaw >/dev/null 2>&1; then
  NEMOCLAW=(nemoclaw)
else
  echo "nemoclaw CLI not found. Build with: cd $REPO_ROOT && npm run build:cli" >&2
  exit 1
fi

read_secret() {
  local prompt="$1"
  local value=""
  if [[ -n "${TAVILY_API_KEY:-}" ]]; then
    return 0
  fi
  read -r -s -p "$prompt" value
  echo ""
  TAVILY_API_KEY="$value"
}

read_secret "  Tavily Search API key: "
if [[ -z "${TAVILY_API_KEY:-}" ]]; then
  echo "  TAVILY_API_KEY is required." >&2
  exit 1
fi

export TAVILY_API_KEY
export NEMOCLAW_WEB_SEARCH_PROVIDER=tavily

echo ""
echo "  Applying Tavily network policy and rebuilding sandbox '${SANDBOX}'..."
"${NEMOCLAW[@]}" "${SANDBOX}" policy-remove brave --yes 2>/dev/null || true
"${NEMOCLAW[@]}" "${SANDBOX}" policy-add tavily --yes
"${NEMOCLAW[@]}" "${SANDBOX}" rebuild --yes

echo ""
echo "  ✓ Tavily web search configured for sandbox '${SANDBOX}'"
echo "  Tavily Web Search is used"
echo ""
