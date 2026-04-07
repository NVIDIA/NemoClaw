---
title:
  page: "Back Up and Restore Workspace Files"
  nav: "Back Up & Restore"
description:
  main: "How to back up and restore OpenClaw workspace files before destructive operations."
  agent: "Backs up and restores OpenClaw workspace files before destructive operations. Use when backing up a sandbox, restoring workspace state, or preparing for a destructive operation."
keywords: ["nemoclaw backup", "nemoclaw restore", "workspace backup", "openshell sandbox download upload"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "workspace", "backup", "nemoclaw"]
content:
  type: how_to
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Back Up and Restore Workspace Files

Workspace files define your agent's personality, memory, and user context.
They persist across sandbox restarts but are **permanently deleted** when you run `nemoclaw <name> destroy`.

This guide covers manual backup with CLI commands and an automated script.

## Prerequisites

- A running NemoClaw sandbox (for backup) or a freshly created sandbox (for restore).
- The OpenShell CLI on your `PATH`.
- The sandbox name (shown by `nemoclaw list`).

## When to Back Up

- Before running `nemoclaw <name> destroy`.
- Before major NemoClaw version upgrades.
- Periodically, if you have invested time customizing your agent.

## Manual Backup

Use `openshell sandbox download` to copy files from the sandbox to your host.

```console
$ SANDBOX=my-assistant
$ BACKUP_DIR=~/.nemoclaw/backups/$(date +%Y%m%d-%H%M%S)
$ mkdir -p "$BACKUP_DIR"

$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/SOUL.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/USER.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/IDENTITY.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/AGENTS.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/MEMORY.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/memory/ "$BACKUP_DIR/memory/"
```

## Manual Restore

Use `openshell sandbox upload` to push files back into a sandbox.

```console
$ SANDBOX=my-assistant
$ BACKUP_DIR=~/.nemoclaw/backups/20260320-120000  # pick a timestamp

$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/SOUL.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/USER.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/IDENTITY.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/AGENTS.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/MEMORY.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/memory/" /sandbox/.openclaw/workspace/memory/
```

## Using the Backup Script

The repository includes a convenience script at `scripts/backup-workspace.sh`.

### Backup

```console
$ ./scripts/backup-workspace.sh backup my-assistant
Backing up workspace from sandbox 'my-assistant'...
Backup saved to /home/user/.nemoclaw/backups/20260320-120000/ (6 items)
```

### Restore

Restore from the most recent backup:

```console
$ ./scripts/backup-workspace.sh restore my-assistant
```

Restore from a specific timestamp:

```console
$ ./scripts/backup-workspace.sh restore my-assistant 20260320-120000
```

## Verifying a Backup

List backed-up files to confirm completeness:

```console
$ ls ~/.nemoclaw/backups/20260320-120000/
AGENTS.md
IDENTITY.md
MEMORY.md
SOUL.md
USER.md
memory/
```

## Inspecting Files Inside the Sandbox

Connect to the sandbox to list or view workspace files directly:

```console
$ openshell sandbox connect my-assistant
$ ls -la /sandbox/.openclaw/workspace/
```

## Next Steps

- [Workspace Files overview](workspace-files.md) to learn what each file does
- [Commands reference](../reference/commands.md)
- [Monitor Sandbox Activity](../monitoring/monitor-sandbox-activity.md)
