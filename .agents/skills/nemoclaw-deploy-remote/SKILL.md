---
name: nemoclaw-deploy-remote
description: Provisions a remote GPU VM with NemoClaw using Brev deployment. Also covers forwards messages between Telegram and the sandboxed OpenClaw agent. Use when deploy nemoclaw remote gpu, deployment, gpu, nemoclaw, nemoclaw brev cloud deployment, nemoclaw telegram bridge, openclaw, openshell.
---

# Nemoclaw Deploy Remote

Provision a remote GPU VM with NemoClaw using Brev deployment.

## Prerequisites

- The [Brev CLI](https://brev.nvidia.com) installed and authenticated.
- An NVIDIA API key from [build.nvidia.com](https://build.nvidia.com).
- NemoClaw installed locally. Follow the Quickstart (see the `nemoclaw-get-started` skill) install steps.
- A running NemoClaw sandbox, either local or remote.
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
4. Starts auxiliary services, such as the Telegram bridge and cloudflared tunnel.

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

Forward messages between a Telegram bot and the OpenClaw agent running inside the sandbox.
The Telegram bridge is an auxiliary service managed by `nemoclaw start`.

## Step 6: Create a Telegram Bot

Open Telegram and send `/newbot` to [@BotFather](https://t.me/BotFather).
Follow the prompts to create a bot and receive a bot token.

## Step 7: Set the Environment Variable

Export the bot token as an environment variable:

```console
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
```

## Step 8: Start Auxiliary Services

Start the Telegram bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services:

- The Telegram bridge forwards messages between Telegram and the agent.
- The cloudflared tunnel provides external access to the sandbox.

The Telegram bridge starts only when the `TELEGRAM_BOT_TOKEN` environment variable is set.

## Step 9: Verify the Services

Check that the Telegram bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Step 10: Send a Message

Open Telegram, find your bot, and send a message.
The bridge forwards the message to the OpenClaw agent inside the sandbox and returns the agent response.

## Step 11: Restrict Access by Chat ID

To restrict which Telegram chats can interact with the agent, set the `ALLOWED_CHAT_IDS` environment variable to a comma-separated list of Telegram chat IDs:

```console
$ export ALLOWED_CHAT_IDS="123456789,987654321"
$ nemoclaw start
```

## Step 12: Stop the Services

To stop the Telegram bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Related Skills

- `nemoclaw-monitor-sandbox` — Monitor Sandbox Activity for sandbox monitoring tools
- `nemoclaw-reference` — Commands for the full `deploy` command reference
