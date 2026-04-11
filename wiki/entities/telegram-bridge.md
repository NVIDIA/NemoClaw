---
title: Telegram Bridge
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [docs-deployment]
tags: [bridge, telegram, messaging]
---

# Telegram Bridge

Auxiliary service that forwards messages between a Telegram bot and the
sandboxed [OpenClaw](openclaw.md) agent.

## Prerequisites

- Telegram bot token (from BotFather: `/newbot`)
- Optional: Telegram chat IDs for access restriction

## Setup

1. Message BotFather: `/newbot`
2. Export: `export TELEGRAM_BOT_TOKEN=<token>`
3. Start: `nemoclaw start`

## Behaviour

- One-way forward: Telegram → agent → response posted back
- Optional: `ALLOWED_CHAT_IDS` (comma-separated) for restriction
- Stop: `nemoclaw stop`

## Implementation

`scripts/telegram-bridge.js`

## See Also

- [Discord Bridge](discord-bridge.md) — Similar bridge for Discord
- [CLI Commands](../concepts/cli-commands.md) — `nemoclaw start/stop`
