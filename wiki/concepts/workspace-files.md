---
title: Workspace Files
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [docs-workspace]
tags: [workspace, memory, agent, personality]
---

# Workspace Files

[OpenClaw](../entities/openclaw.md) reads workspace files at session start to
establish agent personality, memory, and behavior.

## File Structure

```text
/sandbox/.openclaw/workspace/
├── SOUL.md        — Core personality, tone, behavioral rules
├── USER.md        — User preferences, context, learned facts
├── IDENTITY.md    — Agent name, creature, emoji, self-presentation
├── AGENTS.md      — Multi-agent coordination, safety guidelines
├── MEMORY.md      — Curated long-term memory distilled from notes
├── WIKI.md        — Schema for wiki memory knowledge base
└── memory/        — Daily notes (YYYY-MM-DD.md for session continuity)
```

## Persistence

| Event | Workspace Files |
|---|---|
| Sandbox restart | **Preserved** (PVC data retained) |
| `nemoclaw <name> destroy` | **Lost permanently** (must back up first) |

## Editing

**Method 1:** Ask the agent during a session (it reads files at session start).

**Method 2:** Edit manually:

```bash
nemoclaw <name> connect
# edit files directly
```

**Method 3:** Upload from host:

```bash
openshell sandbox upload <name> <file> /sandbox/.openclaw/workspace/
```

## Relationship to Wiki Memory

| File | Role |
|---|---|
| `MEMORY.md` | Compact executive summary (~3–5K chars) distilled from wiki |
| `memory/` | Daily session notes — raw material for wiki ingestion |
| `WIKI.md` | Schema defining conventions and workflows for [wiki memory](wiki-memory.md) |

## See Also

- [Backup and Restore](backup-and-restore.md) — Protecting workspace data
- [Wiki Memory](wiki-memory.md) — Deep knowledge layer
- [Sub-Agents](sub-agents.md) — Separate workspaces per agent
