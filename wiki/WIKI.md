# Wiki — NemoClaw Knowledge Base Schema

This wiki is the persistent, compounding knowledge base for the NemoClaw project.
An LLM maintains it — creating pages, updating cross-references, resolving
contradictions, and keeping everything consistent. Humans read it; the LLM writes it.

## Paths

| Layer | Path | Ownership |
|---|---|---|
| Schema | `wiki/WIKI.md` | Co-evolved by human and LLM |
| Wiki pages | `wiki/` | LLM writes; humans read |
| Raw sources | `wiki-raw/` | Immutable after deposit |

## Directory Layout

```text
wiki/
├── WIKI.md           # This file — conventions and workflows
├── index.md          # Content catalog — every page with link and one-line summary
├── log.md            # Chronological append-only activity log
├── overview.md       # Living high-level synthesis of the project
├── entities/         # Systems, components, tools, services
├── concepts/         # Patterns, techniques, design principles
├── sources/          # One summary page per ingested source document
└── analyses/         # Filed query results, comparisons, investigations

wiki-raw/
├── documents/        # Source docs, articles, papers
├── web/              # Fetched web content
├── conversations/    # Saved transcripts and session notes
├── observations/     # Cross-project learnings
└── artifacts/        # Code snapshots, configs, system state
```

## Page Format

Every wiki page uses YAML frontmatter followed by a markdown body:

```markdown
---
title: Page Title
category: entity | concept | source | analysis
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [source-slug-1, source-slug-2]
tags: [tag1, tag2]
---

# Page Title

Body text with relative links: [Display Text](../category/slug.md)

## See Also
- [Related Page](../concepts/related.md)
```

## Special Files

**index.md** — Content-oriented catalog organized by category. Each entry:
`[slug](path) — One-line summary.` Read this first for any query.

**log.md** — Append-only chronological record. Entries start with
`## [YYYY-MM-DD] verb | Title` so they are parseable:
`grep "^## \[" wiki/log.md | tail -10`

**overview.md** — Evolving high-level synthesis. Updated after major ingests
or when the big picture shifts.

## Operations

### Ingest

When a new source is added to `wiki-raw/`:

1. Read the raw source.
2. Write a source summary to `wiki/sources/{slug}.md`.
3. Create or update entity pages in `wiki/entities/`.
4. Create or update concept pages in `wiki/concepts/`.
5. Update cross-references on all touched pages.
6. Update `wiki/index.md` with new or changed entries.
7. Append to `wiki/log.md`: `## [YYYY-MM-DD] ingest | Source Title`
8. If the insight is significant, update `wiki/overview.md`.

### Query

When answering a question against accumulated knowledge:

1. Read `wiki/index.md` to locate relevant pages.
2. Read the relevant wiki pages.
3. Synthesize an answer with citations to wiki page paths.
4. If the answer is substantive, file it as `wiki/analyses/{slug}.md`.
5. Update `wiki/index.md` and append to `wiki/log.md`.

### Lint

Periodic health check:

1. Scan for contradictions between pages.
2. Find orphan pages with no inbound links.
3. Identify concepts mentioned but lacking their own page.
4. Check for stale claims superseded by newer sources.
5. Look for missing cross-references.
6. Suggest new sources or questions to explore.
7. Append report to `wiki/log.md`: `## [YYYY-MM-DD] lint | Health Check`

## Conventions

- Raw sources are immutable — never modify files in `wiki-raw/` after deposit.
- Slugs are lowercase, hyphenated: `my-topic-name.md`.
- Use relative links between wiki pages (e.g., `../entities/openshell.md`).
- When creating a page, always add it to `index.md` in the same pass.
- When updating a page, bump the `updated` frontmatter field.
- Keep `overview.md` under 3,000 words as a living executive summary.
- The wiki is version-controlled alongside the codebase — commit wiki changes.
