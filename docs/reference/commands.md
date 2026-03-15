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

Bootstrap a fresh OpenClaw installation inside an OpenShell sandbox.

```console
$ openclaw nemoclaw launch [--force] [--profile <profile>]
```

`--force`
: Skip the ergonomics warning and force plugin-driven bootstrap. Without this flag,
  NemoClaw recommends using `openshell sandbox create` directly for new installs.

`--profile <profile>`
: Blueprint profile to use. Default: `default`.

### `openclaw nemoclaw migrate`

Migrate an existing host OpenClaw installation into an OpenShell sandbox.
The command creates a snapshot of the current state before making changes.

```console
$ openclaw nemoclaw migrate [--dry-run] [--profile <profile>] [--skip-backup]
```

`--dry-run`
: Show what would be migrated without making changes.

`--profile <profile>`
: Blueprint profile to use. Default: `default`.

`--skip-backup`
: Skip creating a host backup snapshot before migration.

### `openclaw nemoclaw connect`

Open an interactive shell inside the OpenClaw sandbox.

```console
$ openclaw nemoclaw connect [--sandbox <name>]
```

`--sandbox <name>`
: Sandbox name to connect to. Default: `openclaw`.

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

### `openclaw nemoclaw eject`

Roll back from the sandbox and restore the host OpenClaw installation from a snapshot.

```console
$ openclaw nemoclaw eject [--run-id <id>] [--confirm]
```

`--run-id <id>`
: Specific blueprint run ID to rollback from. Without this, uses the most recent run.

`--confirm`
: Skip the confirmation prompt.

### `/nemoclaw` Slash Command

The `/nemoclaw` slash command is available inside the OpenClaw chat interface for quick actions:

| Subcommand | Description |
|---|---|
| `/nemoclaw status` | Show sandbox and inference state |
| `/nemoclaw eject` | Show rollback instructions |

## Standalone Wrapper Commands

The `nemoclaw` binary handles host-side operations that run outside the OpenClaw plugin context.

### `nemoclaw setup`

Run the full host-side setup: start an OpenShell gateway, register inference providers, build the sandbox image, and create the sandbox.

```console
$ nemoclaw setup
```

The first run prompts for your NVIDIA API key and saves it to `~/.nemoclaw/credentials.json`.

### `nemoclaw deploy`

Deploy NemoClaw to a remote GPU instance through [Brev](https://brev.nvidia.com).
The deploy script installs Docker, NVIDIA Container Toolkit if a GPU is present, and OpenShell on the VM, then runs setup and connects to the sandbox.

```console
$ nemoclaw deploy <instance-name>
```

### `nemoclaw connect`

Connect to a local or remote sandbox.

```console
$ nemoclaw connect               # local sandbox
$ nemoclaw connect my-gpu-box    # remote Brev instance
```

### `nemoclaw term`

Open the OpenShell TUI to monitor sandbox activity and approve network egress requests.

```console
$ nemoclaw term                  # local
$ nemoclaw term my-gpu-box       # remote Brev instance
```

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

Show the status of running auxiliary services.

```console
$ nemoclaw status
```
