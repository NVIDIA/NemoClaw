---
title:
  page: "Set Up Messaging Channels with NemoClaw and OpenShell"
  nav: "Set Up Messaging Channels"
description:
  main: "Connect Telegram, Discord, Slack, or WeChat to your sandboxed OpenClaw agent using OpenShell-managed channel messaging."
  agent: "Explains how Telegram, Discord, Slack, and WeChat reach the sandboxed OpenClaw agent through OpenShell-managed processes and NemoClaw channel commands. Use when setting up messaging channels, chat interfaces, or integrations without relying on nemoclaw tunnel start for bridges."
keywords: ["nemoclaw messaging channels", "nemoclaw telegram", "nemoclaw discord", "nemoclaw slack", "nemoclaw wechat", "openshell channel messaging"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "telegram", "discord", "slack", "wechat", "messaging", "deployment", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
skill:
  priority: 30
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Messaging Channels

Telegram, Discord, Slack, and WeChat reach your agent through OpenShell-managed processes and gateway constructs.
NemoClaw registers channel tokens with OpenShell providers, bakes the selected channel configuration into the sandbox image, and keeps runtime delivery under OpenShell control.

You can enable channels during `nemoclaw onboard` or add them later with host-side `nemoclaw <sandbox> channels` commands.
WeChat is an exception: it is wired up during `nemoclaw onboard` only — see [Add Channels After Onboarding](#add-channels-after-onboarding) for the limitation.
Do not run `openclaw channels add` or `openclaw channels remove` inside the sandbox because `/sandbox/.openclaw/openclaw.json` is generated at image build time and changes inside the running container do not persist across rebuilds.

`nemoclaw tunnel start` does not start Telegram, Discord, Slack, WeChat, or other chat bridges.
It only starts optional host services such as the cloudflared tunnel when that binary is present. (`nemoclaw start` is kept as a deprecated alias.)
For details, refer to [Commands](../reference/commands.md).

## Prerequisites

- A machine where you can run `nemoclaw onboard` (local or remote host that runs the gateway and sandbox).
- A token for each messaging platform you want to enable.
- A network policy preset for each enabled channel, or equivalent custom egress rules.

## Channel Requirements

| Channel | Required tokens | Optional settings |
|---------|-----------------|-------------------|
| Telegram | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_ALLOWED_IDS` for DM allowlisting, `TELEGRAM_REQUIRE_MENTION` for group-chat replies |
| Discord | `DISCORD_BOT_TOKEN` | `DISCORD_SERVER_ID`, `DISCORD_USER_ID`, `DISCORD_REQUIRE_MENTION` |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | None |
| WeChat (personal) | Captured via host-side QR scan during `nemoclaw onboard` — no token to paste | `WECHAT_ALLOWED_IDS` for DM allowlisting (the WeChat user who scanned the QR is added automatically) |

Telegram uses a bot token from [BotFather](https://t.me/BotFather).
Open Telegram, send `/newbot` to [@BotFather](https://t.me/BotFather), follow the prompts, and copy the token.
`TELEGRAM_ALLOWED_IDS` is a comma-separated list of Telegram user IDs for DM access.
Group chats stay open by default so rebuilt sandboxes do not silently drop Telegram group messages because of an empty group allowlist.
Set `TELEGRAM_REQUIRE_MENTION=1` to make the bot reply in Telegram groups only when users mention it.
Pairing and `TELEGRAM_ALLOWED_IDS` still govern direct messages.

Discord uses a bot token from the Discord Developer Portal.
For server channels, enable Developer Mode in Discord, right-click the server, and copy the Server ID into `DISCORD_SERVER_ID`.
By default, NemoClaw configures the bot to reply only when mentioned.
Set `DISCORD_REQUIRE_MENTION=0` if you want it to reply to all messages in the configured server.
Set `DISCORD_USER_ID` to restrict access to one user; otherwise, any member of the configured server can message the bot.

Slack uses Socket Mode and requires two tokens.
Use `SLACK_BOT_TOKEN` for the bot user OAuth token (`xoxb-...`) and `SLACK_APP_TOKEN` for the app-level Socket Mode token (`xapp-...`).

WeChat delivers messages over Tencent's iLink gateway via the upstream `@tencent-weixin/openclaw-weixin` plugin, baked into the sandbox base image.
The supported mode in this release is **personal WeChat** (`bot_type=3`) — WeChat Official Account and WeCom/Enterprise WeChat are not wired up yet.
Because the bot token only exists after a successful iLink QR handshake, NemoClaw runs the QR login on the host during `nemoclaw onboard`: you scan the QR with WeChat on your phone (Discover → Scan), confirm the login, and NemoClaw captures the token, `accountId`, `baseUrl`, and `userId` from the iLink response.
The token is registered as the `<sandbox>-wechat-bridge` OpenShell provider and replaced inside the sandbox by the `openshell:resolve:env:WECHAT_BOT_TOKEN` placeholder, so it is never baked into the image or written to disk inside the running container.
WeChat is DM-only (`allowIdsMode: "dm"`) — the operator who scanned the QR is added to `WECHAT_ALLOWED_IDS` automatically, and you can append more comma-separated WeChat user IDs through the same env var.
You can silence the host-side `[wechat]` diagnostic lines (poll status, IDC redirects, swallowed gateway errors) by exporting `NEMOCLAW_WECHAT_QUIET=1` once the flow is stable in your environment.
Tencent's iLink gateway is a third-party service: review your organization's terms-of-service, compliance, and data-residency constraints before enabling WeChat in production.

## Enable Channels During Onboarding

When the wizard reaches **Messaging channels**, it lists Telegram, Discord, Slack, and WeChat.
Press a channel number to toggle it on or off, then press **Enter** when done.
If a token is not already in the environment or credential store, the wizard prompts for it and saves it.
NemoClaw also selects the matching network policy preset during policy setup so the channel can reach its provider API.

If you enable WeChat, the wizard does not prompt for a paste token.
Instead, it renders a QR code in your terminal, polls Tencent's iLink gateway, and captures the bot token after you scan the QR with WeChat on your phone.
The login has an eight-minute deadline, refreshes the QR up to three times on expiry, and follows iLink's IDC redirects automatically — keep the terminal in the foreground until you see `✓ WeChat login confirmed`.

For scripted setup, export the credentials and optional settings for the channels you want to enable before you run onboarding:

```console
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
$ export TELEGRAM_REQUIRE_MENTION=1
$ export DISCORD_BOT_TOKEN=<your-discord-bot-token>
$ export DISCORD_SERVER_ID=<your-discord-server-id>
$ export SLACK_BOT_TOKEN=<your-slack-bot-token>
$ export SLACK_APP_TOKEN=<your-slack-app-token>
```

WeChat cannot be configured non-interactively in this release because the iLink QR handshake requires a human to scan the QR on a paired phone.
Run `nemoclaw onboard` interactively when you want to enable WeChat.

Then run onboarding:

```console
$ nemoclaw onboard
```

Complete the rest of the wizard so the blueprint can create OpenShell providers (for example `<sandbox>-telegram-bridge`, `<sandbox>-wechat-bridge`), bake channel configuration into the image (`NEMOCLAW_MESSAGING_CHANNELS_B64`), and start the sandbox.

## Add Channels After Onboarding

Run channel commands from the host, not from inside the sandbox.
Use `channels list` to see the supported channel names:

```console
$ nemoclaw my-assistant channels list
```

Add the channel you want:

```console
$ nemoclaw my-assistant channels add telegram
$ nemoclaw my-assistant channels add discord
$ nemoclaw my-assistant channels add slack
```

### `channels add wechat` is not supported in this release

`nemoclaw <sandbox> channels add wechat` exits with an explicit error and does not modify any state.
The reason is that the host-side iLink QR handshake — which is the only way to obtain a WeChat bot token — does not fit the paste-prompt model the other channels use, and the `channels add` command has no slot for the per-account metadata (`accountId`, `baseUrl`, `userId`) that the in-sandbox bridge needs to start.

To add WeChat to an existing sandbox, recreate it through `nemoclaw onboard`:

```console
$ nemoclaw my-assistant rebuild     # to refresh the existing image, or
$ nemoclaw onboard                  # to onboard a new sandbox with WeChat selected
```

`channels remove wechat`, `channels stop wechat`, and `channels start wechat` work normally for sandboxes that already have WeChat enabled.

### Other channels

`channels add` prompts for missing credentials, registers the bridge with the OpenShell gateway, updates the sandbox registry, and asks whether to rebuild immediately.
Choose the rebuild so the running sandbox image picks up the new channel.
If you need optional channel settings such as `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_REQUIRE_MENTION`, `DISCORD_SERVER_ID`, `DISCORD_USER_ID`, or `DISCORD_REQUIRE_MENTION`, export them before the rebuild starts.
If you defer the rebuild, apply the change later:

```console
$ nemoclaw my-assistant rebuild
```

In non-interactive mode, set the required environment variables before running `channels add`.
Missing credentials fail fast, and the command queues the change for a manual rebuild:

```console
$ NEMOCLAW_NON_INTERACTIVE=1 TELEGRAM_BOT_TOKEN=<your-bot-token> \
  nemoclaw my-assistant channels add telegram
$ nemoclaw my-assistant rebuild
```

For Discord server access after onboarding, include the server settings when you add the channel and rebuild:

```console
$ DISCORD_BOT_TOKEN=<your-discord-bot-token> \
  DISCORD_SERVER_ID=<your-discord-server-id> \
  DISCORD_REQUIRE_MENTION=1 \
  nemoclaw my-assistant channels add discord
```

## Rotate or Remove Credentials

Running `channels add` for a channel that is already configured overwrites the stored tokens and registers the updated bridge provider.
Rebuild the sandbox after the update so the image reflects the current channel set.

To remove a channel and clear its stored credentials, run:

```console
$ nemoclaw my-assistant channels remove telegram
```

Use `channels stop` when you want to pause a bridge without deleting credentials:

```console
$ nemoclaw my-assistant channels stop telegram
$ nemoclaw my-assistant channels start telegram
```

Telegram, Discord, Slack, and WeChat each allow only one active consumer per channel credential.
Multiple sandboxes can use the same channel type at the same time when each sandbox uses a distinct bot/app token.
For example, two Telegram sandboxes can DM the same `TELEGRAM_ALLOWED_IDS` account as long as they use different `TELEGRAM_BOT_TOKEN` values.
For WeChat, each sandbox must own a distinct iLink `accountId` (bot identity) — running two sandboxes against the same WeChat account causes one of them to lose messages.
If you enable a messaging channel and another sandbox already uses the same token, onboarding prompts you to confirm before continuing in interactive mode and exits non-zero in non-interactive mode.
If NemoClaw only has legacy channel metadata and cannot compare credential hashes, it keeps the conservative warning; re-run `channels add <channel>` with the intended token to refresh the stored non-secret hash.
`nemoclaw status` reports cross-sandbox overlaps so you can resolve duplicates before messages start dropping.

## Stop Messaging Delivery

Use `channels stop` when you want to pause one bridge and keep the sandbox running.
Use `nemoclaw tunnel stop` or its deprecated alias `nemoclaw stop` when you want to stop host auxiliary services and also ask NemoClaw to stop the OpenClaw gateway inside the selected sandbox.
Stopping the in-sandbox gateway stops Telegram, Discord, Slack, and WeChat polling for that sandbox until you restart the sandbox or gateway.

## Confirm Delivery

After the sandbox is running, send a message to the configured bot or app.
If delivery fails, use `openshell term` on the host, check gateway logs, and verify network policy allows the channel API.
Use the matching policy preset (`telegram`, `discord`, `slack`, or `wechat`) or review [Common Integration Policy Examples](../network-policy/integration-policy-examples.md).
For WeChat specifically, the in-sandbox bridge emits a single `[wechat] [<accountId>] provider ready` line on stderr after the first successful iLink hit and an annotated line when the agent turn fails after the provider connected; both are produced by the diagnostics preload and are useful for telling "channel up, inference broken" apart from "channel never connected".

## Tunnel Command

When the host has `cloudflared`, `nemoclaw tunnel start` starts a cloudflared tunnel that can expose the dashboard with a public URL.
`nemoclaw tunnel stop` stops the tunnel and asks NemoClaw to stop the in-sandbox gateway for the selected or default sandbox.
The older `nemoclaw start` still works as a deprecated alias.

```console
$ nemoclaw tunnel start
```

## Related Topics

- [Deploy NemoClaw to a Remote GPU Instance](../deployment/deploy-to-remote-gpu.md) for remote deployment with messaging.
- [Architecture](../reference/architecture.md) for how providers, the gateway, and the sandbox fit together.
- [Commands](../reference/commands.md) for `channels add`, `channels remove`, `channels start`, `channels stop`, `tunnel start`, `tunnel stop`, and `status`.
