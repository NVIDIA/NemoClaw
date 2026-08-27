<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Contributing to NemoClaw Documentation

This guide owns the public-facing documentation procedure and rules for NemoClaw.
Code-changing pull requests (PRs) may defer public `docs/**`, `fern/docs.yml`, and `fern/assets/**` updates to `Docs / Post-Merge Catch-Up`.
When the independently reviewed patch changes documentation, the workflow creates or refreshes one
cumulative draft documentation PR for merged changes after the latest release tag. The PR title
names the next patch tag after that release tag. The PR body names both tags and explains the
development and release-cutoff procedures.

Each later qualifying push to `main` refreshes the cumulative patch only while automation owns the
draft PR. The workflow makes no PR when the reviewed patch has no documentation changes. It leaves a
ready-for-review PR unchanged. The publisher fast-forwards the branch and stops if a person changes
the branch or PR metadata.
The publisher never force-pushes. Maintainers can review the automation's
[credential ownership contract](../tools/post-merge-docs/README.md).

## When to Update Docs

The post-merge workflow updates documentation when a merged change:

- Adds, removes, or renames a CLI command or flag.
- Changes default behavior or configuration.
- Adds a new feature that users interact with.
- Fixes a bug that the docs describe incorrectly.
- Changes an API, protocol, or policy schema.

## Confirm Product Scope Before Writing Docs

Canonical documentation describes behavior that NemoClaw has chosen to support and maintain.
A documentation PR must not establish a new supported integration, solution workflow, custom image, third-party stack, or product surface by itself.

Technical correctness, successful builds, and working examples are necessary evidence, but they are not product approval.
Before documenting a new surface, confirm that an accepted issue or design decision defines ownership, compatibility and upgrade expectations, security review, lifecycle support, and validation.

Route independent solutions, complete use-case examples, and third-party integrations through [Community Solutions](resources/community-contributions.mdx).
If the correct destination is unclear, request maintainer direction before drafting the page.

## Markdown Docs for AI Agents

The `docs/` directory is the source of truth for user-facing documentation.
NemoClaw publishes Markdown versions of Fern pages plus `llms.txt`, so AI agents can fetch canonical documentation directly.

The hand-written `nemoclaw-user-guide` skill only routes agents to the right Markdown docs.
It must stay small and must not copy page content from `docs/`.

Always make user-facing doc updates in `docs/`.
Update `docs/resources/agent-skills.mdx` and `.agents/skills/nemoclaw-user-guide/SKILL.md` only when the AI-agent routing guidance changes.

## Building Docs Locally

Verify the docs are built correctly by building them and checking the output.

The public site is built with Fern.
The repo pins the Fern CLI version in `fern/fern.config.json`.
Use the npm scripts so every docs command uses that pinned version.

To print the pinned Fern CLI version, run:

```bash
npm run docs:deps
```

To validate the Fern configuration and MDX pages, run:

```bash
npm run docs
```

To serve the docs locally and automatically rebuild on changes, run:

```bash
npm run docs:live
```

To publish a branch-based Fern preview whenever docs files change, run:

```bash
npm run docs:preview:watch
```

The preview watcher uses the current Git branch name as the Fern preview ID and watches the `docs/` and `fern/` directories.
By default, it publishes to the `nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw` Fern docs instance.
Set `FERN_STAGING_INSTANCE` to a `<hostname>/<path>` value when you need to target a different Fern docs instance.
The watcher rejects blank or malformed overrides before it starts Fern.

Fern `.mdx` pages are the docs source.
Fern publishes Markdown routes for AI agents from the same source pages.

## Updating the Changelog

The native Fern changelog under `docs/changelog/` is the release history.
One source directory is shared across the OpenClaw, Hermes, and Deep Agents user-guide variants.
The end-of-day flow merges the planned release entry.
A docs-only merge does not start another catch-up run. The tag skill shows the latest cumulative
docs PR, its automated coverage point, later commits and PRs, review and check state, changed paths,
and open managed docs PRs. The maintainer then decides whether to proceed, request another docs PR,
or stop tagging.

For each release:

- Add the complete release entry to `docs/changelog/YYYY-MM-DD.mdx`, using the release date as the filename.
- Start the entry with an H2 version heading such as `## v0.0.83`.
- If more than one release ships on the same date, put each version in the same file with the newest version first.
- Include the summary and detailed bullets in the dated file; do not create separate variant-specific Release Notes pages.
- Use literal CLI names instead of the `$$nemoclaw` variant placeholder because native changelog files do not pass through agent-variant generation.
- Use root-absolute published routes for internal links in dated entries.
  Generic links should target the OpenClaw route under `/user-guide/openclaw/`; agent-specific links should target the corresponding Hermes or Deep Agents route.
- Use MDX comment syntax (`{/* ... */}`) for the SPDX header; HTML comments do not parse in Fern changelog entries.
- Keep every dated entry directly under `docs/changelog/`; Fern does not support subdirectories there.

Follow [Doc-Only PR Verification](#doc-only-pr-verification) after adding or changing the release entry.

## Publishing Docs

GitHub Actions publishes Fern docs from the same source files that `npm run docs` validates locally.

Docs PRs get Fern previews when they change `docs/`, `fern/`, or docs build inputs.
The preview workflow publishes to the staging Fern instance with a `pr-<number>` preview ID and posts the preview URL on the PR when `FERN_TOKEN` is available.

After a docs PR merges, pushes to `main` publish the affected docs to the staging Fern instance.
The staging publish job regenerates agent variants, validates Fern docs, publishes staging, and deletes the merged PR preview when it can map the merge commit back to a PR.

Public docs publish automatically when a `v*.*.*` release tag is pushed.
The public publish job runs in the `docs-public` environment, verifies that the tag commit is reachable from `origin/main`, regenerates agent variants, validates Fern docs, and publishes to the public Fern instance.
If the tag does not point to a commit on `main`, the job stops before installing dependencies or running Fern.

## Starter Prompt Generation

The coding-agent installation prompt lives in `docs/resources/starter-prompt.md`.
Edit that Markdown file instead of placing prompt text in a React component.
Keep conditional platform instructions in focused Markdown files under `docs/resources/prompt-assets/` and link to their raw GitHub URLs from the starter prompt.
The main prompt should tell the coding agent when to load each asset and should not repeat the asset's detailed instructions.
Use one shared immutable commit SHA for every platform-asset URL in a starter-prompt revision.
The contributor who changes any platform asset owns the corresponding pin update.
First commit the updated assets, starter-prompt behavior, and related tests without changing the existing URLs, `promptAssetRevision`, or pinned SHA-256 values.
Then use that commit's SHA in every platform-asset URL, update `promptAssetRevision` and every pinned SHA-256 value in `test/generation/starter-prompt-docs.test.ts`, and commit the repin as one atomic follow-up.
Never mix asset URLs from different revisions or point an asset URL at a commit that predates its content.
The asset test compares each local file byte-for-byte with its Git blob at `promptAssetRevision`, so the intermediate content commit intentionally fails until the atomic repin follow-up points every URL, revision, and digest at that content commit.
Updating only a local digest does not prove what the pinned revision contains.
Downstream consumers can pin the source with a raw URL such as
`https://raw.githubusercontent.com/NVIDIA/NemoClaw/<commit-sha>/docs/resources/starter-prompt.md`.
The Markdown SPDX comment is part of that raw file but does not appear when Markdown is rendered.

The `scripts/generate-starter-prompt.mts` script removes the Markdown SPDX preamble and writes `docs/_build/StarterPrompt.generated.mdx`.
The generated snippet wraps the prompt in Fern's native visible `Prompt` component, which displays the prompt body and supplies the copy button.
The generated file is ignored by Git and is recreated by the docs build.

Run the generator directly when you need to inspect the generated snippet:

```bash
npm run docs:sync-starter-prompt
```

Run the read-only comparison after generation when you need to verify that the snippet matches the Markdown source:

```bash
npm run docs:check-starter-prompt
```

The shared `npm run docs:prepare` step generates the Starter Prompt and agent variants.
The normal `npm run docs`, `npm run docs:live`, agent-variant sync, preview-watcher, and docs publish workflows run that step before Fern validates, serves, previews, or publishes the pages that include the prompt.

## Agent Variant Generation

Some Fern pages appear in the OpenClaw, Hermes, Deep Agents, and Pi guide variants.
The `scripts/sync-agent-variant-docs.mts` script reads `docs/index.yml` and renders variant-specific copies for every page that appears in multiple guide variants before Fern validates or publishes the site.
The source pages stay in their normal `docs/` locations, and generated pages are written under `docs/_build/agent-variants/`, which is ignored by Git.
Navigation in `docs/index.yml` points Fern at generated pages for shared entries so Fern still renders normal fenced code blocks with copy buttons and syntax highlighting.
OpenClaw-only, Hermes-only, Deep Agents-only, or Pi-only pages stay as source pages in navigation.

Determine page applicability from the implementation, tests, or accepted product scope before adding or moving navigation entries.
Do not use the current navigation tree as evidence that a page is agent-specific.
Publish a shared source page through generated navigation targets in every applicable variant.
The established shared scope is OpenClaw, Hermes, and Deep Agents. A page in that complete scope can omit `agent-variants`. When a page has a narrower scope or appears in the Pi guide, declare the exact subset in frontmatter, for example `agent-variants: ["openclaw", "hermes"]` or `agent-variants: ["pi"]`.
The sync command fails when a subset declaration is missing or differs from navigation membership.

When shared page content is the same except for the host CLI binary, write one source page and use `$$nemoclaw` as a build-time placeholder.
Do not duplicate fenced code blocks or inline command examples only to switch among `nemoclaw`,
`nemohermes`, and `nemo-deepagents`.
Use literal command names on those single-variant pages rather than `$$nemoclaw`, because no generated page will rewrite the placeholder.

Run `npm run docs:sync-agent-variants` after editing shared variant source pages or navigation.
Run `npm run docs` before opening a PR to verify the generated pages, rewritten relative links, and Fern navigation.
Update `docs/index.yml` when navigation, slugs, or page placement changes.
If content differs by behavior, setup flow, state layout, or agent-specific wording, keep using `<AgentOnly>` blocks for that content.
Treat `<AgentOnly>` as a build-time directive rather than a React component, and do not import it from `AgentGuide.tsx`.
Put each opening and closing tag at the first column on its own line, and do not nest the blocks.
Keep a section heading inside the `<AgentOnly>` block that holds its body, or the heading renders in every variant with nothing beneath it.
The sync command fails when a generated variant leaves a heading without content.
The generated pages must contain only statically resolved content, with no `AgentGuide` imports or runtime agent components.

Before review, render every guide variant that uses a changed shared page.
Confirm that commands, paths, state locations, and capabilities are correct in each variant.
State when a variant has no equivalent operation.

## Route-Style Links

Fern links between docs pages should use route-style paths, not filesystem paths.
Route-style paths omit the `.mdx` extension and follow the page slugs declared in `docs/index.yml`.
For example, a source page under `docs/get-started/` should link to the OpenClaw quickstart as `../quickstart`, not `quickstart.mdx`.
The published route comes from the navigation hierarchy and page `slug`, not directly from the file path.

This matters for generated agent variants because shared source pages may not appear directly in `docs/index.yml`.
The navigation can point Fern at generated pages under `docs/_build/agent-variants/`, while the source MDX remains in its normal folder.
The link checker maps those generated nav entries back to their source paths when validating route-style links.
Do not convert route-style links to `.mdx` file links just to satisfy a local filesystem check.

## Doc-Only PR Verification

Doc-only pull requests do not need the full test suite by default.
Commit and push normally so the Git hooks run, then run:

```bash
npm run docs
```

Leave the broad-gate verification item unchecked unless you actually ran the applicable command.
If normal `pre-commit`, `commit-msg`, or `pre-push` hooks were skipped or unavailable, run `npm run validate:pr` once to reproduce those checks before opening the PR.
The command uses `origin/main`, so refresh it with `git fetch origin main` first.
Run targeted tests once per relevant change set only when the change also touches code, generated behavior, or runtime behavior; rerun after later edits or hook autofixes that can affect it.
Reserve `npm test` for broad runtime or test-harness changes.
Reserve `npm run check` for repo-wide validation or coverage-baseline changes.

## Writing Conventions

### Format

- Fern pages use MDX with YAML frontmatter. Use a flat `title`, `description`, optional `sidebar-title`, `description-agent`, `keywords`, and `position`.
- Do not duplicate the page title as a body H1 in MDX pages because Fern renders the title from frontmatter.
- Use `description-agent` as a concise routing summary for AI documentation clients and search indexes.
- Include the SPDX license header in MDX frontmatter as comments:

  ```yaml
  ---
  # SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  # SPDX-License-Identifier: Apache-2.0
  title: "NemoClaw Page Title"
  description: "One-sentence summary for readers, SEO, and doc search snippets."
  description-agent: "Third-person verb summary for agent routing. Add 'Use when...' with trigger phrases."
  ---
  ```

### MDX Frontmatter Template

```yaml
---
# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
title: "NemoClaw Page Title: Subtitle with Context"
sidebar-title: "Short Nav Title"
description: "One-sentence summary for readers, SEO, and doc search snippets."
description-agent: "Third-person verb summary for agent routing. Add 'Use when...' with trigger phrases."
keywords: "primary keyword, secondary keyword phrase"
position: 1
---
```

When the page intentionally applies to fewer than OpenClaw, Hermes, and Deep Agents, or when it appears in the Pi guide, add the exact subset to frontmatter:

```yaml
agent-variants: ["openclaw", "hermes"]
```

### Page Structure

1. Start MDX pages with a one- or two-sentence introduction stating what the page covers.
2. Organize sections by task or concept, using H2 and H3. Start each section with an introductory sentence that orients the reader.
3. Use Fern components like `<Note>`, `<Tip>`, `<Warning>`, `<Cards>`, and `<Card>` for callouts and landing-page navigation.
4. Add a "Next Steps" or "Related Topics" section at the bottom when it helps users continue.

### Procedure Structure

Present an operational procedure in this order:

1. State the prerequisites and risks.
2. Show the command or action.
3. State the resulting state changes, external traffic, credential changes, and other effects.
4. Give the verification command or observation and its acceptance criterion.
5. Give recovery or rollback instructions when failure can leave state behind or create risk.

Put warnings about destructive or replacement behavior, security relaxation, data loss, credential
exposure, external traffic, and public ingress before the action that creates the risk.

## Style Guide

Write like you are explaining something to a colleague. Be direct, specific, and concise.
Follow the [NemoClaw Writing Guide](../WRITING.md) for changed prose.
The writing guide defines sentence rules, rewrite examples, and review policy.
The rules below add documentation-specific voice, formatting, and product-name conventions.

### Voice and Tone

- Use active voice. "The CLI creates a gateway" not "A gateway is created by the CLI."
- Use second person ("you") when addressing the reader.
- Use present tense. "The command returns an error" not "The command will return an error."
- State facts. Do not hedge with "simply," "just," "easily," or "of course."
- Avoid contractions. Write "do not," "cannot," and "it is."
- Spell out an uncommon abbreviation at first use.
  Spell out LLM, RAG, SLM, VLM, and MoE at first use.
- Replace Latinisms with plain English.
  Use "for example," "that is," "and so on," "through," and "compared to."
- Use "refer to" instead of "see," "can" instead of "may" for capability, and "after" instead of
  "once" for time.
- Do not use "please" in technical instructions.

### Product Names and Usage

- Write "NVIDIA" in all caps and use "an NVIDIA," not "a NVIDIA."
- Use NVIDIA spellings such as data center, dataset, open source, pretrained, startup, webpage,
  website, and Wi-Fi.
- Preserve quoted UI labels, API field names, and audience role labels instead of rewriting them to
  enforce second person.

### Things to Avoid

The following patterns are common in LLM-generated text and erode trust with technical readers.
Remove them during review.

| Pattern | Problem | Fix |
|---|---|---|
| Unnecessary bold | "This is a **critical** step" on routine instructions. | Reserve bold for UI labels, parameter names, and genuine warnings. |
| Em dashes | "The gateway, which runs in Docker, creates sandboxes." | Do not use em dashes. Prefer commas, colons, or separate sentences. |
| Superlatives | "OpenShell provides a powerful, robust, seamless experience." | Say what it does, not how great it is. |
| Hedge words | "Simply run the command" or "You can easily configure..." | Drop the adverb. "Run the command." |
| Emoji in prose | "Let's get started!" | No emoji in documentation prose. |
| Rhetorical questions | "Want to secure your agents? Look no further!" | State the purpose directly. |

### Formatting Rules

- End prose sentences with a period.
- Put one prose sentence per source line.
- Exempt frontmatter, headings, navigation labels, diagrams, code, output, UI labels, and compact
  table fragments from the prose sentence rules.
- Use `code` formatting for commands, code, filenames, paths, flags, environment variables, API
  identifiers, and literal values.
- Use numerals for specific values, parameters, measurements, and values of 10 or more.
  Spell out zero through nine in general prose.
- Include a space between a number and its unit.
  Use a comma in numbers with four or more digits.
- Use title case for headings.
  Do not style headings with code, bold, italics, quotation marks, ampersands, or exclamation marks.
- Use the Oxford comma.
  Put periods inside quotation marks in U.S. style.
- Use hyphens only for compound modifiers before nouns.
  Do not hyphenate an adverb that ends in "ly."
- Use bold for UI elements and the greater-than sign for UI navigation.
- Introduce lists, tables, code examples, and images with a complete sentence.
  Use parallel construction in lists.
- Use descriptive link text.
  Do not use raw URLs in running text or generic link text such as "click here" or "read more."
- Write dates as Month DD, YYYY.
  Omit the year when it matches the publication year.
  Write time with a 12-hour clock and include minutes only when needed.
- Provide useful alt text and preserve a logical heading hierarchy.
- Use language-specific code blocks for commands that readers should copy.
  Put only the command text in copyable blocks:

  ```bash
  npm run docs
  ```

- Apply the [agent variant generation rules](#agent-variant-generation) to code samples that differ
  between guide variants.

- Use `powershell` for Windows PowerShell commands.
  Use `bash` or `sh` for Linux, macOS, and WSL shell commands.
  Use `bash` for generic copyable shell commands when a single tag is needed.
  Do not use prompt markers such as `$` in copyable command blocks.
  Keep command and output in separate fenced code blocks.
  Introduce output blocks with `Expected output:`.
  For output blocks, use `json` when the output is valid JSON, otherwise use `text`.
  Reserve `console` for rare transcript-style examples that intentionally mix command and output, including prompts or interactive sessions, and label the section as transcript-only so readers do not treat it as copy/paste input.

- Use tables for structured comparisons. Keep tables simple (no nested formatting).
- Use Fern callout components (`<Note>`, `<Tip>`, `<Warning>`) for callouts in MDX pages, not bold text.
- Avoid nested admonitions.
- Do not number section titles. Write "Deploy a Gateway" not "Section 1: Deploy a Gateway" or "Step 3: Verify."
- Do not use colons in titles. Write "Deploy and Manage Gateways" not "Gateways: Deploy and Manage."
- Use colons to introduce a list or define a term or value.
  Do not use a colon to join independent clauses.

## Submitting Doc Changes

1. Create a branch following the project convention.
2. Make your changes.
3. Build locally with `npm run docs` and verify the output.
4. Have a separate documentation writer review the completed diff against this guide and `WRITING.md`.
5. Open a PR with `docs:` as the conventional commit type.

```text
docs: update quickstart for new onboard wizard
```

## Reviewing Doc PRs

When reviewing documentation:

- Review changed text against the [Style Guide](#style-guide) and its linked writing and
  terminology authorities.
- Confirm that the page documents an approved and maintained NemoClaw product surface.
- Do not approve a new integration or solution solely because its instructions work or its checks pass.
- Route independent third-party solutions to [Community Solutions](resources/community-contributions.mdx) when no product decision establishes core ownership.
- Check that the style guide rules above are followed.
- Watch for LLM-generated patterns (excessive bold, em dashes, filler).
- Verify code examples are accurate and runnable.
- Confirm cross-references and links are not broken.
- Build locally to check rendering.
