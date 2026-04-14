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

### Port already in use

The NemoClaw gateway uses port `18789` by default.
If another process is already bound to this port, onboarding fails.
Identify the conflicting process, verify it is safe to stop, and terminate it:

```console
$ sudo lsof -i :18789
$ kill <PID>
```

If the process does not exit, use `kill -9 <PID>` to force-terminate it.
Then retry onboarding.

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

### Local inference on WSL2 + Docker Desktop

On WSL2 with Docker Desktop, the conventional `host.openshell.internal`
gateway hostname (backed by Docker's `host-gateway`) often resolves to
an IPv6 ULA or an un-routable gateway IP. That can hang the onboard
container reachability probe (step 4/8) and break inference routing to
a host-side Ollama or vLLM.

Onboarding now detects this combination and probes a list of candidate
host IPs in order:

1. The WSL distro's outbound IPv4 (`ip -4 -o route get 1.1.1.1`) —
   correct when Ollama or vLLM runs **inside WSL**.
2. The WSL2 default gateway (`ip -4 -o route show default`) — correct
   when Ollama or vLLM runs on the **Windows host** in NAT networking
   mode.
3. Other interface addresses from `hostname -I`.

The first candidate whose container-side probe succeeds is injected
into both `OPENAI_BASE_URL` and the reachability check, and persisted
to the sandbox registry entry as `resolvedHostIp`. No manual override
is needed for either Ollama placement.

In WSL **mirrored** networking mode, `host.openshell.internal` already
reaches the shared network stack directly, so no override is applied.

#### Host-side prerequisites for Windows-hosted Ollama

If Ollama runs on the **Windows host** (not inside WSL), NemoClaw's
detection only helps once the host itself is actually reachable from
WSL. Run the following checks in the indicated shell.

**1. Bind Ollama to all interfaces (run in PowerShell, as Administrator):**

```powershell
# Persist across reboots; Machine scope so services also inherit it.
[System.Environment]::SetEnvironmentVariable('OLLAMA_HOST','0.0.0.0:11434','Machine')

# Stop Ollama (tray + server) and start it in a new shell so it picks
# up the new env var. Open a NEW PowerShell window first, then:
Get-Process | Where-Object { $_.ProcessName -like 'ollama*' } | Stop-Process -Force
ollama serve
```

Verify the bind address (run in PowerShell):

```powershell
Get-NetTCPConnection -LocalPort 11434 -State Listen | Select LocalAddress, LocalPort
# Expect: 0.0.0.0 or [::] — NOT 127.0.0.1
```

**2. Allow inbound TCP 11434 in Windows Defender Firewall (PowerShell, Administrator):**

```powershell
New-NetFirewallRule -DisplayName "Ollama 11434 (WSL)" `
  -Direction Inbound -Protocol TCP -LocalPort 11434 `
  -Action Allow -Profile Any
```

**3. Switch WSL2 to mirrored networking mode.** On recent Windows 11,
WSL2 in NAT mode routes traffic through a separate Hyper-V firewall
layer that ignores standard inbound rules (you will see
`NATInboundRuleNotApplicable` on `Get-NetFirewallHyperVRule`). Mirrored
mode makes WSL share the Windows network stack directly.

Edit `%USERPROFILE%\.wslconfig` (PowerShell or Notepad on Windows):

```ini
[wsl2]
networkingMode=mirrored
```

Then apply (run in PowerShell):

```powershell
wsl --shutdown
```

Reopen your WSL terminal and verify Ollama is reachable (run in WSL):

```bash
curl --max-time 5 http://127.0.0.1:11434/api/tags
# Expect: JSON list of installed models.
```

#### If the container reachability check still fails

If onboarding still reports that the container reachability check
failed for `http://host.openshell.internal:11434`:

- Double-check the bind address (PowerShell): Ollama shows
  `127.0.0.1` in `Get-NetTCPConnection` until the env var reaches the
  process from a fresh shell.
- Confirm the firewall rule is enabled (PowerShell):
  `Get-NetFirewallRule -DisplayName "Ollama 11434 (WSL)" | Select Enabled, Profile`.
- If you cannot switch to mirrored mode, manually set the base URL
  using the WSL2 default gateway (run in WSL to find it):
  ```bash
  ip route show default | awk '/default/ {print $3}'
  ```
  then export that IP as `OPENAI_BASE_URL=http://<gateway-ip>:11434/v1`.
- Last resort: install Docker Engine directly inside WSL2 instead of
  Docker Desktop — `host-gateway` works reliably there.

Sandbox pod → host egress is a separate path from the onboard probe. If
inference calls still fail from inside a running sandbox, verify the
sandbox's `HTTP_PROXY` / `ALL_PROXY` env vars include the resolved host
IP in `NO_PROXY`.

### Invalid sandbox name

Sandbox names must follow RFC 1123 subdomain rules: lowercase alphanumeric characters and hyphens only, and must start and end with an alphanumeric character.
Uppercase letters are automatically lowercased.

If the name does not match these rules, the wizard exits with an error.
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

If the endpoint is correct but requests still fail, check for network policy rules that may block the connection.
Then verify the credential and base URL for the provider you selected during onboarding.

For local providers (Ollama, vLLM, NIM), the default timeout is 180 seconds.
If large prompts still cause timeouts, increase it with `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` before re-running onboard:

```console
$ export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
$ nemoclaw onboard
```

### `NEMOCLAW_DISABLE_DEVICE_AUTH=1` does not change an existing sandbox

This is expected behavior.
`NEMOCLAW_DISABLE_DEVICE_AUTH` is a build-time setting used when NemoClaw creates the sandbox image.
Changing or exporting it later does not rewrite the baked `openclaw.json` inside an existing sandbox.

If you need a different device-auth setting, rerun onboarding so NemoClaw rebuilds the sandbox image with the desired configuration.
For the security trade-offs, refer to [Security Best Practices](../security/best-practices.md).

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

### Blueprint run failed

View the error output for the failed blueprint run:

```console
$ nemoclaw <name> logs
```

Use `--follow` to stream logs in real time while debugging.

## Podman

Podman is not a tested runtime.
OpenShell officially documents Docker-based runtimes only.
If you encounter issues with Podman, switch to a tested runtime (Docker Engine, Docker Desktop, or Colima) and rerun onboarding.
