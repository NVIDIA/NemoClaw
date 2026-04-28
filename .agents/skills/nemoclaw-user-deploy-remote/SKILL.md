---
name: "nemoclaw-user-deploy-remote"
description: "Explains how to run NemoClaw on a remote GPU instance, including the deprecated Brev compatibility path and the preferred installer plus onboard flow. Use when deploying NemoClaw to a remote VM, onboarding a Brev instance, or migrating away from the legacy `nemoclaw deploy` wrapper. Trigger keywords - deploy nemoclaw remote gpu, nemoclaw brev cloud deployment, nemoclaw sandbox hardening, container security, docker capabilities, process limits, nemoclaw telegram, telegram bot openclaw agent, openshell channel messaging."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy NemoClaw to a Remote GPU Instance with Brev

## Gotchas

- The `nemoclaw deploy` command is deprecated.
- On Brev, set `CHAT_UI_URL` in the launchable environment configuration so it is available when the installer builds the sandbox image.

## Prerequisites

- The [Brev CLI](https://brev.nvidia.com) installed and authenticated.
- A provider credential for the inference backend you want to use during onboarding.
- NemoClaw installed locally if you plan to use the deprecated `nemoclaw deploy` wrapper. Otherwise, install NemoClaw directly on the remote host after provisioning it.
- A machine where you can run `nemoclaw onboard` (local or remote host that runs the gateway and sandbox).
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
4. Starts optional host auxiliary services (for example the cloudflared tunnel) when `cloudflared` is available. Channel messaging is configured during onboarding and runs through OpenShell-managed processes, not through `nemoclaw tunnel start`.

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
$ ssh <instance-name> 'cd ~/nemoclaw && set -a && . .env && set +a && openshell term'
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
> When `CHAT_UI_URL` points at a non-loopback origin, NemoClaw disables OpenClaw device pairing in the generated sandbox configuration because browser-only remote users cannot complete terminal-based pairing.
> Any device that can reach the configured dashboard origin can connect without pairing, so avoid exposing that origin on internet-reachable or shared-network deployments.

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

Telegram, Discord, and Slack reach your agent through OpenShell-managed processes and gateway constructs.
NemoClaw configures those channels during `nemoclaw onboard`. Tokens are registered with OpenShell providers, channel configuration is baked into the sandbox image, and runtime delivery stays under OpenShell control.

`nemoclaw tunnel start` does not start Telegram (or other chat bridges). It only starts optional host services such as the cloudflared tunnel when that binary is present. (`nemoclaw start` is kept as a deprecated alias.)
For details, refer to Commands (use the `nemoclaw-user-reference` skill).

## Step 9: Create a Telegram Bot

Open Telegram and send `/newbot` to [@BotFather](https://t.me/BotFather).
Follow the prompts to create a bot and copy the bot token.

## Step 10: Provide the Bot Token and Optional Allowlist

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

## Step 11: Run `nemoclaw onboard`

Complete the rest of the wizard so the blueprint can create OpenShell providers (for example `<sandbox>-telegram-bridge`), bake channel configuration into the image (`NEMOCLAW_MESSAGING_CHANNELS_B64`), and start the sandbox.

Channel entries in `/sandbox/.openclaw/openclaw.json` are fixed at image build time. Landlock keeps that path read-only at runtime, so you cannot patch messaging config inside a running sandbox.

If you add or change `TELEGRAM_BOT_TOKEN` (or toggle channels) after a sandbox already exists, you typically need to run `nemoclaw onboard` again so the image and provider attachments are rebuilt with the new settings.

NemoClaw stores a SHA-256 hash of each messaging token in the sandbox registry at creation time.
When you re-run `nemoclaw onboard --non-interactive` with a new token, NemoClaw detects the change, backs up workspace state, deletes the sandbox, recreates it with the new credential, and restores the backup.
This makes credential rotation safe to script.

Telegram, Discord, and Slack each allow only one active consumer per bot token.
If you enable a messaging channel and another sandbox already uses the same token, onboard prompts you to confirm before continuing in interactive mode and exits non-zero in non-interactive mode.
`nemoclaw status` also reports cross-sandbox overlaps so you can resolve duplicates before messages start dropping.

For a full first-time flow, refer to Quickstart (use the `nemoclaw-user-get-started` skill).

## Step 12: Confirm Delivery

After the sandbox is running, send a message to your bot in Telegram.
If something fails, use `openshell term` on the host, check gateway logs, and verify network policy allows the Telegram API (see Customize the Network Policy (use the `nemoclaw-user-manage-policy` skill) and the `telegram` preset).

## Step 13: `nemoclaw tunnel start` (cloudflared Only)

`nemoclaw tunnel start` starts cloudflared when it is installed, which can expose the dashboard with a public URL.
It does not affect Telegram connectivity. The older `nemoclaw start` still works as a deprecated alias.

```console
$ nemoclaw tunnel start
```

To pause the Telegram bridge without removing its credentials or destroying the sandbox, use `nemoclaw <name> channels stop telegram`. Re-enable it later with `nemoclaw <name> channels start telegram`.

## References

- **Load [references/sandbox-hardening.md](references/sandbox-hardening.md)** when reviewing sandbox image security controls, auditing capability drops, or looking up the runtime resource limits. Includes the sandbox container image hardening reference, covering Docker capabilities and process limits.

## Related Skills

- `nemoclaw-user-monitor-sandbox` — Monitor Sandbox Activity (use the `nemoclaw-user-monitor-sandbox` skill) for sandbox monitoring tools
- `nemoclaw-user-reference` — Commands (use the `nemoclaw-user-reference` skill) for the full `deploy` command reference
