#!/bin/bash
# Load NemoClaw Discord bot token from pass and start the bridge

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

token="$(pass show api-keys/nemoclaw-discord-token 2>/dev/null | head -1)"
if [ $? -ne 0 ] || [ -z "$token" ]; then
  echo "ERROR: Could not load NemoClaw Discord bot token from pass"
  exit 1
fi

export DISCORD_BOT_TOKEN="$token"
export PATH="$HOME/.local/bin:$PATH"

exec node "$SCRIPT_DIR/discord-bridge.js"
