<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Workspace Files

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

## Next Steps

- Back Up and Restore workspace files (see the `nemoclaw-user-workspace` skill)
- Commands reference (see the `nemoclaw-user-reference` skill)
