<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Contributing to NemoClaw Documentation

This guide covers how to write, edit, and review documentation for NemoClaw. If you change code that affects user-facing behavior, update the relevant docs in the same PR.

## When to Update Docs

Update documentation when your change:

- Adds, removes, or renames a CLI command or flag.
- Changes default behavior or configuration.
- Adds a new feature that users interact with.
- Fixes a bug that the docs describe incorrectly.
- Changes an API, protocol, or policy schema.

## Update Docs with Contributor Skills

If you use an AI coding agent (Cursor, Claude Code, Codex, etc.), the repo includes the `nemoclaw-contributor-update-docs` skill that automates doc work.
Use it before writing from scratch.

The skill scans recent commits for user-facing changes and drafts doc updates.
Run it after landing features, before a release, or to find doc gaps.
For example, ask your agent to "catch up the docs for the changes I made in this PR".
During release prep, run the skill first, regenerate user skills, then open the docs refresh PR.

The skill lives in `.agents/skills/nemoclaw-contributor-update-docs/` and follows the style guide below automatically.

## Doc-to-Skills Pipeline

User skills are generated agent-skill packages, prefixed with `nemoclaw-user-*`, that help AI agents guide end users through NemoClaw workflows.
The `docs/` directory is the source of truth for user-facing documentation.
The script `scripts/docs-to-skills.py` converts doc pages into user skills under `.agents/skills/`.
These generated skills identically cover the same tasks as the doc pages they were generated from, while reformatting the doc files to match the agent-skill specification in markdown and organizing sibling pages into progressive disclosure for reference files.

Always make doc updates in `docs/`.
Never edit generated skill files under `.agents/skills/nemoclaw-user-*/`. Your changes will be overwritten on the next run.

### Generated NemoClaw User Skills

The current generated skills and their source pages are:

| Skill | Source docs |
|---|---|
| `nemoclaw-user-overview` | `docs/about/overview.mdx`, `docs/about/ecosystem.mdx`, `docs/about/how-it-works.mdx`, `docs/about/release-notes.mdx` |
| `nemoclaw-user-agent-skills` | `docs/resources/agent-skills.mdx` |
| `nemoclaw-user-deploy-remote` | `docs/deployment/deploy-to-remote-gpu.mdx`, `docs/deployment/brev-web-ui.mdx`, `docs/deployment/install-openclaw-plugins.mdx`, `docs/deployment/sandbox-hardening.mdx` |
| `nemoclaw-user-get-started` | `docs/get-started/prerequisites.mdx`, `docs/get-started/quickstart.mdx`, `docs/get-started/quickstart-hermes.mdx`, `docs/get-started/windows-preparation.mdx` |
| `nemoclaw-user-configure-inference` | `docs/inference/inference-options.mdx`, `docs/inference/use-local-inference.mdx`, `docs/inference/switch-inference-providers.mdx`, `docs/inference/set-up-sub-agent.mdx`, `docs/inference/tool-calling-reliability.mdx` |
| `nemoclaw-user-manage-sandboxes` | `docs/manage-sandboxes/lifecycle.mdx`, `docs/manage-sandboxes/runtime-controls.mdx`, `docs/manage-sandboxes/messaging-channels.mdx`, `docs/manage-sandboxes/workspace-files.mdx`, `docs/manage-sandboxes/backup-restore.mdx` |
| `nemoclaw-user-monitor-sandbox` | `docs/monitoring/monitor-sandbox-activity.mdx` |
| `nemoclaw-user-manage-policy` | `docs/network-policy/customize-network-policy.mdx`, `docs/network-policy/integration-policy-examples.mdx`, `docs/network-policy/approve-network-requests.mdx` |
| `nemoclaw-user-reference` | `docs/reference/architecture.mdx`, `docs/reference/commands.mdx`, `docs/reference/cli-selection-guide.mdx`, `docs/reference/network-policies.mdx`, `docs/reference/troubleshooting.mdx` |
| `nemoclaw-user-configure-security` | `docs/security/best-practices.mdx`, `docs/security/credential-storage.mdx`, `docs/security/openclaw-controls.mdx` |

### Regenerating NemoClaw User Skills after Doc Changes

Most contributor pull requests that change docs should include only the source pages under `docs/`.
Do not regenerate or commit generated `nemoclaw-user-*` skill output in contributor doc PRs.
NemoClaw maintainers refresh generated user skills during release prep.

## Building Docs Locally

Verify the docs are built correctly by building them and checking the output.

The public site is built with Fern.
The repo pins the Fern CLI version in `fern/fern.config.json`.
Use the npm scripts so every docs command uses that pinned version.

To print the pinned Fern CLI version, run:

```bash
npm run docs:deps
```

To validate the Fern configuration and migrated MDX pages, run:

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

Fern `.mdx` pages are the source for generated user skills. Legacy `.md` pages may remain temporarily for parity checks, but release-prep skill generation should pass `--doc-platform fern-mdx`.

## Agent Variant Generation

Some Fern pages appear in both the OpenClaw and Hermes guide variants.
The `scripts/sync-agent-variant-docs.ts` script reads `docs/index.yml` and renders variant-specific copies for every page that appears in both guide variants before Fern validates or publishes the site.
The source pages stay in their normal `docs/` locations, and generated pages are written under `docs/_build/agent-variants/`, which is ignored by Git.
Navigation in `docs/index.yml` points Fern at generated pages for shared entries so Fern still renders normal fenced code blocks with copy buttons and syntax highlighting.
OpenClaw-only or Hermes-only pages stay as source pages in navigation.

When shared page content is the same except for the host CLI binary, write one source page and use `$$nemoclaw` as a build-time placeholder.
Do not duplicate fenced code blocks or inline command examples only to switch between `nemoclaw` and `nemohermes`.
Use literal command names on those single-variant pages rather than `$$nemoclaw`, because no generated page will rewrite the placeholder.

Run `npm run docs:sync-agent-variants` after editing shared variant source pages or navigation.
Run `npm run docs` before opening a PR to verify the generated pages, rewritten relative links, and Fern navigation.
If content differs by behavior, setup flow, state layout, or agent-specific wording, keep using `<AgentOnly>` blocks for that content.

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
Before opening a doc-only PR, run:

```bash
npx prek run --all-files
npm run docs
```

Leave `npm test` unchecked in the PR verification checklist unless you actually ran it.
Run the full tests only when the change also touches code, generated behavior, or runtime behavior.

## Writing Conventions

### Format

- Fern pages use MDX with YAML frontmatter. Use a flat `title`, `description`, optional `sidebar-title`, `description-agent`, `keywords`, and `position`.
- Do not duplicate the page title as a body H1 in MDX pages because Fern renders the title from frontmatter.
- The docs-to-skills pipeline treats Fern `description-agent` as the equivalent of legacy MyST `description.agent`.
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

### Legacy Skill Frontmatter Template

Use this nested shape only for legacy `.md` pages when running the pipeline with `--doc-platform myst-md`.

```yaml
---
title:
  page: "NemoClaw Page Title: Subtitle with Context"
  nav: "Short Nav Title"
description:
  main: "One-sentence summary for readers, SEO, and doc search snippets."
  agent: "Third-person verb summary for agent routing. Add 'Use when...' with trigger phrases."
keywords: ["primary keyword", "secondary keyword phrase"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "relevant", "tags"]
content:
  type: concept | how_to | get_started | tutorial | reference
  difficulty: technical_beginner | technical_intermediate | technical_advanced
  audience: ["developer", "engineer"]
skill:
  priority: 100
status: published
---
```

Use `skill.priority` to choose the lead procedure page when multiple how-to pages generate the same skill.
Lower numbers win.
For example, set the OpenClaw quickstart to `10` and the Hermes quickstart to `20` so `nemoclaw-user-get-started/SKILL.md` leads with the OpenClaw procedure and folds Hermes into `references/`.

### Page Structure

1. Start MDX pages with a one- or two-sentence introduction stating what the page covers.
2. Organize sections by task or concept, using H2 and H3. Start each section with an introductory sentence that orients the reader.
3. Use Fern components like `<Note>`, `<Tip>`, `<Warning>`, `<Cards>`, and `<Card>` for callouts and landing-page navigation.
4. Add a "Next Steps" or "Related Topics" section at the bottom when it helps users continue.

## Style Guide

Write like you are explaining something to a colleague. Be direct, specific, and concise.

### Voice and Tone

- Use active voice. "The CLI creates a gateway" not "A gateway is created by the CLI."
- Use second person ("you") when addressing the reader.
- Use present tense. "The command returns an error" not "The command will return an error."
- State facts. Do not hedge with "simply," "just," "easily," or "of course."

### Things to Avoid

These patterns are common in LLM-generated text and erode trust with technical readers. Remove them during review.

| Pattern | Problem | Fix |
|---|---|---|
| Unnecessary bold | "This is a **critical** step" on routine instructions. | Reserve bold for UI labels, parameter names, and genuine warnings. |
| Em dashes | "The gateway, which runs in Docker, creates sandboxes." | Do not use em dashes. Prefer commas, colons, or separate sentences. |
| Superlatives | "OpenShell provides a powerful, robust, seamless experience." | Say what it does, not how great it is. |
| Hedge words | "Simply run the command" or "You can easily configure..." | Drop the adverb. "Run the command." |
| Emoji in prose | "Let's get started!" | No emoji in documentation prose. |
| Rhetorical questions | "Want to secure your agents? Look no further!" | State the purpose directly. |

### Formatting Rules

- End every sentence with a period.
- One sentence per line in the source file (makes diffs readable).
- Use `code` formatting for CLI commands, file paths, flags, parameter names, and values.
- Use language-specific code blocks for commands that readers should copy.
  Put only the command text in copyable blocks:

  ```bash
  $$nemoclaw onboard
  ```

- Use `$$nemoclaw` as a build-time placeholder for NemoClaw host CLI command examples in shared variant pages.
  The docs build resolves it to `nemoclaw` for OpenClaw pages and `nemohermes` for Hermes pages before Fern renders code blocks.
  This preserves Fern's native fenced-code UI while keeping one source sample.
- Do not write duplicate `<AgentOnly>` fenced code blocks when the only difference is `nemoclaw` versus `nemohermes`.
  Use `<AgentOnly>` blocks only when the surrounding content differs between the OpenClaw and Hermes variants.

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
- Use MyST admonitions (`:::{tip}`, `:::{note}`, `:::{warning}`) only in legacy `.md` pages that have not migrated yet.
- Avoid nested admonitions.
- Do not number section titles. Write "Deploy a Gateway" not "Section 1: Deploy a Gateway" or "Step 3: Verify."
- Do not use colons in titles. Write "Deploy and Manage Gateways" not "Gateways: Deploy and Manage."
- Use colons only to introduce a list. Do not use colons as general-purpose punctuation between clauses.

### Word List

Use these consistently:

| Use | Do not use |
|---|---|
| gateway | Gateway (unless starting a sentence) |
| sandbox | Sandbox (unless starting a sentence) |
| CLI | cli, Cli |
| API key | api key, API Key |
| NVIDIA | Nvidia, nvidia |
| NemoClaw | nemoclaw (in prose), Nemoclaw |
| OpenClaw | openclaw (in prose), Openclaw |
| OpenShell | Open Shell, openShell, Openshell, openshell |
| mTLS | MTLS, mtls |
| YAML | yaml, Yaml |

## Submitting Doc Changes

1. Create a branch following the project convention.
2. Make your changes.
3. Build locally with `npm run docs` and verify the output.
4. Open a PR with `docs:` as the conventional commit type.

```text
docs: update quickstart for new onboard wizard
```

If your doc change accompanies a code change, include both in the same PR and use the code change's commit type:

```text
feat(cli): add policy-add command
```

## Reviewing Doc PRs

When reviewing documentation:

- Check that the style guide rules above are followed.
- Watch for LLM-generated patterns (excessive bold, em dashes, filler).
- Verify code examples are accurate and runnable.
- Confirm cross-references and links are not broken.
- Build locally to check rendering.
