---
name: "nemoclaw-user-workspace"
description: "Backs up and restores OpenClaw workspace files before destructive operations such as sandbox rebuilds. Use when downloading workspace files from a sandbox, uploading restored files into a new sandbox, or preserving sandbox state across rebuilds. Trigger keywords - nemoclaw backup, nemoclaw restore, workspace backup, openshell sandbox download upload, nemoclaw workspace files, soul.md, user.md, identity.md, agents.md, sandbox persistence."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Backup and Restore Workspace Files

Workspace files define your agent's personality, memory, and user context.
They persist across sandbox restarts but are **permanently deleted** when you run `nemoclaw <name> destroy`.

This guide covers snapshot commands, manual backup with CLI commands, and an automated script.

## Step 1: When to Back Up

- **Before running `nemoclaw <name> destroy`**
- Before major NemoClaw version upgrades
- Periodically, if you've invested time customizing your agent

## Step 2: Snapshot Commands

The fastest way to back up and restore sandbox state is with the built-in snapshot commands.
Snapshots capture all workspace state directories defined in the agent manifest and store them in `~/.nemoclaw/rebuild-backups/<name>/`.

```console
$ nemoclaw my-assistant snapshot create
$ nemoclaw my-assistant snapshot list
$ nemoclaw my-assistant snapshot restore
```

To restore a specific snapshot instead of the latest, pass a timestamp or prefix:

```console
$ nemoclaw my-assistant snapshot restore 2026-04-14T
```

The `nemoclaw <name> rebuild` command uses the same snapshot mechanism automatically.
For full details, see the Commands reference (use the `nemoclaw-user-reference` skill).

## Step 3: Manual Backup

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

## Step 4: Manual Restore

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

## Step 5: Using the Backup Script

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

## Step 6: Verifying a Backup

List backed-up files to confirm completeness:

```console
$ ls -la ~/.nemoclaw/backups/20260320-120000/
AGENTS.md
IDENTITY.md
MEMORY.md
SOUL.md
USER.md
memory/
```

## References

- **Load [references/workspace-files.md](references/workspace-files.md)** when users ask about `SOUL.md`, `USER.md`, `IDENTITY.md`, `AGENTS.md`, or other workspace files, or when preparing to back up or restore workspace state. Explains what workspace personality and configuration files are, where they live, and how they persist across sandbox restarts.

## Related Skills

- `nemoclaw-user-reference` — Commands reference (use the `nemoclaw-user-reference` skill)
