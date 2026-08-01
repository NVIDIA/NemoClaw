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

## Writing Style Guide

Apply these rules to documentation, examples, headings, UI text, and release notes that you create or edit.

- Follow the [NemoClaw Writing Guide](../WRITING.md) for changed prose.
- Use the [NemoClaw Controlled Word List](../.agents/skills/_shared/controlled-words.md)
  for project terms and evidence claims.
- Write in a professional, active, conversational, and engaging voice.
- Use active voice whenever possible. Use present tense for product behavior.
  Address the reader in second person as "you."
- Keep sentences concise. Prefer sentences with fewer than 30 words.
- Keep one sentence per line in Markdown and MDX source files.
- End every sentence with a period.
- Use plain English and precise technical terms. Avoid jargon, filler,
  colloquialisms, and flowery marketing claims.
- Avoid contractions in technical documentation. Write "do not," "cannot,"
  and "it is."
- Write "NVIDIA" in all caps and use "an NVIDIA," not "a NVIDIA."
- Spell out uncommon abbreviations on first use. Spell out LLM, RAG, SLM, VLM,
  and MoE on first use.
- Use NVIDIA spellings such as data center, dataset, open source, pretrained,
  startup, webpage, website, and Wi-Fi.
- Replace Latinisms with plain English. Use "for example," "that is," "and so
  on," "through," and "compared to."
- Use "refer to" instead of "see," "can" instead of "may" for possibility,
  and "after" instead of "once" for time.
- Do not use "please" in technical instructions.
- Use numerals for specific values, parameters, measurements, and values of 10
  or more. Spell out zero through nine in general prose.
- Include a space between a number and its unit. Use a comma in numbers with
  four or more digits.
- Use title case for headings. Do not style headings with code, bold, italics,
  quotation marks, ampersands, or exclamation marks.
- Use the Oxford comma. Put periods inside quotation marks in U.S. style.
- Use hyphens only for compound modifiers before nouns. Do not hyphenate an
  adverb that ends in "ly."
- Format commands, code, filenames, paths, flags, environment variables, API identifiers, and literal values as code.
- Use bold for UI elements and the greater-than sign for UI navigation.
- Avoid rhetorical questions, emoji, em dashes, and unnecessary bold text.
- Introduce lists, tables, code examples, and images with a complete sentence.
  Use parallel construction in lists.
- Use descriptive link text. Do not use raw URLs in running text or generic
  link text such as "click here" or "read more."
- Write dates as Month DD, YYYY. Omit the year when it matches the publication
  year. Write time with a 12-hour clock and include minutes only when needed.
- Do not rewrite quoted UI labels, API field names, or audience role labels in
  tables to enforce second person.
- Provide useful alt text and preserve a logical heading hierarchy.
- Verify commands, flags, API names, defaults, and technical claims against
  source code or another checked-in source of truth.
- Do not rewrite literal code, identifiers, commands, URLs, or quoted terminal
  and API output to satisfy prose rules.
- Apply rules to improve clarity. Do not make mechanical changes that reduce
  technical accuracy or readability.
- Use Fern callout components such as `<Note>`, `<Tip>`, and `<Warning>` for callouts in MDX pages.
- Do not duplicate the page title as a body H1 because Fern renders the title from frontmatter.

## Use DORI for Complete NVIDIA Doc Tools

Follow [NVIDIA DORI Routing](../AGENTS.md#nvidia-dori-routing).
Use the following DORI workflow only when current host capabilities include the
verified NVIDIA documentation Skill Library. Complete the documentation before
the developer opens the pull or merge request.

1. Route the documentation task through DORI. Include the changed source files,
   the user-visible impact, the documentation that might need updates, and the
   required validation.
2. Follow the skill or workflow that DORI returns. Verify product behavior
   against checked-in sources before drafting.
3. When the host supports subagents, start a documentation subagent while the
   primary developer finishes the implementation. Reconcile the documentation
   changes and validation evidence before opening the pull or merge request.
4. When the host does not support subagents, complete the same documentation
   work in the primary task.

If the verified Skill Library is unavailable, inaccessible, or fails, skip DORI.
Do not attempt routing, prompt for setup, or ask for or persist a user
classification. Continue using the Writing Style Guide above.

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
  If hooks were skipped or unavailable, refresh `origin/main` and run `npm run validate:pr` once to reproduce those checks.
- Leave the broad-gate verification item unchecked unless you actually ran the applicable command.
