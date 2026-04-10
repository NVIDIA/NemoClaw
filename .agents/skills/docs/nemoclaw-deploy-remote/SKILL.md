---
name: nemoclaw-deploy-remote
description: Provisions a remote GPU VM with NemoClaw using Brev deployment. Also covers securities hardening measures applied to the NemoClaw sandbox container image; forwards messages between Discord and the sandboxed OpenClaw agent. Use when container security, deploy nemoclaw remote gpu, deployment, discord, discord bot openclaw agent, docker capabilities, gpu, nemoclaw.
---

# Nemoclaw Deploy Remote

Provision a remote GPU VM with NemoClaw using Brev deployment.

## Prerequisites

- The [Brev CLI](https://brev.nvidia.com) installed and authenticated.
- An NVIDIA API key from [build.nvidia.com](https://build.nvidia.com).
- NemoClaw installed locally. Follow the Quickstart (see the `nemoclaw-get-started` skill) install steps.
- A running NemoClaw sandbox, either local or remote.
- A Discord bot token from the Discord Developer Portal.
- A Discord channel ID for the channel the bot should monitor.
- The **Message Content Intent** enabled for the bot in the Discord Developer Portal.
- A Telegram bot token from [BotFather](https://t.me/BotFather).

Run NemoClaw on a remote GPU instance through [Brev](https://brev.nvidia.com).
The deploy command provisions the VM, installs dependencies, and connects you to a running sandbox.

## Step 1: Deploy the Instance

> **Warning:** The `nemoclaw deploy` command is experimental and may not work as expected.

Create a Brev instance and run the NemoClaw setup:

```console
$ nemoclaw deploy <instance-name>
```

Replace `<instance-name>` with a name for your remote instance, for example `my-gpu-box`.

The deploy script performs the following steps on the VM:

1. Installs Docker and the NVIDIA Container Toolkit if a GPU is present.
2. Installs the OpenShell CLI.
3. Runs the nemoclaw setup to create the gateway, register providers, and launch the sandbox.
4. Starts auxiliary services, such as the Telegram bridge, Discord bridge, and cloudflared tunnel.

## Step 2: Connect to the Remote Sandbox

After deployment finishes, the deploy command opens an interactive shell inside the remote sandbox.
To reconnect after closing the session, run the deploy command again:

```console
$ nemoclaw deploy <instance-name>
```

## Step 3: Monitor the Remote Sandbox

SSH to the instance and run the OpenShell TUI to monitor activity and approve network requests:

```console
$ ssh <instance-name> 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell term'
```

## Step 4: Verify Inference

Run a test agent prompt inside the remote sandbox:

```console
$ openclaw agent --agent main --local -m "Hello from the remote sandbox" --session-id test
```

## Step 5: GPU Configuration

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

## Step 6: Create a Discord Bot

Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
In the application settings:

1. Open the **Bot** section.
2. Create a bot user if the application does not already have one.
3. Copy the bot token.
4. Enable **Message Content Intent** so the bridge can read message text.

Invite the bot to your server with permission to read messages, add reactions, and send messages in the target channel.

## Step 7: Get the Channel ID

Enable Developer Mode in Discord, then right-click the target channel and select **Copy Channel ID**.

## Step 8: Set the Environment Variables

Export the bot token and channel ID:

```console
$ export DISCORD_BOT_TOKEN=<your-bot-token>
$ export DISCORD_CHANNEL_ID=<your-channel-id>
```

## Step 9: Apply the Discord Policy Preset

Apply the Discord network policy preset to the sandbox:

```console
$ nemoclaw the-crucible policy-add
```

When prompted, select `discord`.

If you are creating a new sandbox and `DISCORD_BOT_TOKEN` is already set, NemoClaw suggests the Discord policy preset automatically during onboarding.

## Step 10: Start Auxiliary Services

Start the Discord bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services when the required environment variables are set:

- The Discord bridge forwards messages between Discord and the agent.
- The Telegram bridge forwards messages between Telegram and the agent.
- The cloudflared tunnel provides external access to the sandbox dashboard.

The Discord bridge starts only when both `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` are set.

## Step 11: Verify the Services

Check that the Discord bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Step 12: Send a Message

Open the configured Discord channel and send a message.
The bridge adds an eyes reaction, forwards the prompt to the OpenClaw agent inside the sandbox, and posts the agent response back to the channel.

## Step 13: Restrict Access by User ID

To restrict which Discord users can interact with the agent, set the `ALLOWED_USER_IDS` environment variable to a comma-separated list of Discord user IDs:

```console
$ export ALLOWED_USER_IDS="123456789012345678,987654321098765432"
$ nemoclaw start
```

## Step 14: Diagnose Discord Connectivity

Probe the Discord network path from inside the sandbox:

```console
$ nemoclaw the-crucible discord-probe
```

The probe checks DNS, proxy routing, HTTPS connectivity, and authenticated Discord Bot API access when a bot token is available.

## Step 15: Stop the Services

To stop the Discord bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

---

Forward messages between a Telegram bot and the OpenClaw agent running inside the sandbox.
The Telegram bridge is an auxiliary service managed by `nemoclaw start`.

## Step 16: Create a Telegram Bot

Open Telegram and send `/newbot` to [@BotFather](https://t.me/BotFather).
Follow the prompts to create a bot and receive a bot token.

## Step 17: Set the Environment Variable

Export the bot token as an environment variable:

```console
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
```

## Step 18: Start Auxiliary Services

Start the Telegram bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services:

- The Telegram bridge forwards messages between Telegram and the agent.
- The cloudflared tunnel provides external access to the sandbox.

The Telegram bridge starts only when the `TELEGRAM_BOT_TOKEN` environment variable is set.

## Step 19: Verify the Services

Check that the Telegram bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Step 20: Send a Message

Open Telegram, find your bot, and send a message.
The bridge forwards the message to the OpenClaw agent inside the sandbox and returns the agent response.

## Step 21: Restrict Access by Chat ID

To restrict which Telegram chats can interact with the agent, set the `ALLOWED_CHAT_IDS` environment variable to a comma-separated list of Telegram chat IDs:

```console
$ export ALLOWED_CHAT_IDS="123456789,987654321"
$ nemoclaw start
```

## Step 22: Stop the Services

To stop the Telegram bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Reference

- [Sandbox Image Hardening](references/sandbox-hardening.md)

## Related Skills

- `nemoclaw-monitor-sandbox` — Monitor Sandbox Activity for sandbox monitoring tools
- `nemoclaw-reference` — Commands for the full `deploy` command reference
