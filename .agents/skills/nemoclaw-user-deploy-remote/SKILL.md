---
name: "nemoclaw-user-deploy-remote"
description: "Explains how to run NemoClaw on a remote GPU instance, including the deprecated Brev compatibility path and the preferred installer plus onboard flow. Describes security hardening measures applied to the NemoClaw sandbox container image. Use when reviewing container security, Docker capabilities, process limits, or sandbox hardening controls. Forwards messages between Discord and the sandboxed OpenClaw agent. Forwards messages between Telegram and the sandboxed OpenClaw agent."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Deploy Remote

Explains how to run NemoClaw on a remote GPU instance, including the deprecated Brev compatibility path and the preferred installer plus onboard flow.

## Prerequisites

- The [Brev CLI](https://brev.nvidia.com) installed and authenticated.
- A provider credential for the inference backend you want to use during onboarding.
- NemoClaw installed locally if you plan to use the deprecated `nemoclaw deploy` wrapper. Otherwise, install NemoClaw directly on the remote host after provisioning it.
- A running NemoClaw sandbox, either local or remote.
- A Discord bot token from the Discord Developer Portal.
- A Discord channel ID for the channel the bot should monitor.
- The **Message Content Intent** enabled for the bot in the Discord Developer Portal.
- A Telegram bot token from [BotFather](https://t.me/BotFather).

Run NemoClaw on a remote GPU instance through [Brev](https://brev.nvidia.com).
The preferred path is to provision the VM, run the standard NemoClaw installer on that host, and then run `nemoclaw onboard`.

## Step 1: Quick Start

If your Brev instance is already up and has already been onboarded with a sandbox, start with the standard sandbox chat flow:

```console
$ nemoclaw my-assistant connect
$ openclaw tui
```

This gets you into the sandbox shell first and opens the OpenClaw chat UI right away.
If the VM is fresh, run the standard installer on that host and then run `nemoclaw onboard` before trying `nemoclaw my-assistant connect`.

If you are connecting from your local machine and still need to provision the remote VM, you can still use `nemoclaw deploy <instance-name>` as the legacy compatibility path described below.

## Step 2: Deploy the Instance

> **Warning:** The `nemoclaw deploy` command is deprecated.
> Prefer provisioning the remote host separately, then running the standard NemoClaw installer and `nemoclaw onboard` on that host.

Create a Brev instance and run the legacy compatibility flow:

```console
$ nemoclaw deploy <instance-name>
```

Replace `<instance-name>` with a name for your remote instance, for example `my-gpu-box`.

The legacy compatibility flow performs the following steps on the VM:

1. Installs Docker and the NVIDIA Container Toolkit if a GPU is present.
2. Installs the OpenShell CLI.
3. Runs `nemoclaw onboard` (the setup wizard) to create the gateway, register providers, and launch the sandbox.
4. Starts optional host auxiliary services (for example the cloudflared tunnel) when `cloudflared` is available. Channel messaging is configured during onboarding and runs through OpenShell-managed processes, not through `nemoclaw start`.

By default, the compatibility wrapper asks Brev to provision on `gcp`. Override this with `NEMOCLAW_BREV_PROVIDER` if you need a different Brev cloud provider.

## Step 3: Connect to the Remote Sandbox

After deployment finishes, the deploy command opens an interactive shell inside the remote sandbox.
To reconnect after closing the session, run the command again:

```console
$ nemoclaw deploy <instance-name>
```

## Step 4: Monitor the Remote Sandbox

SSH to the instance and run the OpenShell TUI to monitor activity and approve network requests:

```console
$ ssh <instance-name> 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell term'
```

## Step 5: Verify Inference

Run a test agent prompt inside the remote sandbox:

```console
$ openclaw agent --agent main --local -m "Hello from the remote sandbox" --session-id test
```

## Step 6: Remote Dashboard Access

The NemoClaw dashboard validates the browser origin against an allowlist baked
into the sandbox image at build time.  By default the allowlist only contains
`http://127.0.0.1:18789`.  When accessing the dashboard from a remote browser
(for example through a Brev public URL or an SSH port-forward), set
`CHAT_UI_URL` to the origin the browser will use **before** running setup:

```console
$ export CHAT_UI_URL="https://openclaw0-<id>.brevlab.com"
$ nemoclaw deploy <instance-name>
```

For SSH port-forwarding, the origin is typically `http://127.0.0.1:18789` (the
default), so no extra configuration is needed.

> **Warning:** On Brev, set `CHAT_UI_URL` in the launchable environment configuration so it is
> available when the installer builds the sandbox image. If `CHAT_UI_URL` is not
> set on a headless host, the compatibility wrapper prints a warning.
>
> `NEMOCLAW_DISABLE_DEVICE_AUTH` is also evaluated at image build time.
> If you disable device auth for a remote deployment, any device that can reach the dashboard origin can connect without pairing.
> Avoid this on internet-reachable or shared-network deployments.

## Step 7: Proxy Configuration

NemoClaw routes sandbox traffic through a gateway proxy that defaults to `10.200.0.1:3128`.
If your network requires a different proxy, set `NEMOCLAW_PROXY_HOST` and `NEMOCLAW_PROXY_PORT` before onboarding:

```console
$ export NEMOCLAW_PROXY_HOST=proxy.example.com
$ export NEMOCLAW_PROXY_PORT=8080
$ nemoclaw onboard
```

These values are baked into the sandbox image at build time.
Only alphanumeric characters, dots, hyphens, and colons are accepted for the host.
The port must be numeric (0-65535).
Changing the proxy after onboarding requires re-running `nemoclaw onboard`.

## Step 8: GPU Configuration

The deploy script uses the `NEMOCLAW_GPU` environment variable to select the GPU type.
The default value is `a2-highgpu-1g:nvidia-tesla-a100:1`.
Set this variable before running `nemoclaw deploy` to use a different GPU configuration:

```console
$ export NEMOCLAW_GPU="a2-highgpu-1g:nvidia-tesla-a100:2"
$ nemoclaw deploy <instance-name>
```

---

Forward messages between a Discord channel and the OpenClaw agent running inside the sandbox.
The Discord bridge is an auxiliary service managed by `nemoclaw start`.

## Step 9: Create a Discord Bot

Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
In the application settings:

1. Open the **Bot** section.
2. Create a bot user if the application does not already have one.
3. Copy the bot token.
4. Enable **Message Content Intent** so the bridge can read message text.

Invite the bot to your server with permission to read messages, add reactions, and send messages in the target channel.

## Step 10: Get the Channel ID

Enable Developer Mode in Discord, then right-click the target channel and select **Copy Channel ID**.

## Step 11: Set the Environment Variables

Export the bot token and channel ID:

```console
$ export DISCORD_BOT_TOKEN=<your-bot-token>
$ export DISCORD_CHANNEL_ID=<your-channel-id>
```

## Step 12: Apply the Discord Policy Preset

Apply the Discord network policy preset to the sandbox:

```console
$ nemoclaw the-crucible policy-add
```

When prompted, select `discord`.

If you are creating a new sandbox and `DISCORD_BOT_TOKEN` is already set, NemoClaw suggests the Discord policy preset automatically during onboarding.

## Step 13: Start Auxiliary Services

Start the Discord bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services when the required environment variables are set:

- The Discord bridge forwards messages between Discord and the agent.
- The Telegram bridge forwards messages between Telegram and the agent.
- The cloudflared tunnel provides external access to the sandbox dashboard.

The Discord bridge starts only when both `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` are set.

## Step 14: Verify the Services

Check that the Discord bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Step 15: Send a Message

Open the configured Discord channel and send a message.
The bridge adds an eyes reaction, forwards the prompt to the OpenClaw agent inside the sandbox, and posts the agent response back to the channel.

## Step 16: Restrict Access by User ID

To restrict which Discord users can interact with the agent, set the `ALLOWED_USER_IDS` environment variable to a comma-separated list of Discord user IDs:

```console
$ export ALLOWED_USER_IDS="123456789012345678,987654321098765432"
$ nemoclaw start
```

## Step 17: Diagnose Discord Connectivity

Probe the Discord network path from inside the sandbox:

```console
$ nemoclaw the-crucible discord-probe
```

The probe checks DNS, proxy routing, HTTPS connectivity, and authenticated Discord Bot API access when a bot token is available.

## Step 18: Stop the Services

To stop the Discord bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

---

Forward messages between a Telegram bot and the OpenClaw agent running inside the sandbox.
The Telegram bridge is an auxiliary service managed by `nemoclaw start`.

## Step 19: Create a Telegram Bot

Open Telegram and send `/newbot` to [@BotFather](https://t.me/BotFather).
Follow the prompts to create a bot and receive a bot token.

## Step 20: Set the Environment Variable

Export the bot token as an environment variable:

```console
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
```

## Step 21: Start Auxiliary Services

Start the Telegram bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services:

- The Telegram bridge forwards messages between Telegram and the agent.
- The cloudflared tunnel provides external access to the sandbox.

The Telegram bridge starts only when the `TELEGRAM_BOT_TOKEN` environment variable is set.

## Step 22: Verify the Services

Check that the Telegram bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Step 23: Send a Message

Open Telegram, find your bot, and send a message.
The bridge forwards the message to the OpenClaw agent inside the sandbox and returns the agent response.

## Step 24: Restrict Access by Chat ID

To restrict which Telegram chats can interact with the agent, set the `ALLOWED_CHAT_IDS` environment variable to a comma-separated list of Telegram chat IDs:

```console
$ export ALLOWED_CHAT_IDS="123456789,987654321"
$ nemoclaw start
```

## Step 25: Stop the Services

To stop the Telegram bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Reference

- [Sandbox Image Hardening](references/sandbox-hardening.md)

## Related Skills

- `nemoclaw-user-monitor-sandbox` — Monitor Sandbox Activity for sandbox monitoring tools
- `nemoclaw-user-reference` — Commands for the full `deploy` command reference
