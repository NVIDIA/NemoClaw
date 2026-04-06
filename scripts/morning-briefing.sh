#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Morning Briefing — sends a daily briefing to Telegram via the sandbox agent.
# Designed to be called by cron or launchd on the host.
#
# Usage: ./scripts/morning-briefing.sh [--chat-id <id>]
#
# Requires: TELEGRAM_BOT_TOKEN in environment, SSH access to sandbox.

set -euo pipefail

# Source credentials (launchd doesn't load shell profiles).
# Extract only well-formed export lines from ~/.zshrc since bash can't run
# zsh-specific syntax. Match 'export VAR="value"' or 'export VAR=value' where
# the value is a single token or quoted string (no trailing garbage like ' -').
# shellcheck disable=SC1090
if [[ -f "$HOME/.zshrc" ]]; then
  while IFS= read -r line; do
    eval "$line" 2>/dev/null || true
  done < <(grep -E '^export [A-Za-z_][A-Za-z0-9_]*=(".*"|'\''.*'\''|[^ ]*)$' "$HOME/.zshrc" 2>/dev/null)
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SANDBOX_NAME="${SANDBOX_NAME:-my-assistant}"
CHAT_ID="${1:---chat-id}"

# If first arg is --chat-id, take the next arg
if [[ "$CHAT_ID" == "--chat-id" ]]; then
  CHAT_ID="${2:-${TELEGRAM_CHAT_ID:-}}"
fi

# Use the same session ID as the Telegram bridge (tg-{chatId}) so that
# replies to the briefing in Telegram carry full conversation context.
SESSION_ID="tg-${CHAT_ID}"

if [[ -z "$CHAT_ID" || -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "Error: TELEGRAM_CHAT_ID and TELEGRAM_BOT_TOKEN must be set" >&2
  exit 1
fi

# Run agent in sandbox
RESPONSE=$(ssh -o ConnectTimeout=10 "openshell-${SANDBOX_NAME}" \
  "export NVIDIA_API_KEY=unused && nemoclaw-start openclaw agent --agent main \
   -m 'Give me my morning briefing' --session-id ${SESSION_ID}" 2>&1 \
  | grep -v -e '\[SECURITY\]' -e 'Setting up NemoClaw' -e '\[gateway\]' -e 'UNDICI' \
           -e '(node:' -e 'Use .node' -e 'pairing required' -e 'CAP_SET' \
           -e 'privilege separation' -e 'Gateway target:' -e 'Source: local loopback' \
           -e 'Config: /sandbox' -e 'Bind: loopback' -e 'getaddrinfo' \
           -e 'tools websearch' -e 'Gateway agent failed' \
           -e 'GatewayClientRequestError' -e 'abnormal closure' \
           -e 'tools cron failed' || true)

if [[ -z "$RESPONSE" ]]; then
  RESPONSE="Morning briefing failed — agent returned empty response."
fi

# Send to Telegram (try Markdown first, fall back to plain text)
RESULT=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="$CHAT_ID" \
  -d parse_mode="Markdown" \
  --data-urlencode "text=${RESPONSE}" 2>&1)

if echo "$RESULT" | grep -q '"ok":false'; then
  # Markdown failed (unbalanced formatting) — retry plain text
  RESULT=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" \
    --data-urlencode "text=${RESPONSE}" 2>&1)
fi

if echo "$RESULT" | grep -q '"ok":true'; then
  echo "[$(date)] Morning briefing sent to chat $CHAT_ID"
else
  echo "[$(date)] Failed to send briefing: $RESULT" >&2
  exit 1
fi
