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

Forward messages between a Discord channel and the OpenClaw agent running inside the sandbox.
The Discord bridge is an auxiliary service managed by `nemoclaw start`.

## Prerequisites

- A running NemoClaw sandbox, either local or remote.
- A Discord bot token from the Discord Developer Portal.
- A Discord channel ID for the channel the bot should monitor.
- The **Message Content Intent** enabled for the bot in the Discord Developer Portal.

## Create a Discord Bot

Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
In the application settings:

1. Open the **Bot** section.
2. Create a bot user if the application does not already have one.
3. Copy the bot token.
4. Enable **Message Content Intent** so the bridge can read message text.

Invite the bot to your server with permission to read messages, add reactions, and send messages in the target channel.

## Get the Channel ID

Enable Developer Mode in Discord, then right-click the target channel and select **Copy Channel ID**.

## Set the Environment Variables

Export the bot token and channel ID:

```console
$ export DISCORD_BOT_TOKEN=<your-bot-token>
$ export DISCORD_CHANNEL_ID=<your-channel-id>
```

## Apply the Discord Policy Preset

Apply the Discord network policy preset to the sandbox:

```console
$ nemoclaw the-crucible policy-add
```

When prompted, select `discord`.

If you are creating a new sandbox and `DISCORD_BOT_TOKEN` is already set, NemoClaw suggests the Discord policy preset automatically during onboarding.

## Start Auxiliary Services

Start the Discord bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services when the required environment variables are set:

- The Discord bridge forwards messages between Discord and the agent.
- The Telegram bridge forwards messages between Telegram and the agent.
- The cloudflared tunnel provides external access to the sandbox dashboard.

The Discord bridge starts only when both `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` are set.

## Verify the Services

Check that the Discord bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Send a Message

Open the configured Discord channel and send a message.
The bridge adds an eyes reaction, forwards the prompt to the OpenClaw agent inside the sandbox, and posts the agent response back to the channel.

## Restrict Access by User ID

To restrict which Discord users can interact with the agent, set the `ALLOWED_USER_IDS` environment variable to a comma-separated list of Discord user IDs:

```console
$ export ALLOWED_USER_IDS="123456789012345678,987654321098765432"
$ nemoclaw start
```

## Diagnose Discord Connectivity

Probe the Discord network path from inside the sandbox:

```console
$ nemoclaw the-crucible discord-probe
```

The probe checks DNS, proxy routing, HTTPS connectivity, and authenticated Discord Bot API access when a bot token is available.

## Stop the Services

To stop the Discord bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Related Topics

- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment with Discord support.
- [Set Up the Telegram Bridge](set-up-telegram-bridge.md) if you want the Telegram workflow instead.
- [Commands](../reference/commands.md) for the full command reference.
