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
| `nemoclaw-user-deploy-remote` | `docs/deployment/deploy-to-remote-gpu.mdx`, `docs/deployment/install-openclaw-plugins.mdx`, `docs/deployment/sandbox-hardening.mdx` |
| `nemoclaw-user-get-started` | `docs/get-started/prerequisites.mdx`, `docs/get-started/quickstart.mdx`, `docs/get-started/quickstart-hermes.mdx`, `docs/get-started/windows-preparation.mdx` |
| `nemoclaw-user-configure-inference` | `docs/inference/inference-options.mdx`, `docs/inference/use-local-inference.mdx`, `docs/inference/switch-inference-providers.mdx`, `docs/inference/set-up-sub-agent.mdx` |
| `nemoclaw-user-manage-sandboxes` | `docs/manage-sandboxes/lifecycle.mdx`, `docs/manage-sandboxes/messaging-channels.mdx`, `docs/manage-sandboxes/workspace-files.mdx`, `docs/manage-sandboxes/backup-restore.mdx` |
| `nemoclaw-user-monitor-sandbox` | `docs/monitoring/monitor-sandbox-activity.mdx` |
| `nemoclaw-user-manage-policy` | `docs/network-policy/customize-network-policy.mdx`, `docs/network-policy/integration-policy-examples.mdx`, `docs/network-policy/approve-network-requests.mdx` |
| `nemoclaw-user-reference` | `docs/reference/architecture.mdx`, `docs/reference/commands.mdx`, `docs/reference/cli-selection-guide.mdx`, `docs/reference/network-policies.mdx`, `docs/reference/troubleshooting.mdx` |
| `nemoclaw-user-configure-security` | `docs/security/best-practices.mdx`, `docs/security/credential-storage.mdx`, `docs/security/openclaw-controls.mdx` |

### Regenerating NemoClaw User Skills after Doc Changes

Most contributor pull requests that change docs should include only the source pages under `docs/`.
Local hooks run the docs-to-skills conversion in dry-run mode so contributors can verify that generated user skills still build, without adding generated `.agents/skills/nemoclaw-user-*` output to every docs PR.

NemoClaw maintainers refresh the generated user skills once per release during release prep.

For daily release prep, the NemoClaw maintainers use this sequence:

1. Run the `nemoclaw-contributor-update-docs` skill for the day's release prep.
2. Run `python scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw-user --doc-platform fern-mdx`.
3. Create the PR with both docs and generated user skills.

To regenerate skills manually during release prep, run from the repo root:

```bash
python scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw-user --doc-platform fern-mdx
```

Always use this exact output path (`.agents/skills/`) and prefix (`nemoclaw-user`) so skill names and locations stay consistent.

Preview what would change before writing files:

```bash
python scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw-user --doc-platform fern-mdx --dry-run
```

Other useful flags:

| Flag | Purpose |
|------|---------|
| `--strategy <name>` | Grouping strategy: `smart` (default), `grouped`, or `individual`. |
| `--doc-platform <name>` | Source format: `fern-mdx` for migrated Fern pages or `myst-md` for legacy Markdown. |
| `--name-map CAT=NAME` | Override a generated skill name (e.g. `--name-map about=overview`). |
| `--exclude <file>` | Skip specific files (e.g. `--exclude "release-notes.mdx"`). |

### How the Script Works

The script reads YAML frontmatter from each doc page to determine its content type (`how_to`, `concept`, `reference`, `get_started`), then groups pages into skills using the `smart` strategy by default.
Within each group, the procedure page (`how_to`, `get_started`, or `tutorial`) with the lowest `skill.priority` becomes the main body of the skill.
Sibling procedure pages, concept pages, and reference pages go into a `references/` subdirectory for progressive disclosure, keeping `SKILL.md` concise while preserving access to the full docs.

Cross-references between doc pages are rewritten as skill-to-skill pointers so agents can navigate between skills.
Fern MDX components and MyST/Sphinx directives are converted to standard markdown.

For full usage details and all flags, see the docstring at the top of `scripts/docs-to-skills.py`.

## Building Docs Locally

Verify the docs are built correctly by building them and checking the output.

The public site is built with Fern.
The repo pins the Fern CLI version in `fern/fern.config.json`.
Use the npm scripts so every docs command uses that pinned version.

To print the pinned Fern CLI version, run:

```console
$ npm run docs:deps
```

To validate the Fern configuration and migrated MDX pages, run:

```console
$ npm run docs
```

To serve the docs locally and automatically rebuild on changes, run:

```console
$ npm run docs:live
```

To publish a branch-based Fern preview whenever docs files change, run:

```console
$ npm run docs:preview:watch
```

The preview watcher uses the current Git branch name as the Fern preview ID and watches the `docs/` and `fern/` directories.

Fern `.mdx` pages are the source for generated user skills. Legacy `.md` pages may remain temporarily for parity checks, but release-prep skill generation should pass `--doc-platform fern-mdx`.

## Doc-Only PR Verification

Doc-only pull requests do not need the full test suite by default.
Before opening a doc-only PR, run:

```console
$ npx prek run --all-files
$ npm run docs
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
- Use code blocks with the `console` language for CLI examples. Prefix commands with `$`:

  ```console
  $ nemoclaw onboard
  ```

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
