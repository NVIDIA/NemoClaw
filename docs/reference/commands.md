---
title:
  page: "NemoClaw CLI Commands Reference"
  nav: "Commands"
description: "Full CLI reference for plugin and standalone NemoClaw commands."
keywords: ["nemoclaw cli commands", "nemoclaw command reference"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "nemoclaw", "cli"]
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

# Commands

NemoClaw provides two command interfaces.
The plugin commands run under the `openclaw nemoclaw` namespace inside the OpenClaw CLI.
The standalone `nemoclaw` binary handles host-side setup, deployment, and service management.
Both interfaces are installed when you run `npm install -g nemoclaw`.

## Plugin Commands

### `openclaw nemoclaw launch`

Bootstrap OpenClaw inside an OpenShell sandbox.
If NemoClaw detects an existing host installation, `launch` stops unless you pass `--force`.

```console
$ openclaw nemoclaw launch [--force] [--profile <profile>]
```

`--force`
: Skip the ergonomics warning and force plugin-driven bootstrap. Without this flag,
  NemoClaw recommends using `openshell sandbox create` directly for new installs.

`--profile <profile>`
: Blueprint profile to use. Default: `default`.

### `nemoclaw <name> connect`

Open an interactive shell inside the OpenClaw sandbox.
Use this after launch to connect and chat with the agent through the TUI or CLI.

```console
$ nemoclaw my-assistant connect
```

### `openclaw nemoclaw status`

Display sandbox health, blueprint run state, and inference configuration.

```console
$ openclaw nemoclaw status [--json]
```

`--json`
: Output as JSON for programmatic consumption.

When you run `status` inside an active OpenShell sandbox, host-level commands like `openshell sandbox status` are unavailable. The status command detects this and reports the sandbox context instead of showing false negatives. Run `openshell sandbox status` on the host for full details.

### `openclaw nemoclaw logs`

Stream blueprint execution and sandbox logs.

```console
$ openclaw nemoclaw logs [-f] [-n <count>] [--run-id <id>]
```

`-f, --follow`
: Follow log output, similar to `tail -f`.

`-n, --lines <count>`
: Number of lines to show. Default: `50`.

`--run-id <id>`
: Show logs for a specific blueprint run instead of the latest.

### `/nemoclaw` Slash Command

The `/nemoclaw` slash command is available inside the OpenClaw chat interface for quick actions:

| Subcommand | Description |
|---|---|
| `/nemoclaw status` | Show sandbox and inference state |

## Standalone Host Commands

The `nemoclaw` binary handles host-side operations that run outside the OpenClaw plugin context.

### `nemoclaw onboard`

Run the interactive setup wizard.
The wizard creates an OpenShell gateway, registers inference providers, builds the sandbox image, and creates the sandbox.
Use this command for new installs and for recreating a sandbox after changes to policy or configuration.

```console
$ nemoclaw onboard
```

The first run prompts for your NVIDIA API key and saves it to `~/.nemoclaw/credentials.json`.

The onboard wizard runs a preflight check before creating the gateway. On systems with cgroup v2, such as Ubuntu 24.04 and DGX Spark, the preflight verifies that Docker is configured with `"default-cgroupns-mode": "host"` in `/etc/docker/daemon.json`. If this setting is missing, `nemoclaw onboard` exits with an error and directs you to run `nemoclaw setup-spark` to apply the fix.

By default, the onboard menu shows NVIDIA cloud inference options only. To enable experimental local inference options (NIM, vLLM, Ollama), set the `NEMOCLAW_EXPERIMENTAL` environment variable before running onboard:

```console
$ NEMOCLAW_EXPERIMENTAL=1 nemoclaw onboard
```

### `nemoclaw list`

List all registered sandboxes with their model, provider, and policy presets.

```console
$ nemoclaw list
```

### `nemoclaw deploy`

:::{warning}
The `nemoclaw deploy` command is experimental and may not work as expected.
:::

Deploy NemoClaw to a remote GPU instance through [Brev](https://brev.nvidia.com).
The deploy script installs Docker, NVIDIA Container Toolkit if a GPU is present, and OpenShell on the VM, then runs the nemoclaw setup and connects to the sandbox.

```console
$ nemoclaw deploy <instance-name>
```

### `nemoclaw <name> connect`

Connect to a sandbox by name.

```console
$ nemoclaw my-assistant connect
```

### `nemoclaw <name> status`

Show sandbox status, health, and inference configuration.

```console
$ nemoclaw my-assistant status
```

### `nemoclaw <name> logs`

View sandbox logs.
Use `--follow` to stream output in real time.

```console
$ nemoclaw my-assistant logs [--follow]
```

### `nemoclaw <name> destroy`

Stop the NIM container and delete the sandbox.
This removes the sandbox from the registry.

```console
$ nemoclaw my-assistant destroy
```

### `nemoclaw <name> policy-add`

Add a policy preset to a sandbox.
Presets extend the baseline network policy with additional endpoints.

```console
$ nemoclaw my-assistant policy-add
```

### `nemoclaw <name> policy-list`

List available policy presets and show which ones are applied to the sandbox.

```console
$ nemoclaw my-assistant policy-list
```

### `openshell term`

Open the OpenShell TUI to monitor sandbox activity and approve network egress requests.
Run this on the host where the sandbox is running.

```console
$ openshell term
```

For a remote Brev instance, SSH to the instance and run `openshell term` there, or use a port-forward to the gateway.

### `nemoclaw start`

Start auxiliary services, such as the Telegram bridge and cloudflared tunnel.

```console
$ nemoclaw start
```

Requires `TELEGRAM_BOT_TOKEN` for the Telegram bridge.

### `nemoclaw stop`

Stop all auxiliary services.

```console
$ nemoclaw stop
```

### `nemoclaw status`

Show the sandbox list and the status of auxiliary services.

```console
$ nemoclaw status
```

### `nemoclaw setup-spark`

Set up NemoClaw on DGX Spark.
This command applies cgroup v2 and Docker fixes required for Ubuntu 24.04.
Run with `sudo` on the Spark host.
