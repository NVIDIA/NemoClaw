<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contribute Documentation

Write the shortest text that lets the reader act correctly.
[WRITING.md](../WRITING.md) owns prose rules and links to the controlled word list.
[DESIGN.md](../DESIGN.md) owns the accepted experimental scope.

This branch uses repository Markdown links and has no Fern site, generated agent variants, or npm documentation build.
The writing guide, controlled word list, and shared review contract came from `origin/main` at `6591eaf96b`.
This guide adapts that revision’s documentation contributor guide, style contract, and documentation update and refactor skills to the Rust branch.

## Choose the Owning Page

Use the [documentation index](README.md) to find the page for the reader’s task.
Read the complete page and check its inbound links before editing.
Keep one owner for each procedure or reference fact; link to it from other pages.

- Put build procedures in [build.md](build.md).
- Put deployment lifecycle and recovery in [usage.md](usage.md).
- Put model, recipe, agent, and SSH setup in their task guides.
- Put test commands in [testing.md](testing.md) and its fixture or live guides.
- Put architecture rationale in [design/](design/architecture.md).
- Put retained results and qualification limits in [validation/](validation/README.md).
- Keep source notices and fixture provenance beside their artifacts.

Design findings and validation records can describe intermediate implementations.
Label their revision and scope instead of presenting them as current setup instructions.
Do not rewrite retained JSON results to imply that a later revision was tested.

## Write the Page

Verify commands, fields, defaults, and failure behavior against checked-in source and tests.
An example image digest or deployment UID does not authorize reuse of the original experiment’s resources.
A successful test does not establish support beyond the accepted scope.

Use one primary task per page and descriptive headings.
Put one prose sentence per source line.
Use Markdown headings, tables, lists, and fenced code blocks; no MDX frontmatter is required.

Include the SPDX Apache-2.0 header in new documentation.
Preserve upstream license statements and historical quotations.

Present operational procedures in this order:

1. State prerequisites and risks before commands, including deletion, external traffic, and credential access.
2. Give the command from a named working directory.
3. State the expected result and resource or credential changes.
4. Explain how to verify success.
5. Give recovery instructions when failure can leave state or resources behind.

Use relative file links with `.md` extensions and existing heading anchors.
Preserve old paths and anchors with direct links when moving content.
Update the index and all current inbound links.

Do not duplicate procedures in compatibility pages.

## Validate and Review

Check every changed command against its argument parser, script, or executable help.
Check local links and anchors, including links from examples and source comments.
For a structural change, compare every old section with its destination and account for any removed content.

Run the required repository checks from the root:

```sh
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
git diff --check
```

Documentation-only changes do not add runtime behavior tests.
If a change affects executable behavior, follow the test-first requirements in [AGENTS.md](../AGENTS.md).
Live tests require explicit configuration; a documentation edit does not require creating live resources.

Obtain an independent documentation writer review of the completed change.
Give the reviewer the reader’s task, content moves, validation results, and writing guidance.
Resolve factual errors, missing prerequisites, lost content, broken links, and writing findings before handoff.

Report checks that could not run with their concrete cause.
Use `docs:` Conventional Commits and explain the problem, decision, and validation in the commit body.
