---
name: "nemoclaw-user-workspace"
description: "Hows to back up and restore OpenClaw workspace files before destructive operations. Whats workspace personality and configuration files are, where they live, and how they persist across sandbox restarts."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Workspace

How to back up and restore OpenClaw workspace files before destructive operations.

## Context

OpenClaw stores its personality, user context, and behavioral configuration in a set of Markdown files inside the sandbox.
These files live at `/sandbox/.openclaw/workspace/` and are collectively called **workspace files**.

## File Reference

| File | Purpose |
|---|---|
| `SOUL.md` | Defines the agent's persona, tone, and communication style. |
| `USER.md` | Stores information about the human the agent assists. |
| `IDENTITY.md` | Short identity card — name, language, emoji, creature type. |
| `AGENTS.md` | Behavioral rules, memory conventions, safety guidelines, and session workflow. |
| `MEMORY.md` | Curated long-term memory distilled from daily notes. |
| `memory/` | Directory of daily note files (`YYYY-MM-DD.md`) for session continuity. |

## Where They Live

All workspace files reside inside the sandbox filesystem:

```text
/sandbox/.openclaw/workspace/
├── AGENTS.md
├── IDENTITY.md
├── MEMORY.md
├── SOUL.md
├── USER.md
└── memory/
    ├── 2026-03-18.md
    └── 2026-03-19.md
```

## Persistence Behavior

Understanding when these files persist and when they are lost is critical.

### Survives: Sandbox Restart

Sandbox restarts (`openshell sandbox restart`) preserve workspace files.
The sandbox uses a **Persistent Volume Claim (PVC)** that outlives individual container restarts.

### Lost: Sandbox Destroy

Running `nemoclaw <name> destroy` **deletes the sandbox and its PVC**.
All workspace files are permanently lost unless you back them up first.

> **Warning:** Always back up your workspace files before running `nemoclaw <name> destroy`.
> See Backup and Restore (see the `nemoclaw-user-workspace` skill) for instructions.

## Editing Workspace Files

The agent reads these files at the start of every session.
You can edit them in two ways:

1. **Let the agent do it** — Ask your agent to update its persona, memory, or user context.
2. **Edit manually** — Use `openshell sandbox shell` to open a terminal inside the sandbox and edit files directly, or use `openshell sandbox upload` to push edited files from your host.

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
For full details, see the Commands reference (see the `nemoclaw-user-reference` skill).

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

## Related Skills

- `nemoclaw-user-reference` — Commands reference
