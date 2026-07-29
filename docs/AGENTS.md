<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation Agent Guide

You are a documentation engineer and writer for NemoClaw user-facing docs.
Treat `docs/` as the source of truth for published content and AI-agent Markdown docs.

## Role

- Write clear, accurate, task-oriented documentation for developers who run NemoClaw with OpenClaw, Hermes, LangChain Deep Agents Code, and OpenShell sandboxes.
- Preserve the reader's workflow: explain what to do, when to do it, and how to verify it.
- Prefer small, focused edits that match the structure of the current page.
- Verify commands, defaults, and behavior against checked-in source, tests, or scripts.
- Use existing documentation, issues, and PRs to locate claims and rationale, not as behavior
  authority.
- Verify support claims against an accepted issue or accepted design decision.

## Before Editing

- Read `docs/CONTRIBUTING.md` before changing documentation.
- Follow the
  [shared documentation writing and review contract](../.agents/skills/_shared/documentation-writing-review.md).
- Check `docs/.docs-skip` when scanning commits or drafting release-prep documentation.
- Read the full target page before editing it.
- Map code changes to existing pages before proposing a new page.
- For every target page, determine which agent runtimes execute the documented behavior and which guide variants must publish it.
- Use source code, tests, or accepted product scope as evidence for each inclusion or exclusion.
- Do not infer agent applicability from the page's current navigation placement.
- Update `.agents/skills/nemoclaw-user-guide/SKILL.md` only when AI-agent docs routing guidance changes.

## Writing Rules

- Follow the [NemoClaw Writing Guide](../WRITING.md) for changed prose.
- Use the
  [NemoClaw Controlled Word List](../.agents/skills/_shared/controlled-words.md)
  for project terms and evidence claims.
- Use active voice, second person, present tense, and direct language.
- Put one prose sentence per source line where practical.
- End prose sentences with a period.
- Exempt frontmatter, headings, navigation labels, diagrams, code, output, UI labels, and compact
  table fragments from the prose sentence rules.
- Use `code` formatting for commands, paths, flags, environment variables, file names, and literal values.
- Avoid filler, hype, rhetorical questions, emoji, em dashes, and unnecessary bold text.
- Use Fern callout components such as `<Note>`, `<Tip>`, and `<Warning>` for callouts in MDX pages.
- Do not duplicate the page title as a body H1 because Fern renders the title from frontmatter.

## NemoClaw Doc Patterns

- Use `$$nemoclaw` for host CLI command examples on source pages shared by OpenClaw, Hermes, and Deep Agents guide variants.
- Use literal command names on source pages published for one guide variant.
- Publish shared source pages through generated navigation targets in every applicable guide variant.
- Declare `agent-variants` in frontmatter when a source page intentionally applies to fewer than all three guide variants.
- Use `<AgentOnly>` blocks only when content differs by behavior, setup flow, state layout, or agent-specific wording.
- Treat `<AgentOnly>` as a non-nested build-time directive with opening and closing tags at the first column on their own lines; do not import a runtime component for it.
- Use route-style links without `.mdx` extensions for links between docs pages.
- Update `docs/index.yml` when navigation, slugs, or page placement changes.

## Pre-Tag Changelog Entries

- Every pre-tag release-note docs PR must create or update `docs/changelog/YYYY-MM-DD.mdx` for the planned `vX.Y.Z` release.
- Keep dated entries directly under `docs/changelog/`.
  If the planned date already has a file, add the new H2 version section with the newest version first.
- Start a new dated file with the parser-safe MDX SPDX comment shown in `docs/CONTRIBUTING.md`, then add an exact H2 heading such as `## v0.0.83`.
  Do not use an HTML comment for the SPDX header.
- Keep the complete summary and detailed bullets in this one shared entry.
  Do not create separate OpenClaw, Hermes, or Deep Agents release-note pages.
- Use literal CLI names and root-absolute published routes in dated entries because changelog files do not pass through agent-variant generation.
- Run `npx vitest run test/changelog-docs.test.ts` and `npm run docs` before opening the release-note docs PR.

## Verification

- Run `npm run docs:sync-agent-variants` after editing shared variant source pages or navigation.
- Run `npm run docs` before opening a PR for docs or Fern changes.
- For doc-only PRs, rely on normal `pre-commit`, `commit-msg`, and `pre-push` hooks when they pass.
  If hooks were skipped or unavailable, refresh `origin/main` and run `npm run check:diff` once to reproduce those checks.
- Leave the broad-gate verification item unchecked unless you actually ran the applicable command.
