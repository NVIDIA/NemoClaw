---
title:
  page: "NemoClaw CLI Commands Reference"
  nav: "Commands"
description: "Full CLI reference for slash commands and standalone NemoClaw commands."
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

The `nemoclaw` CLI is the primary interface for managing NemoClaw sandboxes. It is installed when you run `npm install -g nemoclaw`.

## `/nemoclaw` Slash Command

The `/nemoclaw` slash command is available inside the OpenClaw chat interface for quick actions:

| Subcommand | Description |
|---|---|
| `/nemoclaw` | Show slash-command help and host CLI pointers |
| `/nemoclaw status` | Show sandbox and inference state |
| `/nemoclaw onboard` | Show onboarding status and reconfiguration guidance |
| `/nemoclaw eject` | Show rollback instructions for returning to the host installation |

## Standalone Host Commands

The `nemoclaw` binary handles host-side operations that run outside the OpenClaw plugin context.

### `nemoclaw help`, `nemoclaw --help`, `nemoclaw -h`

Show the top-level usage summary and command groups.
Running `nemoclaw` with no arguments shows the same help output.

```console
$ nemoclaw help
```

### `nemoclaw --version`, `nemoclaw -v`

Print the installed NemoClaw CLI version.

```console
$ nemoclaw --version
```

### `nemoclaw onboard`

Run the interactive setup wizard.
The wizard creates an OpenShell gateway, registers inference providers, builds the sandbox image, and creates the sandbox.
Use this command for new installs and for recreating a sandbox after changes to policy or configuration.

```console
$ nemoclaw onboard
```

The wizard prompts for a provider first, then collects the provider credential if needed.
Supported non-experimental choices include NVIDIA Endpoints, OpenAI, Anthropic, Google Gemini, and compatible OpenAI or Anthropic endpoints.
Credentials are stored in `~/.nemoclaw/credentials.json`.

The wizard prompts for a sandbox name.
Names must follow RFC 1123 subdomain rules: lowercase alphanumeric characters and hyphens only, and must start and end with an alphanumeric character.
Uppercase letters are automatically lowercased.

Before creating the gateway, the wizard runs preflight checks.
On systems with cgroup v2 (Ubuntu 24.04, DGX Spark, WSL2), it verifies that Docker is configured with `"default-cgroupns-mode": "host"` and provides fix instructions if the setting is missing.

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

:::{warning}
Destroying a sandbox permanently deletes all files inside it, including
[workspace files](../workspace/workspace-files.md) (SOUL.md, USER.md, IDENTITY.md, AGENTS.md, MEMORY.md, and daily memory notes).
Back up your workspace first by following the instructions at [Back Up and Restore](../workspace/backup-restore.md).
:::

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
After the fixes complete, the script prompts you to run `nemoclaw onboard` to continue setup.

```console
$ sudo nemoclaw setup-spark
```

### `nemoclaw debug`

Collect diagnostics for bug reports.
Gathers system info, Docker state, gateway logs, and sandbox status into a summary or tarball.
Use `--sandbox <name>` to target a specific sandbox, `--quick` for a smaller snapshot, or `--output <path>` to save a tarball that you can attach to an issue.

```console
$ nemoclaw debug [--quick] [--sandbox NAME] [--output PATH]
```

| Flag | Description |
|------|-------------|
| `--quick` | Collect minimal diagnostics only |
| `--sandbox NAME` | Target a specific sandbox (default: auto-detect) |
| `--output PATH` | Write diagnostics tarball to the given path |

### `nemoclaw uninstall`

Run `uninstall.sh` to remove NemoClaw sandboxes, gateway resources, related images and containers, and local state.
The CLI uses the local `uninstall.sh` first and falls back to the hosted script if the local file is unavailable.

| Flag | Effect |
|---|---|
| `--yes` | Skip the confirmation prompt |
| `--keep-openshell` | Leave the `openshell` binary installed |
| `--delete-models` | Also remove NemoClaw-pulled Ollama models |

```console
$ nemoclaw uninstall [--yes] [--keep-openshell] [--delete-models]
```

### `nemoclaw setup` (deprecated)

Run the legacy setup workflow for backwards compatibility.
NemoClaw prints a deprecation warning, then runs the older `setup.sh` path.
Prefer `nemoclaw onboard` for new installs and reconfiguration.

```console
$ nemoclaw setup
```
