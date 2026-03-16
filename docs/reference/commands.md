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

## Standalone Wrapper Commands

The `nemoclaw` binary handles host-side operations that run outside the OpenClaw plugin context.

### `nemoclaw onboard`

Run the guided host-side setup flow to configure inference, create a sandbox, and apply policy presets.

```console
$ nemoclaw onboard
```

The first run prompts for your NVIDIA API key and saves it to `~/.nemoclaw/credentials.json`.

### `nemoclaw setup`

Run the legacy host-side setup wrapper.
This command is deprecated in favor of `nemoclaw onboard`.

```console
$ nemoclaw setup
```

### `nemoclaw setup-spark`

Apply the DGX Spark-specific setup flow, including the cgroup v2 and Docker workarounds used by NemoClaw.

```console
$ nemoclaw setup-spark
```

### `nemoclaw deploy`

Deploy NemoClaw to a remote GPU instance through [Brev](https://brev.nvidia.com).
The deploy script installs Docker, NVIDIA Container Toolkit if a GPU is present, and OpenShell on the VM, then runs setup and connects to the sandbox.

```console
$ nemoclaw deploy <instance-name>
```

### `nemoclaw list`

List registered sandboxes on the host.

```console
$ nemoclaw list
```

### `nemoclaw <name> connect`

Connect to a sandbox by name.

```console
$ nemoclaw my-assistant connect
```

### `nemoclaw <name> status`

Show the registered sandbox metadata, the current OpenShell sandbox state, and local NIM health.

```console
$ nemoclaw my-assistant status
```

### `nemoclaw <name> logs`

View sandbox logs, with optional follow mode.

```console
$ nemoclaw my-assistant logs [--follow]
```

### `nemoclaw <name> policy-add`

Interactively apply a policy preset to a sandbox.

```console
$ nemoclaw my-assistant policy-add
```

### `nemoclaw <name> policy-list`

List policy presets and show which ones are already applied to the sandbox.

```console
$ nemoclaw my-assistant policy-list
```

### `nemoclaw <name> destroy`

Stop the local NIM container for a sandbox and delete the sandbox.

```console
$ nemoclaw my-assistant destroy
```

### `openshell term`

Open the OpenShell TUI to monitor sandbox activity and approve network egress requests.

```console
$ openshell term
```

For remote Brev instances, SSH to the VM first and then run `openshell term`.

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

Show the registered sandboxes and the status of auxiliary services.

```console
$ nemoclaw status
```
