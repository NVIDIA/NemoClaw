---
title: Discord Bridge
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [docs-deployment]
tags: [bridge, discord, messaging]
---

# Discord Bridge

Auxiliary service that forwards messages between a Discord channel and the
sandboxed [OpenClaw](openclaw.md) agent.

## Prerequisites

- Discord bot token (from Discord Developer Portal)
- Discord channel ID
- **Message Content Intent** enabled for the bot

## Setup

1. Create Discord bot in Developer Portal
2. Enable Message Content Intent
3. Export environment variables:

   ```bash
   export DISCORD_BOT_TOKEN=<token>
   export DISCORD_CHANNEL_ID=<id>
   ```

4. Apply Discord [policy preset](../concepts/policy-presets.md):

   ```bash
   nemoclaw <name> policy-add  # Select 'discord'
   ```

5. Start: `nemoclaw start`

## Behaviour

- Adds 👀 reaction on message receipt
- Forwards prompt to agent
- Posts response back to Discord channel
- Optional: `ALLOWED_USER_IDS` for access restriction

## Diagnostics

```bash
nemoclaw <name> discord-probe
```

## Implementation

`scripts/discord-bridge.js`

## See Also

- [Telegram Bridge](telegram-bridge.md) — Similar bridge for Telegram
- [Policy Presets](../concepts/policy-presets.md) — Discord preset
- [CLI Commands](../concepts/cli-commands.md) — `nemoclaw start/stop`
