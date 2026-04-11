---
title: Wiki Memory
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [docs-workspace]
tags: [wiki, memory, knowledge-base]
---

# Wiki Memory

The LLM Wiki pattern replaces re-derived memory with a persistent, compounding
knowledge base — a structured directory of interlinked markdown pages the agent
maintains over time.

## Architecture

| Layer | Path | Purpose |
|---|---|---|
| Schema | `/sandbox/.openclaw/workspace/WIKI.md` | Convention file (injected at session start) |
| Wiki pages | `/sandbox/.openclaw-data/wiki/` | Agent-written, user-readable knowledge base |
| Raw sources | `/sandbox/.openclaw-data/wiki-raw/` | Immutable source documents |

The wiki lives under `.openclaw-data/` (not `workspace/`) because workspace files
are injected into the system prompt at session start (~150K chars limit). The wiki
grows far beyond that. Only `WIKI.md` and `MEMORY.md` are bootstrapped; the agent
reads wiki pages on-demand.

## Operations

- **Ingest** — Drop source in `wiki-raw/`, agent processes and cross-references
- **Query** — Agent reads `wiki/index.md`, navigates to relevant pages, synthesizes
- **Lint** — Health check for contradictions, orphans, missing refs, stale claims

## Setup

```bash
nemoclaw my-assistant connect
bash /path/to/scripts/wiki-init.sh
```

The script is idempotent — re-running won't overwrite existing files.

## Relationship to Existing Memory

| File | Role |
|---|---|
| `MEMORY.md` | Compact executive summary distilled from the wiki |
| `memory/` | Daily session notes — raw material for wiki ingestion |
| `WIKI.md` | Schema defining conventions and workflows |
| `SOUL.md` | Add wiki-maintenance behaviors |
| `AGENTS.md` | Add wiki ownership rules |

## See Also

- [Workspace Files](workspace-files.md) — Agent personality and memory
- [Sub-Agents](sub-agents.md) — Per-agent wiki directories
- [Backup and Restore](backup-and-restore.md) — Wiki is included in backups
