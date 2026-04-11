---
title: Backup and Restore
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [docs-workspace]
tags: [backup, restore, persistence]
---

# Backup and Restore

NemoClaw provides built-in commands to back up and restore
[workspace files](workspace-files.md), wiki data, and agent state.

## Built-in Commands

```bash
# Full backup with auto-generated timestamp label
nemoclaw my-assistant backup

# Named backup
nemoclaw my-assistant backup --label pre-upgrade

# List backups
nemoclaw my-assistant backup --list

# Restore most recent
nemoclaw my-assistant restore

# Restore specific backup
nemoclaw my-assistant restore pre-upgrade
```

## What Gets Backed Up

- Workspace files (`SOUL.md`, `USER.md`, `IDENTITY.md`, etc.)
- Daily memory notes (`memory/`)
- Wiki directories (`wiki/`, `wiki-raw/`)
- Agent-specific workspace, wiki, and wiki-raw directories

## Manual Backup (OpenShell)

```bash
openshell sandbox download <name> /sandbox/.openclaw/workspace/SOUL.md <dir>/
openshell sandbox download <name> /sandbox/.openclaw/workspace/memory/ <dir>/memory/
```

## Manual Restore

```bash
openshell sandbox upload <name> <dir>/SOUL.md /sandbox/.openclaw/workspace/
```

## Convenience Script

```bash
./scripts/backup-workspace.sh backup my-assistant
./scripts/backup-workspace.sh restore my-assistant [timestamp]
```

## See Also

- [Workspace Files](workspace-files.md) — What lives in the workspace
- [Sandbox](../entities/sandbox.md) — Container lifecycle and persistence
