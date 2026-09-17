<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Step 4: Define the URL Migration Contract

Create a route table before deleting or renaming files:

| Old published route | New published route | Variants | Redirect required | Content owner |
|---|---|---|---|---|
| Legacy URL | Final page URL | Applicable guides | Yes or no | Source MDX page |

Create a separate anchor migration table when one old page will split into several destinations:

| Old route and anchor | New route and anchor | Inbound references | Action |
|---|---|---|---|
| Legacy page fragment | Final topic fragment | Docs, releases, README, tests, or source | Update inbound links and record any unavoidable fragment loss |

Apply these route rules:

- Derive published URLs from the section and page `slug` hierarchy in `docs/index.yml`, not from source-file directories.
- Use extensionless route-style links in MDX.
- Never link or redirect to a non-clickable section node.
- Add redirects for supported legacy forms, including `latest` and non-`latest`, variant routes, and pre-variant flat routes when they existed.
- Point every redirect directly to its final page. Do not create redirect chains.
- Audit wildcard precedence and ensure wildcard destinations also resolve directly to published pages.
- Preserve `.html` and `index.html` legacy forms when repository or external-facing references show that they were published or linked.
- Ensure each redirect destination is published for every variant represented by its source.
- Redirect removed landing or section-root routes to the first page that provides real value, not to an empty replacement overview.
- Update links to moved troubleshooting content to the canonical reference page and specific anchor when useful.
- Update historical release-note links to the most relevant canonical topic when their former broad page is split; do not rely on a page-level redirect to recover moved anchor meaning.

Shared source pages can appear in navigation through `_build/agent-variants/*.generated.mdx` paths.
Those generated files are ignored build output. Edit the source page and navigation mapping, not the generated file.

## Step 5: Implement in a Content-Safe Order

1. Create the destination pages and move all mapped content.
2. Consolidate duplicate content into its canonical owner.
3. Update `docs/index.yml` for every supported guide variant.
4. Update route-style links and related-topic lists.
5. Add direct redirects in `fern/docs.yml`.
6. Delete superseded source pages only after their unique content and inbound routes are accounted for.

Follow the public-facing documentation rules and these refactor-specific rules:

- Keep consecutive items in a simple Markdown list compact, with no blank lines between items.
- Keep shared lists structurally intact after variant rendering. Verify the generated variant output when an `<AgentOnly>` block appears inside or next to a list.
- Preserve working commands and behavior claims during a structural split. Avoid opportunistic prose rewrites.

## Step 6: Run a Readability Pass

After the structural refactor is complete, run a separate edit across every changed source page and canonical destination page.
Treat a prose block as a review candidate when it has four or more sentences, about 70 or more words, about 400 or more characters, or more than one distinct purpose.
Long single sentences and paragraphs joined across conditional blocks still require review even when they stay below the sentence or word thresholds.

- Split dense prose into short paragraphs when the ideas share one topic.
- Add a descriptive H2 or H3 when a block contains distinct tasks, decisions, phases, or operational concerns.
- Do not add a heading for a single thin paragraph or rewrite facts merely to shorten the text.
- Preserve commands, links, callout meaning, technical claims, route ownership, and agent applicability.
- Keep simple lists compact.
- Review prose inside callouts, but exclude frontmatter, code fences, tables, headings, JSX tags, and individual list items from mechanical paragraph-size counts.

Regenerate the agent variants after this edit.
Inspect the generated OpenClaw, Hermes, and Deep Agents pages for dense blocks that do not exist in the source.
When removing an `<AgentOnly>` wrapper joins variant-specific and shared prose, add source paragraph boundaries around the conditional block and regenerate.
Repeat until both source and generated pages have readable paragraph blocks.
