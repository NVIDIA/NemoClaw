---
name: nemoclaw-maintainer-refactor-docs
description: "Plan and execute maintainer-owned refactors of oversized NemoClaw Fern documentation sections into focused one-topic pages with concise prose, journey-based nested navigation, non-clickable group nodes, canonical troubleshooting and reference ownership, deduplicated content, variant-aware route-style links, and complete redirects. Use when a docs page or section has grown too large, when reorganizing documentation information architecture or a table of contents, when splitting pages, shortening dense paragraph blocks, moving content across sections, consolidating duplicate guidance, or migrating URLs in docs/index.yml and fern/docs.yml. Trigger keywords - refactor docs, reorganize docs, split docs, nested TOC, documentation IA, one topic per page, big paragraphs, move troubleshooting, deduplicate docs, docs too long."
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Refactor NemoClaw Documentation

Refactor a bounded documentation section without changing product meaning.
Improve findability while preserving every useful fact, one canonical owner per topic, and every supported published route.

## Prerequisites

- Work from the NemoClaw repository root.
- Read `docs/CONTRIBUTING.md` before planning or editing.
- Treat `docs/` as the user-facing source of truth.
- Read the full target pages, their navigation entries in `docs/index.yml`, their redirects in `fern/docs.yml`, and their inbound links before editing.
- Read the authoritative code, tests, issue, or PR when the refactor might alter behavior claims rather than only move existing prose.

## Choose the Deliverable

- Treat cross-section ownership, navigation hierarchy, and published URL changes as maintainer-owned decisions.
- For a request to plan, audit, or propose a structure, stop after the information architecture, ownership map, and URL migration plan.
- For a request to refactor, implement the plan, validate it, and report the completed migration.
- Keep the work bounded to the named docs section. Report adjacent debt instead of folding unrelated cleanup into the refactor.
- Allow a cross-section move when canonical ownership requires it, but identify the move explicitly in the plan and migration report.
- Surface a choice only when it changes topic ownership, public URLs, supported variants, or user workflow. Use established repository conventions for routine details.

## Step 1: Inventory Before Editing

Read the complete section rather than sampling the longest page.

1. List every page and nested group for every OpenClaw, Hermes, and Deep Agents navigation variant.
2. List every H2 and H3 in the source pages, then map meaningful prose blocks, tables, callouts, and provider-specific procedures that do not have their own heading.
3. Find inbound links, old route and anchor references, redirects, release-note links, README links, tests, generated-page mappings, source comments, and repository instructions that name the current docs owners.
4. Record which variants render each page or block.
5. Identify repeated procedures, troubleshooting guidance, reference facts, and related-topic lists.

Use `rg` for repository-wide discovery. Useful starting points include:

```bash
rg -n '^(##|###) ' docs/<section>
rg -n '<section-slug>|<page-slug>|<page-title>' docs fern README.md test scripts
```

Create an ownership inventory before proposing the new TOC:

| Current page or section | User task | Variants | Canonical owner | Action |
|---|---|---|---|---|
| Existing topic | What the reader is trying to do | Applicable guides | Destination page | Keep, split, move, merge, or delete |

Every old H2 and H3 must appear in this inventory.

## Step 2: Design Around the User Journey

Default to this sequence when it fits the subject.
Omit a phase when it has no substantial reader task; never invent a thin page only to complete the sequence.

1. **Choose**: Help readers select an option, provider, model, deployment, or approach.
2. **Set up**: Give each provider, platform, integration, or setup path its own focused page when the procedures differ.
3. **Operate**: Cover inspection, switching, configuration, lifecycle, and routine management.
4. **Validate**: Prove configuration and runtime behavior without mixing in broad troubleshooting.
5. **Troubleshoot and reference**: Keep reusable failure remediation and lookup material under the canonical Reference section.

Add an **About** or **Understand** page only when it explains a distinct mental model that readers need before choosing or operating.
Do not create an overview page merely to give a section a clickable first item.

Apply these navigation rules:

- Make section headings and foldable TOC nodes non-clickable grouping nodes. They must contain only `section`, `slug`, and `contents`, plus supported display settings such as `collapsed`.
- Put all reader-facing content on child pages.
- Default to `root section -> task group -> page`. Avoid deeper nesting unless the material demonstrates a real third-level distinction.
- Keep one primary topic or user task per page. Supporting prerequisites and immediate success verification may remain on the same page; split distinct user goals, provider flows, reusable concepts, and reusable reference material.
- Prefer verb-led page titles such as **Choose**, **Set Up**, **Configure**, **View**, **Switch**, **Verify**, and **Troubleshoot**.
- Use concise noun phrases for group labels.
- Keep provider-specific or platform-specific procedures on their own pages instead of adding more sections to a generic page.
- Reuse group slugs and ordering across variants where practical, omit unsupported pages, and never publish an empty group.

## Step 3: Establish Canonical Ownership

Assign each fact, procedure, and failure mode to one page before moving content.

- Keep setup steps on the focused setup page.
- Keep routine operations on manage or operate pages.
- Keep validation behavior on validation pages.
- Move reusable failure symptoms, diagnosis, and remediation to the canonical Reference troubleshooting area.
- Use `docs/reference/troubleshooting.mdx` when it remains a focused owner. If the canonical page is itself oversized, create a non-clickable **Troubleshooting** group with focused child pages instead of growing another monolith.
- Keep structured lookup material in Reference.
- Link to canonical content instead of restating it on several pages.

Before moving troubleshooting or reference content, search the destination for the same symptom, heading, commands, and distinctive phrases.
Merge with existing guidance when it is already documented.
Do not leave a shorter duplicate behind.

Preserve every unique fact from the old pages.
When two pages disagree, verify the behavior from authoritative sources instead of choosing whichever wording is newer.

## Step 4: Define the URL Migration Contract

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

Follow the documentation style guide and these refactor-specific rules:

- Start each page with a concise statement of its purpose.
- Keep one sentence per source line.
- Keep consecutive items in a simple Markdown list compact, with no blank lines between items.
- Add **Related Topics** or **Next Steps** only when the links help readers continue the journey.
- Use `$$nemoclaw` for shared host CLI examples.
- Use `<AgentOnly>` only when behavior or guidance differs by agent, not only to change a binary name.
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
- Keep one sentence per source line and keep simple lists compact.
- Review prose inside callouts, but exclude frontmatter, code fences, tables, headings, JSX tags, and individual list items from mechanical paragraph-size counts.

Regenerate the agent variants after this edit.
Inspect the generated OpenClaw, Hermes, and Deep Agents pages for dense blocks that do not exist in the source.
When removing an `<AgentOnly>` wrapper joins variant-specific and shared prose, add source paragraph boundaries around the conditional block and regenerate.
Repeat until both source and generated pages have readable paragraph blocks.

## Step 7: Validate the Refactor

Run the existing deterministic checks rather than inventing another route model:

```bash
npm run docs:sync-agent-variants
npm run docs
npx vitest run test/check-docs-published-routes.test.ts test/check-docs-links.test.ts
git diff --check
```

Add or extend focused route tests when the refactored section is not covered by the current published-route checker.
Test observable published routes and redirects rather than source-file-relative assumptions.

Complete these audits after the build:

- Search for every deleted filename, old slug, old title, and old route.
- Search for every moved anchor and update references whose semantic destination changed.
- Search source comments, package-level `AGENTS.md` files, tests, and scripts for statements that name the former docs owner.
- Confirm no page links to a foldable section root.
- Confirm all redirects terminate at published pages for the applicable variants.
- Compare the old heading inventory with the new pages and account for every unique topic.
- Search canonical troubleshooting and reference destinations for duplicate headings or repeated remediation.
- Inspect generated OpenClaw, Hermes, and Deep Agents pages when variant blocks or shared lists changed.
- Check that simple lists have no blank lines between consecutive items.
- Visually inspect the Fern preview when navigation depth, titles, or conditional content changed.

Treat automated link feedback as a hypothesis.
Fern links resolve from published slug routes, so a valid link may not match a source-file-relative path.
Verify link comments against `docs/index.yml`, `fern/docs.yml`, generated variant mappings, and the deterministic route checks before editing.
Missing anchors can still be real even when the page route exists.

## Step 8: Run an Independent Docs Review

When subagents are available, give a documentation reviewer the changed files, the old-to-new ownership map, and test evidence.
Ask it to check for content loss, duplicate ownership, variant drift, bad redirects, oversized paragraph blocks, generated paragraph joins, and style regressions without telling it the expected verdict.
Apply valid findings and rerun affected checks.

## Completion Contract

Do not call the refactor complete until all of these conditions hold:

- Every visible TOC item that readers can select is a real topic page.
- Every foldable grouping node is non-clickable and has no page content.
- Each page owns one primary topic or task.
- Every old section is mapped to a destination or intentionally removed with a stated reason.
- Troubleshooting and reference guidance has one canonical owner.
- No supported variant renders a link or redirect to an unpublished page.
- Legacy URLs redirect directly to final published pages.
- Shared content renders correctly for every applicable agent variant.
- Source and generated variant pages have no unresolved oversized or multi-purpose prose blocks.
- Simple lists remain compact.
- The docs build, route checks, link checks, and diff check pass.

## Report the Result

Summarize the refactor with:

- The final journey-based TOC.
- Pages created, moved, consolidated, and deleted.
- Canonical troubleshooting and reference ownership decisions.
- Redirects and legacy routes preserved.
- Variant-specific differences.
- Readability edits made to dense paragraph blocks.
- Validation commands and results.
- Any intentionally deferred adjacent cleanup.

Use the Inference section as the living example of this method when a concrete pattern is needed.
Its structure separates **About Inference Routing**, choosing a provider and model, hosted/local/custom setup paths, management, validation, and canonical Reference troubleshooting.
Copy the reasoning and consistency rules, not the inference-specific page names.
