---
title:
  page: "Set Up the NemoClaw Telegram Bridge for Remote Agent Chat"
  nav: "Set Up Telegram Bridge"
description: "Forward messages between Telegram and the sandboxed OpenClaw agent."
keywords: ["nemoclaw telegram bridge", "telegram bot openclaw agent"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "telegram", "deployment", "nemoclaw"]
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

# Set Up the Telegram Bridge

Forward messages between a Telegram bot and the OpenClaw agent running inside the sandbox.
The Telegram bridge is an auxiliary service managed by `nemoclaw start`.

## Prerequisites

- A running NemoClaw sandbox, either local or remote.
- A Telegram bot token from [BotFather](https://t.me/BotFather).

## Create a Telegram Bot

Open Telegram and send `/newbot` to [@BotFather](https://t.me/BotFather).
Follow the prompts to create a bot and receive a bot token.

## Set the Environment Variable

Export the bot token as an environment variable:

```console
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
```

## Start Auxiliary Services

Start the Telegram bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services:

- The Telegram bridge forwards messages between Telegram and the agent.
- The cloudflared tunnel provides external access to the sandbox.

The Telegram bridge starts only when the following are configured:

- `TELEGRAM_BOT_TOKEN`
- `NVIDIA_API_KEY`
- `ALLOWED_CHAT_IDS`

If you do not know your Telegram chat ID yet, start the bridge in discovery-only mode:

```console
$ nemoclaw start --discover-chat-id
```

Then send any message to the bot. The bridge replies with your chat ID and does not forward the message to the agent.

## Verify the Services

Check that the Telegram bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Send a Message

Open Telegram, find your bot, and send a message.
The bridge forwards the message to the OpenClaw agent inside the sandbox and returns the agent response.

## Allow Telegram Chats by Chat ID

Save the Telegram chat IDs allowed to interact with the agent:

```console
$ nemoclaw telegram allow 123456789,987654321
$ nemoclaw start
```

To inspect or clear the saved allowlist:

```console
$ nemoclaw telegram show
$ nemoclaw telegram clear
```

## Stop the Services

To stop the Telegram bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Related Topics

- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment with Telegram support.
- [Commands](../reference/commands.md) for the full `start` and `stop` command reference.
