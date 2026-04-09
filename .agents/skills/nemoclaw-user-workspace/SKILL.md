---
name: "nemoclaw-user-workspace"
description: "Backs up and restores OpenClaw workspace files before destructive operations. Use when backing up a sandbox, restoring workspace state, or preparing for a destructive operation. Explains what workspace files are, where they live, and how they persist across sandbox restarts. Use when asking about soul.md, identity.md, memory.md, agents.md, or sandbox file persistence."
---

# NemoClaw User Workspace

Backs up and restores OpenClaw workspace files before destructive operations. Use when backing up a sandbox, restoring workspace state, or preparing for a destructive operation.

## Context

OpenClaw stores agent identity, behavior, and memory in a set of Markdown files inside the sandbox.
These files live at `/sandbox/.openclaw/workspace/` and are read by the agent at the start of every session.

## File Reference

Each file controls a distinct aspect of the agent's behavior and memory.

| File | Purpose | Upstream Docs |
|---|---|---|
| `SOUL.md` | Core personality, tone, and behavioral rules. | [SOUL template](https://docs.openclaw.ai/reference/templates/SOUL) |
| `USER.md` | Preferences, context, and facts the agent learns about you. | [USER template](https://docs.openclaw.ai/reference/templates/USER) |
| `IDENTITY.md` | Agent name, creature type, emoji, and self-presentation. | [IDENTITY template](https://docs.openclaw.ai/reference/templates/IDENTITY) |
| `AGENTS.md` | Multi-agent coordination, memory conventions, and safety guidelines. | [AGENTS template](https://docs.openclaw.ai/reference/templates/AGENTS) |
| `MEMORY.md` | Curated long-term memory distilled from daily notes. | — |
| `memory/` | Directory of daily note files (`YYYY-MM-DD.md`) for session continuity. | — |

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

> **Note:** The workspace directory is hidden (`.openclaw`).
> The files are not at `/sandbox/SOUL.md`. Use the full path when downloading or uploading.

## Persistence Behavior

Understanding when these files persist and when they are lost is critical.

| Event | Workspace files |
|---|---|
| Sandbox restart | **Preserved:** the sandbox PVC retains its data. |
| `nemoclaw <name> destroy` | **Lost:** the sandbox and its PVC are deleted. |

> **Warning:** Always back up your workspace files before running `nemoclaw <name> destroy`.
> See Back Up and Restore (see the `nemoclaw-user-workspace` skill) for instructions.

## Editing Workspace Files

The agent reads these files at the start of every session.
You can edit them in two ways:

1. **Let the agent do it:** Ask your agent to update its persona, memory, or user context during a session.
2. **Edit manually:** Use `openshell sandbox connect` to open a terminal inside the sandbox and edit files directly, or use `openshell sandbox upload` to push edited files from your host.

## Prerequisites

- A running NemoClaw sandbox (for backup) or a freshly created sandbox (for restore).
- The OpenShell CLI on your `PATH`.
- The sandbox name (shown by `nemoclaw list`).

Workspace files define your agent's personality, memory, and user context.
They persist across sandbox restarts but are **permanently deleted** when you run `nemoclaw <name> destroy`.

This guide covers manual backup with CLI commands and an automated script.

## Step 1: When to Back Up

- Before running `nemoclaw <name> destroy`.
- Before major NemoClaw version upgrades.
- Periodically, if you have invested time customizing your agent.

## Step 2: Manual Backup

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

## Step 3: Manual Restore

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

## Step 4: Using the Backup Script

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

## Step 5: Verifying a Backup

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

## Step 6: Inspecting Files Inside the Sandbox

Connect to the sandbox to list or view workspace files directly:

```console
$ openshell sandbox connect my-assistant
$ ls -la /sandbox/.openclaw/workspace/
```

## Related Skills

- `nemoclaw-user-reference` — Commands reference
- `nemoclaw-user-monitor-sandbox` — Monitor Sandbox Activity
