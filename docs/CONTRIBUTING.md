<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Contributing to NemoClaw Documentation

Before requesting review, update the owning page.
Preserve every supported agent variant.
Run the documentation build successfully and obtain an independent documentation writer review.

Use this guide for the contributor journey. Follow the linked contracts for detailed style,
generation, routing, and publishing rules.

## Decide What to Update

Update documentation when a change affects a user task, command, option, default, configuration,
prerequisite, supported platform, security boundary, troubleshooting step, or other documented
behavior. Update the changelog when a user-visible change belongs in the next release.

Make user-facing changes in `docs/`.
NemoClaw publishes these Fern pages as HTML and Markdown.
It also publishes `llms.txt` for AI documentation discovery.
Keep `.agents/skills/nemoclaw-user-guide/SKILL.md` small.
Update it and `docs/resources/agent-skills.mdx` only when documentation routing changes.

Canonical documentation describes supported NemoClaw behavior. A documentation PR cannot create a
new supported integration, workflow, image, third-party stack, or product surface. Confirm new
surfaces through the root [product scope gate](../AGENTS.md#product-scope-gate). Route independent
solutions through [Community Solutions](resources/community-contributions).

## Find the Owning Page

Map the changed behavior to an existing page before creating a page. Read the complete page, its
navigation entries in `index.yml`, applicable generated variants, inbound links, and redirects.
Keep one canonical owner for each procedure or reference fact.

Use these contracts:

| Work | Canonical owner |
|---|---|
| Voice, terminology, claims, and general prose | [`WRITING.md`](../WRITING.md) |
| MDX frontmatter, page and procedure structure, code blocks, and product names | [`STYLE.md`](STYLE.md) |
| Changelog, starter prompt, variants, route links, and publication | [`AUTOMATION.md`](AUTOMATION.md) |
| Post-merge credential and trust boundary | [`tools/post-merge-docs/README.md`](../tools/post-merge-docs/README.md) |
| Agent-specific documentation workflow | [`docs/AGENTS.md`](AGENTS.md) |
| Repository contribution and PR requirements | [Root contributor guide](../CONTRIBUTING.md) |

Do not copy these contracts into a page. Link to the canonical owner when contributors need more
detail.

## Write the Change

Write for the user task and put the conclusion or required action first. Preserve supported variants,
public routes, and anchors. Use the [style and structure contract](STYLE.md) for page content and the
[automation contract](AUTOMATION.md) when the change affects generated pages, navigation, routes, or
the changelog.

Follow the [procedure structure](STYLE.md#procedure-structure) for operational steps.

Do not describe unsupported behavior as canonical NemoClaw functionality. Do not add speculative
pages or duplicate a procedure to improve discoverability; add navigation or a link instead.

## Validate the Change

Run the documentation build from the repository root:

```bash
npm run docs
```

This command prepares generated documentation and validates the Fern configuration, links, and MDX.
Inspect the generated output under `docs/_build/`. Fix source files rather than editing generated
files directly.

Use `npm run docs:live` only when the change needs visual inspection. Follow any additional
validation required by [the automation contract](AUTOMATION.md) for generated variants, routes, or
changelog changes.

Follow the root contributor guide's [validation procedure](../CONTRIBUTING.md#validate-the-change)
for Git hooks and PR-level validation.

Documentation-only changes do not require `npm test` or `npm run check` unless they alter generated
runtime behavior, test infrastructure, or another repository-wide contract. Run focused tests when
the change affects generated or runtime behavior. Record only checks that ran, and rerun affected
validation after later edits or hook autofixes.

## Obtain Independent Review

Before a documentation-only handoff, obtain an independent documentation writer review of the exact
commit. Give the reviewer the reader, task, changed pages, validation evidence, and applicable style
or automation contracts.

The review must check:

- task completeness and factual accuracy;
- commands, options, defaults, and expected results;
- variant, route, navigation, and redirect coverage;
- duplicate or displaced ownership;
- security, credential, and lifecycle claims;
- compliance with `WRITING.md` and `STYLE.md`.

Resolve every valid finding or explain why it does not apply. Rerun affected validation after later
edits.

## Submit the Pull Request

Use `docs:` as the Conventional Commit type. Follow the
[root contributor guide](../CONTRIBUTING.md#submit-the-pull-request) and complete the pull
request template. Record:

- the reader outcome and reason for the change;
- the pages and contracts changed;
- `npm run docs` and any focused validation results;
- the independent review result;
- affected variants, routes, navigation, or redirects, when applicable.

After publication, follow CI and review to completion. Keep the pull request description and
validation evidence current after each revision.
