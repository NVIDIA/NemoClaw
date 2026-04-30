# Contributing to NemoClaw Documentation

This guide covers how to write, edit, and review documentation for NemoClaw. If you change code that affects user-facing behavior, update the relevant docs in the same PR.

## When to Update Docs

Update documentation when your change:

- Adds, removes, or renames a CLI command or flag.
- Changes default behavior or configuration.
- Adds a new feature that users interact with.
- Fixes a bug that the docs describe incorrectly.
- Changes an API, protocol, or policy schema.

## Update Docs with Agent Skills

If you use an AI coding agent (Cursor, Claude Code, Codex, etc.), the repo includes the `nemoclaw-contributor-update-docs` skill that automates doc work.
Use it before writing from scratch.

The skill scans recent commits for user-facing changes and drafts doc updates.
Run it after landing features, before a release, or to find doc gaps.
For example, ask your agent to "catch up the docs for the changes I made in this PR".

The skill lives in `.agents/skills/nemoclaw-contributor-update-docs/` and follows the style guide below automatically.

## Doc-to-Skills Pipeline

The `docs/` directory is the source of truth for user-facing documentation.
The script `scripts/docs-to-skills.py` converts doc pages into agent skills under `.agents/skills/`.
These generated skills let AI agents walk users through NemoClaw tasks (installation, inference configuration, policy management, monitoring, and more) without reading raw doc pages.

Always edit pages in `docs/`.
Never edit generated skill files under `.agents/skills/nemoclaw-user-*/`. Your changes will be overwritten on the next run.

### Generated skills

The current generated skills and their source pages are:

| Skill | Source docs |
|---|---|
| `nemoclaw-user-overview` | `docs/about/overview.md`, `docs/about/ecosystem.md`, `docs/about/how-it-works.md`, `docs/about/release-notes.md` |
| `nemoclaw-user-get-started` | `docs/get-started/quickstart.md` |
| `nemoclaw-user-configure-inference` | `docs/inference/inference-options.md`, `docs/inference/use-local-inference.md`, `docs/inference/switch-inference-providers.md` |
| `nemoclaw-user-manage-policy` | `docs/network-policy/customize-network-policy.md`, `docs/network-policy/approve-network-requests.md` |
| `nemoclaw-user-monitor-sandbox` | `docs/monitoring/monitor-sandbox-activity.md` |
| `nemoclaw-user-deploy-remote` | `docs/deployment/deploy-to-remote-gpu.md`, `docs/deployment/set-up-telegram-bridge.md` |
| `nemoclaw-user-reference` | `docs/reference/architecture.md`, `docs/reference/commands.md`, `docs/reference/network-policies.md`, `docs/reference/troubleshooting.md` |

### Regenerating skills after doc changes

Pull requests that change docs should normally include only the source pages under `docs/`, not the generated `.agents/skills/nemoclaw-user-*` output.
Local hooks and PR CI run `scripts/docs-to-skills.py --dry-run` to confirm the docs still convert cleanly without writing files.

After a docs change merges to `main`, the `Docs to Skills` workflow regenerates `.agents/skills/nemoclaw-user-*` from `docs/` and publishes the generated update.
The workflow pushes the generated commit directly when branch protection allows it; otherwise it opens or updates a small sync PR for maintainers to merge.

To regenerate skills manually (for example, when reviewing the sync workflow output), run from the repo root:

```bash
python scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw-user
```

Always use this exact output path (`.agents/skills/`) and prefix (`nemoclaw-user`) so skill names and locations stay consistent.

Preview what would change before writing files:

```bash
python scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw-user --dry-run
```

Other useful flags:

| Flag | Purpose |
|------|---------|
| `--strategy <name>` | Grouping strategy: `smart` (default), `grouped`, or `individual`. |
| `--name-map CAT=NAME` | Override a generated skill name (e.g. `--name-map about=overview`). |
| `--exclude <file>` | Skip specific files (e.g. `--exclude "release-notes.md"`). |

### How the Script Works

The script reads YAML frontmatter from each doc page to determine its content type (`how_to`, `concept`, `reference`, `get_started`), then groups pages into skills using the `smart` strategy by default.
Within each group, the first procedure page (`how_to`, `get_started`, or `tutorial`) becomes the main body of the skill.
Sibling procedure pages, concept pages, and reference pages go into a `references/` subdirectory for progressive disclosure, keeping `SKILL.md` concise while preserving access to the full docs.

Cross-references between doc pages are rewritten as skill-to-skill pointers so agents can navigate between skills.
MyST/Sphinx directives are converted to standard markdown.

For full usage details and all flags, see the docstring at the top of `scripts/docs-to-skills.py`.

## Building Docs Locally

Verify the docs are built correctly by building them and checking the output.

To build the docs, run:

```bash
make docs
```

To serve the docs locally and automatically rebuild on changes, run:

```bash
make docs-live
```

## Writing Conventions

### Format

- Docs use [MyST Markdown](https://myst-parser.readthedocs.io/), a Sphinx-compatible superset of CommonMark.
- Every page starts with YAML frontmatter (title, description.main, description.agent, topics, tags, content type).
- Include the SPDX license header after frontmatter:

  ```html
  <!--
    SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
    SPDX-License-Identifier: Apache-2.0
  -->
  ```

### Frontmatter Template

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
status: published
---
```

### Page Structure

1. H1 heading matching the `title.page` value.
2. A one- or two-sentence introduction stating what the page covers.
3. Sections organized by task or concept, using H2 and H3. Start each section with an introductory sentence that orients the reader.
4. A "Next Steps" section at the bottom linking to related pages.

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
- Use MyST admonitions (`:::{tip}`, `:::{note}`, `:::{warning}`) for callouts, not bold text.
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
3. Build locally with `make docs` and verify the output.
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
