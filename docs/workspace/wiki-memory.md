---
title:
  page: "Wiki Memory"
  nav: "Wiki Memory"
description: "How to set up and use the LLM Wiki pattern for persistent, compounding agent memory."
keywords: ["nemoclaw wiki", "agent memory", "knowledge base", "llm wiki", "persistent memory"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "workspace", "memory", "wiki", "nemoclaw"]
content:
  type: how_to
  difficulty: technical_intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Wiki Memory

The default NemoClaw memory system (`MEMORY.md` + daily notes) re-derives
knowledge from scratch on every question. The wiki memory pattern replaces
that with a **persistent, compounding knowledge base** — a structured
directory of interlinked markdown pages that the agent maintains over time.

The agent incrementally builds and maintains the wiki. When a new source is
ingested, the agent reads it, writes a summary, updates entity and concept
pages, maintains cross-references, and keeps everything consistent. The
knowledge is compiled once and then kept current, not re-derived on every
query.

## Architecture

Three layers, mapped to the sandbox filesystem:

| Layer | Path | Purpose |
|---|---|---|
| **Schema** | `/sandbox/.openclaw/workspace/WIKI.md` | Convention file injected at session start |
| **Wiki pages** | `/sandbox/.openclaw-data/wiki/` | Agent-written, user-readable knowledge base |
| **Raw sources** | `/sandbox/.openclaw-data/wiki-raw/` | Immutable source documents |

The wiki lives under `.openclaw-data/` — **not** in `workspace/` — because
workspace files are injected into the system prompt at session start (max
150K chars total). The wiki will grow far beyond that limit. Only the compact
schema file (`WIKI.md`) and executive summary (`MEMORY.md`) are bootstrapped.
The agent reads wiki pages on-demand using the `read` tool.

### Directory Structure

```text
/sandbox/.openclaw-data/wiki/
├── index.md          # Content catalog — every page with link and summary
├── log.md            # Chronological append-only activity log
├── overview.md       # High-level living synthesis
├── entities/         # People, agents, systems, projects
├── concepts/         # Themes, patterns, techniques
├── sources/          # One summary per ingested source
└── analyses/         # Filed query results and investigations

/sandbox/.openclaw-data/wiki-raw/
├── conversations/    # Saved transcripts and turn reports
├── documents/        # Uploaded articles, papers, notes
├── web/              # Fetched web content
├── observations/     # Sub-agent outputs and cross-agent learnings
└── artifacts/        # Code, configs, system state snapshots
```

### Relationship to Existing Memory

| File | Role after wiki setup |
|---|---|
| `MEMORY.md` | Compact executive summary (~3–5K chars) distilled from the wiki |
| `memory/` | Daily session notes — continue as raw material for wiki ingestion |
| `WIKI.md` | Schema file defining conventions, workflows, directory reference |
| `SOUL.md` | Add wiki-maintenance behaviors to the agent personality |
| `AGENTS.md` | Add wiki ownership rules (single-agent ownership) |

`MEMORY.md` is **not replaced** — it stays as the bootstrapped summary that
the agent reads at session start. The wiki is the deep knowledge layer that
the agent navigates on-demand.

## Setup

### 1. Initialise the wiki

The `wiki-init.sh` script creates the directory tree and deploys seed files.
Run it inside the sandbox:

```bash
# Connect to your sandbox
nemoclaw my-assistant connect

# Run the init script (adjust path if needed)
bash /path/to/scripts/wiki-init.sh
```

Or deploy from the host:

```bash
openshell sandbox upload my-assistant scripts/wiki-init.sh /tmp/
openshell sandbox exec my-assistant bash /tmp/wiki-init.sh
```

The script is idempotent — re-running it will not overwrite existing files.

### 2. Deploy the schema file

The init script copies `WIKI.md` into the workspace automatically. You can
also deploy it manually:

```bash
openshell sandbox upload my-assistant run/_/wiki/WIKI.md \
  /sandbox/.openclaw/workspace/WIKI.md
```

### 3. Update workspace files

Add wiki-maintenance behaviors to your agent's `SOUL.md`:

- Consult the wiki index before answering complex questions.
- File substantive insights back into the wiki.
- Maintain cross-references when creating or updating pages.
- Lint the wiki when prompted or when gaps are noticed.

Add wiki ownership rules to `AGENTS.md`:

- The main agent owns the wiki exclusively. Sub-agents do not access it.
- Wiki paths: `/sandbox/.openclaw-data/wiki/` and `/sandbox/.openclaw-data/wiki-raw/`.

Evolve `MEMORY.md` into a curated executive summary with one-line insights
and references to wiki page paths.

## Operations

### Ingest

Drop a source into `wiki-raw/` and ask the agent to process it:

> "Ingest the document I just uploaded to wiki-raw/documents/research-paper.md"

The agent will:

1. Read the raw source.
2. Write a source summary to `wiki/sources/`.
3. Create or update entity and concept pages.
4. Update cross-references across all touched pages.
5. Update `wiki/index.md` and append to `wiki/log.md`.
6. Optionally update `wiki/overview.md` and `MEMORY.md`.

### Query

Ask questions against the wiki:

> "What do we know about the sandbox security model?"

The agent reads `wiki/index.md` first, then navigates to relevant pages.
If the answer is substantive, it files the result as an analysis page.

### Lint

Ask the agent to health-check the wiki:

> "Lint the wiki"

The agent scans for contradictions, orphan pages, missing cross-references,
stale claims, and knowledge gaps. Results are appended to `wiki/log.md`.

## Page Format

Every wiki page uses YAML frontmatter:

```yaml
---
title: Page Title
category: entity | concept | source | analysis
created: 2026-04-10
updated: 2026-04-10
sources: [source-slug-1, source-slug-2]
tags: [tag1, tag2]
---
```

Slugs are lowercase and hyphenated: `my-topic-name.md`. Pages use relative
links: `[Display Text](../category/slug.md)`.

## Search

At moderate scale (~100 sources, ~hundreds of pages), `index.md` plus
`grep` is sufficient:

```bash
# Full-text search
grep -rl "search term" /sandbox/.openclaw-data/wiki/

# List all pages
find /sandbox/.openclaw-data/wiki/ -name "*.md"

# Recent log entries
grep "^## \[" /sandbox/.openclaw-data/wiki/log.md | tail -5
```

If the wiki outgrows this approach (~200+ pages), consider adding a
dedicated search tool.

## Backup

The backup script includes wiki directories automatically:

```bash
scripts/backup-workspace.sh backup my-assistant   # Backs up wiki + wiki-raw
scripts/backup-workspace.sh restore my-assistant   # Restores everything
```

Both `wiki/` and `wiki-raw/` are backed up alongside workspace files.

## Next Steps

- [Workspace Files](workspace-files.md) — reference for all workspace files
- [Back Up and Restore](backup-restore.md) — backup procedures
- [Create Sub-Agents](create-sub-agents.md) — multi-agent setup
