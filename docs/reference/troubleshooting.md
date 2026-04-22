---
title:
  page: "NemoClaw Troubleshooting Guide"
  nav: "Troubleshooting"
description:
  main: "Diagnose and resolve common NemoClaw installation, onboarding, and runtime issues."
  agent: "Diagnoses and resolves common NemoClaw installation, onboarding, and runtime issues. Use when troubleshooting errors, debugging sandbox problems, or resolving setup failures."
keywords: ["nemoclaw troubleshooting", "nemoclaw debug sandbox issues"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "troubleshooting", "nemoclaw"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!-- markdownlint-disable MD014 -->

# Troubleshooting

This page covers common issues you may encounter when installing, onboarding, or running NemoClaw, along with their resolution steps.

:::{admonition} Get Help
:class: tip

If your issue is not listed here, join the [NemoClaw Discord channel](https://discord.gg/XFpfPv9Uvx) to ask questions and get help from the community. You can also [file an issue on GitHub](https://github.com/NVIDIA/NemoClaw/issues/new).
:::

## Installation

### `nemoclaw` not found after install

If you use nvm or fnm to manage Node.js, the installer may not update your current shell's PATH.
The `nemoclaw` binary is installed but the shell session does not know where to find it.

Run `source ~/.bashrc` (or `source ~/.zshrc` for zsh), or open a new terminal window.

### Installer fails on unsupported platform

The installer checks for a supported OS and architecture before proceeding.
If you see an unsupported platform error, verify that you are running on a tested platform listed in the Container Runtimes table in the quickstart guide.

### Node.js version is too old

NemoClaw requires Node.js 22.16 or later.
If the installer exits with a Node.js version error, check your current version:

```console
$ node --version
```

If the version is below 22.16, install a supported release.
If you use nvm, run:

```console
$ nvm install 22
$ nvm use 22
```

Then re-run the installer.

### Image push fails with out-of-memory errors

The sandbox image is approximately 2.4 GB compressed. During image push, the Docker daemon, k3s, and the OpenShell gateway run alongside the export pipeline, which buffers decompressed layers in memory. On machines with less than 8 GB of RAM, this combined usage can trigger the OOM killer.

If you cannot add memory, configure at least 8 GB of swap to work around the issue at the cost of slower performance.

### Docker is not running

The installer and onboard wizard require Docker to be running.
If you see a Docker connection error, start the Docker daemon:

```console
$ sudo systemctl start docker
```

On macOS with Docker Desktop, open the Docker Desktop application and wait for it to finish starting before retrying.

### Docker permission denied on Linux

On Linux, if the Docker daemon is running but you see "permission denied" errors, your user may not be in the `docker` group.
Add your user and activate the group in the current shell:

```console
$ sudo usermod -aG docker $USER
$ newgrp docker
```

Then retry `nemoclaw onboard`.

### macOS first-run failures

The two most common first-run failures on macOS are missing developer tools and Docker connection errors.

To avoid these issues, install the prerequisites in the following order before running the NemoClaw installer:

1. Install Xcode Command Line Tools (`xcode-select --install`). These are needed by the installer and Node.js toolchain.
2. Install and start a supported container runtime (Docker Desktop or Colima). Without a running runtime, the installer cannot connect to Docker.

### Permission errors during installation

The NemoClaw installer does not require `sudo` or root.
It installs Node.js via nvm and NemoClaw via npm, both into user-local directories.
The installer also handles OpenShell installation automatically using a pinned release.

If you see permission errors during installation, they typically come from Docker, not the NemoClaw installer itself.
Docker must be installed and running before you run the installer, and installing Docker may require elevated privileges on Linux.

### npm install fails with permission errors

If `npm install` fails with an `EACCES` permission error, do not run npm with `sudo`.
Instead, configure npm to use a directory you own:

```console
$ mkdir -p ~/.npm-global
$ npm config set prefix ~/.npm-global
$ export PATH=~/.npm-global/bin:$PATH
```

Add the `export` line to your `~/.bashrc` or `~/.zshrc` to make it permanent, then re-run the installer.

### Installer fails on NVIDIA Jetson

The installer auto-detects NVIDIA Jetson devices (Orin and Thor) and applies required host configuration before the normal install flow.
If the Jetson setup step fails, verify that you have `sudo` access and that Docker is installed and running.

For JetPack 6 (L4T 36.x), the setup switches iptables to legacy mode and adjusts the Docker daemon configuration.
For JetPack 7 (L4T 38.x / Thor), only bridge netfilter and sysctl settings are applied.
BSP R39 and later do not require host customization and are handled automatically.

If the L4T version is not recognized, the setup step is skipped and the installer continues normally.

### Port already in use

The NemoClaw dashboard uses port `18789` by default and the gateway uses port `8080`.
If another process is already bound to one of these ports, onboarding fails.
Identify the conflicting process, verify it is safe to stop, and terminate it:

```console
$ sudo lsof -i :18789
$ kill <PID>
```

If the process does not exit, use `kill -9 <PID>` to force-terminate it.
Then retry onboarding.

Alternatively, override the conflicting port with an environment variable instead of stopping the other process:

```console
$ NEMOCLAW_DASHBOARD_PORT=19000 nemoclaw onboard
```

See [Environment Variables](commands.md#environment-variables) for the full list of port overrides.

### Running multiple sandboxes simultaneously

Each sandbox requires its own dashboard port.
If you onboard a second sandbox without overriding the port, onboarding fails because port `18789` is already claimed by the first sandbox.

Assign a distinct port to each sandbox at onboard time:

```console
$ nemoclaw onboard                              # first sandbox — uses default 18789
$ NEMOCLAW_DASHBOARD_PORT=19000 nemoclaw onboard  # second sandbox — uses 19000
```

Each sandbox then has its own SSH tunnel and its own dashboard URL:

```text
http://localhost:18789   ← first sandbox
http://localhost:19000   ← second sandbox
```

You can verify which tunnel belongs to which sandbox with:

```console
$ openshell forward list
```

## Onboarding

### Cgroup v2 errors during onboard

Older NemoClaw releases relied on a Docker cgroup workaround on Ubuntu 24.04, DGX Spark, and WSL2.
Current OpenShell releases handle that behavior themselves, so NemoClaw no longer requires a Spark-specific setup step.

If onboarding reports that Docker is missing or unreachable, fix Docker first and retry onboarding:

```console
$ nemoclaw onboard
```

Podman is not a tested runtime.
If onboarding or sandbox lifecycle fails, switch to a tested runtime (Docker Desktop, Colima, or Docker Engine) and rerun onboarding.

### OpenShell version above maximum

Each NemoClaw release validates against a range of tested OpenShell versions.
If the installed OpenShell version exceeds the configured maximum, `nemoclaw onboard` exits with an error:

```text
✗ openshell <version> is above the maximum supported by this NemoClaw release.
  blueprint.yaml max_openshell_version: <max>
```

Upgrade NemoClaw to a version that supports your OpenShell release, or install a supported OpenShell version from the [OpenShell releases page](https://github.com/NVIDIA/OpenShell/releases).

The `install-openshell.sh` script also enforces this constraint and pins fresh installs to the validated maximum version.

### Invalid sandbox name

Sandbox names must follow RFC 1123 subdomain rules: lowercase alphanumeric characters and hyphens only, and must start and end with an alphanumeric character.
Uppercase letters are automatically lowercased.

Names that collide with global CLI commands are also rejected.
Reserved names include `onboard`, `list`, `deploy`, `setup`, `start`, `stop`, `status`, `debug`, `uninstall`, `credentials`, and `help`.
Using a reserved name would cause the CLI to route to the global command instead of the sandbox.

If the name does not match these rules or is reserved, the wizard exits with an error.
Choose a name such as `my-assistant` or `dev1`.

### Sandbox creation fails on DGX

On DGX machines, sandbox creation can fail if the gateway's DNS has not finished propagating or if a stale port forward from a previous onboard run is still active.

Run `nemoclaw onboard` to retry.
The wizard cleans up stale port forwards and waits for gateway readiness automatically.

### Colima socket not detected (macOS)

Newer Colima versions use the XDG base directory (`~/.config/colima/default/docker.sock`) instead of the legacy path (`~/.colima/default/docker.sock`).
NemoClaw checks both paths.
If neither is found, verify that Colima is running:

```console
$ colima status
```

### Re-onboard fails because port 18789 is held by SSH

After destroying a sandbox and gateway, the SSH port-forward process for the
dashboard can be left running.
Re-running onboard then fails preflight with `Port 18789 is not available.
Blocked by: ssh`.

Current NemoClaw detects this case and kills the orphaned SSH process
automatically before retrying the port check.
If you see the error on an older release, identify the SSH process and
terminate it manually:

```console
$ sudo lsof -i :18789
$ kill <PID>
```

Then re-run `nemoclaw onboard`.

### Updated messaging token is not picked up

Re-running `nemoclaw onboard --non-interactive` with a new
`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, or `SLACK_BOT_TOKEN` previously
reported success while the sandbox kept polling with the old credential.
Current NemoClaw stores SHA-256 hashes of messaging credentials in the
sandbox registry at creation time and detects when a token has changed.
When rotation is detected, NemoClaw automatically backs up workspace state,
deletes the sandbox, recreates it with the new credential, and restores the
backup.

If you suspect a sandbox is still using a stale token, re-run onboarding so
the credential check runs:

```console
$ nemoclaw onboard --non-interactive
```

### Sandbox creation killed by OOM (exit 137)

On systems with 8 GB RAM or less and no swap configured, the sandbox image push can exhaust available memory and get killed by the Linux OOM killer (exit code 137).

NemoClaw automatically detects low memory during onboarding and prompts to create a 4 GB swap file.
If this automatic step fails or you are using a custom setup flow, create swap manually before running `nemoclaw onboard`:

```console
$ sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
$ sudo chmod 600 /swapfile
$ sudo mkswap /swapfile
$ sudo swapon /swapfile
$ echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
$ nemoclaw onboard
```

## Runtime

### Reconnect after a host reboot

After a host reboot, the container runtime, OpenShell gateway, and sandbox may not be running.
Follow these steps to reconnect.

1. Start the container runtime.

   - **Linux:** start Docker if it is not already running (`sudo systemctl start docker`)
   - **macOS:** open Docker Desktop or start Colima (`colima start`)

1. Check sandbox state.

   ```console
   $ openshell sandbox list
   ```

   If the sandbox shows `Ready`, skip to step 4.

1. Restart the gateway (if needed).

   If the sandbox is not listed or the command fails, restart the OpenShell gateway:

   ```console
   $ openshell gateway start --name nemoclaw
   ```

   Wait a few seconds, then re-check with `openshell sandbox list`.

1. Reconnect.

   ```console
   $ nemoclaw <name> connect
   ```

1. Start host auxiliary services (if needed).

   If you use the cloudflared tunnel started by `nemoclaw start`, start it again:

   ```console
   $ nemoclaw start
   ```

   Telegram, Discord, and Slack are handled by OpenShell-managed channel messaging configured at onboarding, not by a separate bridge process from `nemoclaw start`.

:::{admonition} If the sandbox does not recover
:class: warning

If the sandbox remains missing after restarting the gateway, run `nemoclaw onboard` to recreate it.
The wizard prompts for confirmation before destroying an existing sandbox. If you confirm, it **destroys and recreates** the sandbox. Workspace files (SOUL.md, USER.md, IDENTITY.md, AGENTS.md, MEMORY.md, and daily memory notes) are lost.
Back up your workspace first by following the instructions at [Back Up and Restore](../workspace/backup-restore.md).
:::

### Sandbox is running an outdated agent version

After upgrading NemoClaw, `nemoclaw <name> connect` and `nemoclaw <name> status` warn if the sandbox is running an older agent version than the current image.

To upgrade the sandbox while preserving workspace state, run:

```console
$ nemoclaw <name> rebuild
```

The rebuild command backs up state, destroys the old sandbox, recreates it with the current image, and restores state.
Create a snapshot before rebuilding if you want an additional safety net:

```console
$ nemoclaw <name> snapshot create
$ nemoclaw <name> rebuild
```

### Sandbox shows as stopped

The sandbox may have been stopped or deleted.
Run `nemoclaw onboard` to recreate the sandbox from the same blueprint and policy definitions.

### Status shows "not running" inside the sandbox

This is expected behavior.
When checking status inside an active sandbox, host-side sandbox state and inference configuration are not inspectable.
The status command detects the sandbox context and reports "active (inside sandbox)" instead.

Run `openshell sandbox list` on the host to check the underlying sandbox state.

### Inference requests time out

Verify that the inference provider endpoint is reachable from the host.
Check the active provider and endpoint:

```console
$ nemoclaw <name> status
```

For local Ollama and local vLLM, `nemoclaw <name> status` also prints an `Inference` line that probes the host-side health endpoint directly.
If that line shows `unreachable`, start the local backend first and then retry the request.

If the endpoint is correct but requests still fail, check for network policy rules that may block the connection.
Then verify the credential and base URL for the provider you selected during onboarding.

For local providers (Ollama, vLLM, NIM), the default timeout is 180 seconds.
If large prompts still cause timeouts, increase it with `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` before re-running onboard:

```console
$ export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
$ nemoclaw onboard
```

### Agent fails at runtime after onboarding succeeds with a compatible endpoint

Some OpenAI-compatible servers (such as SGLang) expose `/v1/responses` but their
streaming mode is incomplete.
OpenClaw requires granular streaming events like `response.output_text.delta`
that these backends do not emit.

For the compatible-endpoint provider, NemoClaw now defaults to
`/v1/chat/completions` and skips the Responses API probe entirely unless you
opt in.
If you onboarded an older release that selected `/v1/responses`, re-run
onboarding so the wizard rebuilds the image with chat completions:

```console
$ nemoclaw onboard
```

If you previously set `NEMOCLAW_PREFERRED_API=openai-responses` to force the
Responses API, unset it before re-running onboard.

Do not rely on `NEMOCLAW_INFERENCE_API_OVERRIDE` alone — it patches the config
at container startup but does not update the Dockerfile ARG baked into the
image.
A fresh `nemoclaw onboard` is the reliable fix.

### `NEMOCLAW_DISABLE_DEVICE_AUTH=1` does not change an existing sandbox

This is expected behavior.
`NEMOCLAW_DISABLE_DEVICE_AUTH` is a build-time setting used when NemoClaw creates the sandbox image.
Changing or exporting it later does not rewrite the baked `openclaw.json` inside an existing sandbox.

If you need a different device-auth setting, rerun onboarding so NemoClaw rebuilds the sandbox image with the desired configuration.
For the security trade-offs, refer to [Security Best Practices](../security/best-practices.md).

### `openclaw doctor --fix` cannot repair Discord channel config inside the sandbox

This is expected in NemoClaw-managed sandboxes.
NemoClaw bakes channel entries into `/sandbox/.openclaw/openclaw.json` at image build time, and OpenShell keeps that path read-only at runtime.

As a result, commands that try to rewrite the baked config from inside the sandbox, including `openclaw doctor --fix`, cannot repair Discord, Telegram, or Slack channel entries in place.

If your Discord channel config is wrong, rerun onboarding so NemoClaw rebuilds the sandbox image with the correct messaging selection.
Do not treat a failed `doctor --fix` run as proof that the Discord gateway path itself is broken.

If `openclaw doctor` reports that it moved Telegram single-account values under `channels.telegram.accounts.default`, rerun onboarding and rebuild the sandbox rather than trying to patch `openclaw.json` in place.
Current NemoClaw rebuilds bake Telegram in the account-based layout and set Telegram group chats to `groupPolicy: open`, which avoids the empty `groupAllowFrom` warning path for default group-chat access.

### Discord bot logs in, but the channel still does not work

Separate the problem into two parts:

1. Baked config and provider wiring

   Check that onboarding selected Discord and that the sandbox was created with the Discord messaging provider attached.
   If Discord was skipped during onboarding, rerun onboarding and select Discord again.

1. Native Discord gateway path

   Successful login alone does not prove that Discord works end to end.
   Discord also needs a working gateway connection to `gateway.discord.gg`.
   If logs show errors such as `getaddrinfo EAI_AGAIN gateway.discord.gg`, repeated reconnect loops, or a `400` response while probing the gateway path, the problem is usually in the native gateway/proxy path rather than in the baked config.

Common signs of a native gateway-path failure:

- REST calls to `discord.com` succeed, but the Discord channel never becomes healthy
- `gateway.discord.gg` fails with DNS resolution errors
- the WebSocket path returns `400` instead of opening a tunnel
- native command deployment fails even though the bot token itself is valid

In that case:

- keep the Discord policy preset applied
- verify the sandbox was created with the Discord provider attached
- inspect gateway logs and blocked requests with `openshell term`
- treat the failure as a native Discord gateway problem, not as a bridge startup problem

### Messaging bridge appears running but no messages arrive

Bot tokens for Telegram (`getUpdates`), Discord (gateway), and Slack (Socket Mode) only allow one active consumer per token. If two NemoClaw sandboxes are configured with the same bot token, each one kicks the other off its polling connection and neither delivers messages. `nemoclaw status` still reports the bridge as running because the gateway process itself is alive.

To diagnose, open a shell in the sandbox and inspect the gateway log:

```console
$ openshell term <sandbox-name>
$ tail -f /tmp/gateway.log
```

A repeating line like the following confirms the conflict:

```text
[telegram] getUpdates conflict: 409: Conflict: terminated by other getUpdates request; retrying in 30s.
```

To fix, run `nemoclaw <other-sandbox> destroy` on whichever sandbox should stop polling, or rerun onboarding on it with the channel disabled. Current NemoClaw warns at `nemoclaw onboard` time when another sandbox already has the same channel enabled, but sandboxes created before that check was added may still be in a conflict loop.

### Landlock filesystem restrictions silently degraded

After sandbox creation, NemoClaw checks whether the host kernel supports Landlock (Linux 5.13+).
If the kernel is too old or you are running on macOS (where the Docker VM kernel may lack Landlock), a warning prints:

```text
⚠ Landlock: Docker VM kernel <version> does not support Landlock (requires ≥5.13).
  Sandbox filesystem restrictions will silently degrade (best_effort mode).
```

This warning is informational and does not block sandbox creation.
The sandbox runs without kernel-level filesystem restrictions, relying on container mount configuration instead.
For full filesystem enforcement, run on a Linux kernel 5.13 or later (Ubuntu 22.04 LTS and later include Landlock support).

### Sandbox lost after gateway restart

Sandboxes created with OpenShell versions older than 0.0.24 can become unreachable after a gateway restart because SSH secrets were not persisted.
Running `nemoclaw onboard` automatically upgrades OpenShell to 0.0.24 or later during the preflight check.
After the upgrade, recreate the sandbox with `nemoclaw onboard`.

### Agent cannot reach external hosts through a proxy

NemoClaw uses a default proxy address of `10.200.0.1:3128` (the OpenShell-injected gateway).
If your environment uses a different proxy, set `NEMOCLAW_PROXY_HOST` and `NEMOCLAW_PROXY_PORT` before onboarding:

```console
$ export NEMOCLAW_PROXY_HOST=proxy.example.com
$ export NEMOCLAW_PROXY_PORT=8080
$ nemoclaw onboard
```

These are build-time settings baked into the sandbox image.
Changing them after onboarding requires re-running `nemoclaw onboard` to rebuild the image.

### Agent cannot reach an external host

OpenShell blocks outbound connections to hosts not listed in the network policy.
Open the TUI to see blocked requests and approve them:

```console
$ openshell term
```

To permanently allow an endpoint, add it to the network policy.
Refer to [Customize the Network Policy](../network-policy/customize-network-policy.md) for details.

### Dashboard not reachable after setting `NEMOCLAW_DASHBOARD_PORT`

If you ran `NEMOCLAW_DASHBOARD_PORT=<port> nemoclaw onboard` and onboarding completed
but the dashboard URL is unreachable (browser shows connection refused or the page fails
to load), the sandbox was most likely created with an older NemoClaw version that had a
bug where `NEMOCLAW_DASHBOARD_PORT` was parsed on the host but not passed into the sandbox
at startup. The gateway inside the sandbox continued listening on the default port 18789
while the SSH tunnel forwarded the custom port — leaving nothing at the other end of the
tunnel.

Re-run onboarding on the current NemoClaw release with the desired port. This rebuilds
the sandbox image with the gateway bound to the configured port:

```console
$ NEMOCLAW_DASHBOARD_PORT=19000 nemoclaw onboard
```

If you need to run multiple sandboxes at different ports at the same time, see
[Running multiple sandboxes simultaneously](#running-multiple-sandboxes-simultaneously).

### Ollama auth proxy did not start

NemoClaw keeps Ollama bound to `127.0.0.1:11434` and starts a token-gated
reverse proxy on `0.0.0.0:11435` so the sandbox can reach Ollama without
exposing it to the local network.
If the proxy fails to start, onboarding exits before configuring inference.

Check whether the proxy port is occupied by another process:

```console
$ sudo lsof -i :11435
```

Stop the conflicting process and re-run `nemoclaw onboard`.
The wizard cleans up stale proxy processes from previous runs automatically,
so most failures resolve by retrying.

The proxy token is persisted to `~/.nemoclaw/ollama-proxy-token` with `0600`
permissions.
If the file is missing or unreadable after a host reboot, re-running
`nemoclaw onboard` regenerates it.

### Local inference health check resolves to IPv6

Local inference health checks now use `127.0.0.1` instead of `localhost`.
On systems where `localhost` resolves to `::1` first, older NemoClaw releases
could probe the wrong address and report the local backend as unreachable
even when it was running.
If you see this on a current NemoClaw release, verify that the local backend
binds an IPv4 address and not only `::1`.

### Blueprint run failed

View the error output for the failed blueprint run:

```console
$ nemoclaw <name> logs
```

Use `--follow` to stream logs in real time while debugging.

(windows-wsl-2)=

## Windows Subsystem for Linux

For environment setup steps, see [Windows Prerequisites](../get-started/windows-setup.md).

### `wsl --install --no-distribution` returns Forbidden (403)

Check your network connectivity.
If you are behind a VPN, try reconnecting or switching to a different network.

### `wsl -d Ubuntu` says "There is no distribution with the supplied name"

The Ubuntu package was installed with `--no-launch` but never registered.
Run `ubuntu.exe install --root` from PowerShell to register it, or reinstall without `--no-launch`:

```console
$ wsl --unregister Ubuntu
$ wsl --install -d Ubuntu
```

### `docker info` fails inside WSL

Confirm that Docker Desktop is running and that WSL integration is enabled for Ubuntu (Settings > Resources > WSL integration).
Then restart WSL:

```console
$ wsl --shutdown
$ wsl -d Ubuntu
$ docker info
```

### Ollama inference fails or hangs in WSL

Ollama configures context length based on your hardware.
On some GPUs (for example RTX 3500), the default context length is not sufficient for OpenClaw.
Force a larger context length:

```console
$ pkill -f 'ollama serve'
$ OLLAMA_CONTEXT_LENGTH=16384 ollama serve
```

Verify that Ollama inference works:

```console
$ echo "Hello" | ollama run <model-id>
```

Replace `<model-id>` with the model you selected during onboarding (for example `qwen3.5:4b`).

If `ollama serve` fails with `Error: listen tcp 127.0.0.1:11434: bind: address already in use`, check whether Ollama is configured for automatic startup:

```console
$ sudo systemctl status ollama
```

If it is active, stop it first, then start with the custom context length:

```console
$ sudo systemctl stop ollama
$ OLLAMA_CONTEXT_LENGTH=16384 ollama serve
```

For additional troubleshooting, see the [Quickstart](../get-started/quickstart.md) and [Windows Setup](../get-started/windows-setup.md) pages.

## Podman

Podman is not a tested runtime.
OpenShell officially documents Docker-based runtimes only.
If you encounter issues with Podman, switch to a tested runtime (Docker Engine, Docker Desktop, or Colima) and rerun onboarding.
