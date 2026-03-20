---
title:
  page: "Set Up the NemoClaw Discord Bridge for Remote Agent Chat"
  nav: "Set Up Discord Bridge"
description: "Forward messages between Discord channels and the sandboxed OpenClaw agent."
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

# Set Up the NemoClaw Discord Bridge for Remote Agent Chat

Forward messages between a Discord channel and the OpenClaw agent running inside the sandbox.
The Discord bridge runs on the host because the sandbox proxy does not support the WebSocket connections that the Discord gateway requires.

## Prerequisites

- A running NemoClaw sandbox, either local or remote.
- A Discord application and bot token from the [Discord Developer Portal](https://discord.com/developers/applications).
- Node.js 20 or later.
- The `discord.js` package installed (`npm install` from the repo root installs it).

## Create a Discord Application and Bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and select **New Application**.
2. Give the application a name and select **Create**.
3. Go to the **Bot** tab and select **Add Bot**.
4. Under **Token**, select **Reset Token** and copy the token.
   Store it securely — Discord does not show it again.
5. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
   The bridge requires this intent to read message text.
6. Select **Save Changes**.

## Invite the Bot to Your Server

1. Go to the **OAuth2 → URL Generator** tab.
2. Under **Scopes**, select `bot`.
3. Under **Bot Permissions**, select **Send Messages** and **Read Message History**.
4. Copy the generated URL, open it in a browser, and select the server you want to add the bot to.

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

- The Discord bridge forwards messages between Discord channels and the agent.
- The cloudflared tunnel provides external access to the sandbox.

The Discord bridge starts only when the `DISCORD_BOT_TOKEN` environment variable is set.

## Verify the Services

Check that the Discord bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services, including the Discord bridge.

## Send a Message

Open Discord, go to any channel the bot has access to, and send a message.
The bridge forwards the message to the OpenClaw agent inside the sandbox and posts the agent response back to the same channel.

Each channel maintains its own session.
The agent remembers the conversation context within a channel across messages.

## Reset a Session

To clear the conversation history for a channel, send the following message in that channel:

```
!reset
```

The agent starts a fresh session for the next message in that channel.

## Restrict Access by Guild

To restrict which Discord servers (guilds) can interact with the agent, set the `ALLOWED_GUILD_IDS` environment variable to a comma-separated list of guild IDs:

```console
$ export ALLOWED_GUILD_IDS="123456789012345678,987654321098765432"
$ nemoclaw start
```

To find a guild ID, open Discord, go to **Settings → Advanced**, enable **Developer Mode**, then right-click the server name and select **Copy Server ID**.

## Stop the Services

To stop the Discord bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Related Topics

- [Set Up the Telegram Bridge](set-up-telegram-bridge.md) to enable Telegram messaging alongside Discord.
- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment with Discord support.
- [Commands](../reference/commands.md) for the full `start` and `stop` command reference.
