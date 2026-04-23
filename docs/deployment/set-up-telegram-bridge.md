---
title:
  page: "Set Up Telegram with NemoClaw and OpenShell"
  nav: "Set Up Telegram"
description:
  main: "Connect Telegram to your sandboxed OpenClaw agent using OpenShell-managed channel messaging configured during onboarding."
  agent: "Explains how Telegram reaches the sandboxed OpenClaw agent through OpenShell-managed processes and onboarding-time channel configuration. Use when setting up Telegram, a chat interface, or messaging integration without relying on nemoclaw tunnel start for bridges."
keywords: ["nemoclaw telegram", "telegram bot openclaw agent", "openshell channel messaging"]
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

# Set Up Telegram

Telegram, Discord, and Slack reach your agent through OpenShell-managed processes and gateway constructs.
NemoClaw configures those channels during `nemoclaw onboard`. Tokens are registered with OpenShell providers, channel configuration is baked into the sandbox image, and runtime delivery stays under OpenShell control.

`nemoclaw tunnel start` does not start Telegram (or other chat bridges). It only starts optional host services such as the cloudflared tunnel when that binary is present. (`nemoclaw start` is kept as a deprecated alias.)
For details, refer to [Commands](../reference/commands.md).

## Prerequisites

- A machine where you can run `nemoclaw onboard` (local or remote host that runs the gateway and sandbox).
- A Telegram bot token from [BotFather](https://t.me/BotFather).

## Create a Telegram Bot

Open Telegram and send `/newbot` to [@BotFather](https://t.me/BotFather).
Follow the prompts to create a bot and copy the bot token.

## Provide the Bot Token and Optional Allowlist

Onboarding reads Telegram credentials from either host environment variables or the NemoClaw credential store (`getCredential` / `saveCredential` in the onboard flow). You do not have to export variables if you enter the token when the wizard asks.

### Option A: Environment variables (CI, scripts, or before you start the wizard)

```console
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
```

Optional comma-separated allowlist (maps to the wizard field “Telegram User ID (for DM access)”):

```console
$ export TELEGRAM_ALLOWED_IDS="123456789,987654321"
```

### Option B: Interactive `nemoclaw onboard`

When the wizard reaches **Messaging channels**, it lists Telegram, Discord, and Slack.
Press **1** to toggle Telegram on or off, then **Enter** when done.
If the token is not already in the environment or credential store, the wizard prompts for it and saves it to the store.
If `TELEGRAM_ALLOWED_IDS` is not set, the wizard can prompt for allowed sender IDs for Telegram DMs (you can leave this blank and rely on OpenClaw pairing instead).
NemoClaw applies that allowlist to Telegram DMs only.
Group chats stay open by default so rebuilt sandboxes do not silently drop Telegram group messages because of an empty group allowlist.

## Run `nemoclaw onboard`

Complete the rest of the wizard so the blueprint can create OpenShell providers (for example `<sandbox>-telegram-bridge`), bake channel configuration into the image (`NEMOCLAW_MESSAGING_CHANNELS_B64`), and start the sandbox.

Channel entries in `/sandbox/.openclaw/openclaw.json` are fixed at image build time. Landlock keeps that path read-only at runtime, so you cannot patch messaging config inside a running sandbox.

If you add or change `TELEGRAM_BOT_TOKEN` (or toggle channels) after a sandbox already exists, you typically need to run `nemoclaw onboard` again so the image and provider attachments are rebuilt with the new settings.

NemoClaw stores a SHA-256 hash of each messaging token in the sandbox registry at creation time.
When you re-run `nemoclaw onboard --non-interactive` with a new token, NemoClaw detects the change, backs up workspace state, deletes the sandbox, recreates it with the new credential, and restores the backup.
This makes credential rotation safe to script.

Telegram, Discord, and Slack each allow only one active consumer per bot token.
If you enable a messaging channel and another sandbox already uses the same token, onboard prompts you to confirm before continuing in interactive mode and exits non-zero in non-interactive mode.
`nemoclaw status` also reports cross-sandbox overlaps so you can resolve duplicates before messages start dropping.

For a full first-time flow, refer to [Quickstart](../get-started/quickstart.md).

## Confirm Delivery

After the sandbox is running, send a message to your bot in Telegram.
If something fails, use `openshell term` on the host, check gateway logs, and verify network policy allows the Telegram API (see [Customize the Network Policy](../network-policy/customize-network-policy.md) and the `telegram` preset).

## `nemoclaw tunnel start` (cloudflared Only)

`nemoclaw tunnel start` starts cloudflared when it is installed, which can expose the dashboard with a public URL.
It does not affect Telegram connectivity. The older `nemoclaw start` still works as a deprecated alias.

```console
$ nemoclaw tunnel start
```

To pause the Telegram bridge without removing its credentials or destroying the sandbox, use `nemoclaw <name> channels stop telegram`. Re-enable it later with `nemoclaw <name> channels start telegram`.

## Related Topics

- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment with messaging.
- [Architecture](../reference/architecture.md) for how providers, the gateway, and the sandbox fit together.
- [Commands](../reference/commands.md) for `tunnel start`, `tunnel stop`, `channels start`, `channels stop`, and `status`.
