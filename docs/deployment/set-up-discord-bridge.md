---
title:
  page: "Set Up the NemoClaw Discord Bridge for Remote Agent Chat"
  nav: "Set Up Discord Bridge"
description: "Forward messages between Discord and the sandboxed OpenClaw agent."
keywords: ["nemoclaw discord bridge", "discord bot openclaw agent"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "discord", "deployment", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Set Up the Discord Bridge

Forward messages between a Discord bot and the OpenClaw agent running inside the sandbox.
The Discord bridge is an auxiliary service managed by `nemoclaw start`.

## Prerequisites

- A running NemoClaw sandbox, either local or remote.
- A Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications).

## Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Click **Bot** on the sidebar.
3. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** (required)
   - **Server Members Intent** (recommended)
4. Click **Reset Token** to generate a bot token. Copy it.
5. Go to **OAuth2 → URL Generator**, enable scopes `bot` and `applications.commands`.
6. Under **Bot Permissions**, enable: View Channels, Send Messages, Read Message History, Embed Links, Attach Files.
7. Copy the generated URL, open it in a browser, and add the bot to your server.

## Apply the Discord Network Policy

Before the agent can make external calls that Discord requires, add the Discord policy preset to your sandbox:

```console
$ nemoclaw <sandbox-name> policy-add
```

Select `discord` from the list.

## Set the Environment Variable

Export the bot token as an environment variable:

```console
$ export DISCORD_BOT_TOKEN=<your-bot-token>
```

## Start Auxiliary Services

Start the Discord bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services:

- The Discord bridge forwards messages between Discord and the agent.
- The Telegram bridge forwards messages between Telegram and the agent (if configured).
- The cloudflared tunnel provides external access to the sandbox.

The Discord bridge starts only when the `DISCORD_BOT_TOKEN` environment variable is set.

## Verify the Services

Check that the Discord bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Send a Message

Open Discord and send a message in any channel where the bot is present, or DM the bot directly.
The bridge forwards the message to the OpenClaw agent inside the sandbox and returns the agent response.

In guild channels, the bot responds to all messages by default.
In DMs, the bot always responds.

## Restrict Access

### By User ID

To restrict which Discord users can interact with the agent, set the `ALLOWED_USER_IDS` environment variable to a comma-separated list of Discord user IDs:

```console
$ export ALLOWED_USER_IDS="123456789012345678,987654321098765432"
$ nemoclaw start
```

### By Channel ID

To restrict which channels the bot responds in, set the `ALLOWED_CHANNEL_IDS` environment variable:

```console
$ export ALLOWED_CHANNEL_IDS="123456789012345678,987654321098765432"
$ nemoclaw start
```

## Stop the Services

To stop the Discord bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Related Topics

- [Set Up the Telegram Bridge](set-up-telegram-bridge.md) for Telegram support.
- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment.
- [Commands](../reference/commands.md) for the full `start` and `stop` command reference.
