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
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Set Up the NemoClaw Discord Bridge for Remote Agent Chat

Forward messages between a Discord bot and the OpenClaw agent running inside the sandbox.
`nemoclaw start` manages the Discord bridge as an auxiliary service.

## Prerequisites

Before you begin, ensure the following are in place:

- A running NemoClaw sandbox, either local or remote.
- A Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications).

## Create a Discord Bot

Visit the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.

1. Click "New Application" and give it a name.
2. Go to the "Bot" tab and click "Add Bot".
3. Under the TOKEN section, click "Copy" to copy your bot token.
4. Keep the token secure and do not share it.

## Add the Bot to Your Server

Configure OAuth2 permissions and invite the bot to your Discord server.

1. In the Developer Portal, go to the "OAuth2" tab.
2. Under "SCOPES", select `bot`.
3. Under "PERMISSIONS", select at least:
   - Send Messages
   - Read Messages and View Channels
   - Read Message History

4. Copy the generated URL and open it in your browser to invite the bot to your Discord server.

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
- The cloudflared tunnel provides external access to the sandbox.

The `start` command launches the Discord bridge only when you set the `DISCORD_BOT_TOKEN` environment variable.

## Verify the Services

Check that the Discord bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Send a Message

Open Discord and send a message to your bot.
You can either mention the bot directly in a channel or send a direct message.
The bridge forwards the message to the OpenClaw agent inside the sandbox.
The agent returns its response to the channel.

## Restrict Access by Channel

To restrict which Discord channels the agent can respond in, set the `DISCORD_CHANNEL_ID` environment variable:

```console
$ export DISCORD_CHANNEL_ID=<your-channel-id>
$ nemoclaw start
```

The bot only responds to messages in the specified channel.

## Restrict Access by User

To restrict which Discord users can interact with the agent, set the `ALLOWED_USER_IDS` environment variable to a comma-separated list of Discord user IDs:

```console
$ export ALLOWED_USER_IDS="123456789,987654321"
$ nemoclaw start
```

## Stop the Services

To stop the Discord bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Next Steps

Explore these guides for more advanced configurations:

- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment with Discord support.
- [Commands](../reference/commands.md) for the full `start` and `stop` command reference.
