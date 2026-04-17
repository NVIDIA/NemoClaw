---
title:
  page: "Workspace Files"
  nav: "Workspace Files"
description: "What workspace personality and configuration files are, where they live, and how they persist across sandbox restarts."
keywords: ["nemoclaw workspace files", "soul.md", "user.md", "identity.md", "agents.md", "sandbox persistence"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "workspace", "persistence"]
content:
  type: concept
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Workspace Files

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

:::{warning}
Always back up your workspace files before running `nemoclaw <name> destroy`.
See [Backup and Restore](backup-restore.md) for instructions.
:::

## Editing Workspace Files

The agent reads these files at the start of every session.
You can edit them in two ways:

1. **Let the agent do it** — Ask your agent to update its persona, memory, or user context.
2. **Edit manually** — Use `openshell sandbox shell` to open a terminal inside the sandbox and edit files directly, or use `openshell sandbox upload` to push edited files from your host.

## Next Steps

- [Backup and Restore workspace files](backup-restore.md)
- [Commands reference](../reference/commands.md)
