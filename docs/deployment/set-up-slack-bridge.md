---
title:
  page: "Set Up Slack with NemoClaw and OpenShell"
  nav: "Set Up Slack"
description:
  main: "Connect Slack to your sandboxed OpenClaw agent using OpenShell-managed channel messaging configured during onboarding."
  agent: "Explains how Slack reaches the sandboxed OpenClaw agent through OpenShell-managed processes and onboarding-time channel configuration. Use when setting up Slack, a chat interface, or messaging integration."
keywords: ["nemoclaw slack", "slack bot openclaw agent", "openshell channel messaging", "slack socket mode"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "slack", "deployment", "nemoclaw"]
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

# Set Up Slack with NemoClaw and OpenShell

NemoClaw supports Slack via Socket Mode — a persistent WebSocket connection that does not require a public URL or inbound firewall rules. The bot and app tokens are stored by OpenShell as secure providers; the sandbox receives placeholder values, not the raw secrets.

## Prerequisites

- A Slack workspace where you can install apps.
- NemoClaw installed and `openshell` available on your host.

## Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**.
2. Give the app a name and select your workspace.

### Enable Socket Mode

1. In the app settings sidebar, select **Socket Mode** and toggle it on.
2. Under **App-Level Tokens**, click **Generate Token and Scopes**.
3. Give the token a name, add the `connections:write` scope, and click **Generate**.
4. Copy the token — it starts with `xapp-`. This is your `SLACK_APP_TOKEN`.

### Add Bot Scopes

1. In the sidebar select **OAuth & Permissions**.
2. Under **Bot Token Scopes** add at minimum: `chat:write`, `channels:history`, `channels:read`, `app_mentions:read`.
3. Click **Install to Workspace** and copy the **Bot User OAuth Token** (starts with `xoxb-`). This is your `SLACK_BOT_TOKEN`.

### Enable Event Subscriptions

1. In the sidebar select **Event Subscriptions** and toggle on **Enable Events**.
2. Under **Subscribe to bot events** add: `message.channels`, `app_mention`.
3. Save changes.

## Provide Tokens and Optional Channel Allowlist

Onboarding reads Slack credentials from either host environment variables or the NemoClaw credential store. You do not have to export variables if you enter the tokens when the wizard asks.

### Option A: Environment variables (CI, scripts, or before you start the wizard)

```console
$ export SLACK_BOT_TOKEN=xoxb-...
$ export SLACK_APP_TOKEN=xapp-...
```

Optional comma-separated channel ID allowlist. When set, only messages from these channels trigger the agent. Leave blank to block all channels (the default `groupPolicy` is `allowlist` with no channels configured):

```console
$ export SLACK_ALLOWED_CHANNELS="C012AB3CD,C987ZY6XW"
```

Channel IDs are stable identifiers — find them in Slack by right-clicking a channel, selecting **View channel details**, and copying the ID from the bottom of the **About** tab.

### Option B: Interactive `nemoclaw onboard`

When the wizard reaches **Messaging channels**, it lists Telegram, Discord, and Slack.
Toggle Slack on, then enter the bot token and app token when prompted.
If `SLACK_ALLOWED_CHANNELS` is not set, the wizard prompts for channel IDs — you can leave this blank and add channels later by re-running `nemoclaw onboard --recreate-sandbox`.

## Run `nemoclaw onboard`

```console
$ nemoclaw onboard
```

NemoClaw bakes channel configuration into the sandbox image at build time (`NEMOCLAW_SLACK_ALLOWED_CHANNELS_B64`), creates an OpenShell provider for the bot token, and starts the sandbox.

Channel entries in `/sandbox/.openclaw/openclaw.json` are fixed at image build time. Landlock keeps that path read-only at runtime, so you cannot patch messaging config inside a running sandbox.

If you add or change tokens or channel IDs after a sandbox already exists, re-run:

```console
$ SLACK_ALLOWED_CHANNELS="C012AB3CD" nemoclaw onboard --recreate-sandbox
```

## Apply the Slack Network Policy Preset

The `slack` policy preset opens the required egress endpoints (Slack REST API, Socket Mode WebSocket). Apply it after onboarding if it was not selected during the wizard:

```console
$ nemoclaw <sandbox-name> policy-add
```

Select `slack` from the menu.

## Confirm Delivery

After the sandbox is running, invite the bot to one of your allowlisted channels in Slack and send a message. If the bot does not respond, check:

- The channel ID in `SLACK_ALLOWED_CHANNELS` matches the channel you are posting in.
- The `slack` policy preset is applied (`nemoclaw <sandbox-name> policy-list`).
- Gateway logs inside the sandbox: `openshell sandbox connect <sandbox-name>` then `tail -f /tmp/gateway.log`.
