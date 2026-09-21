<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contribute Documentation

Follow [WRITING.md](../WRITING.md) for prose and [the design decision](design/scope.md) for accepted scope.
Documentation lives in repository Markdown files.
The [documentation build](AUTOMATION.md) renders selected pages for Fern; edit the Markdown sources and [page manifest](../fern/pages.json), not generated MDX.

## Choose the Page

Use the [documentation index](README.md) to find the reader's task.
Read the complete owning page and check its inbound links before editing.
Keep each procedure or reference fact in one place and link to it elsewhere.

The [YAML field reference](reference/configuration.md) is generated from Rust types and constraints.
Follow [schema maintenance](configuration-schema.md) to update its sources and regenerate it.

- Build, deployment, model, recipe, agent, SDK, and SSH instructions belong in their task guides.
- Test commands belong in [testing.md](testing.md) and its fixture or live guides.
- Architecture rationale belongs in [design/](design/architecture.md).
- Retained results and qualification limits belong in [validation/](validation/README.md).
- Source notices and fixture provenance stay beside their artifacts.

The user-guide structure is scaffolded in the [documentation index](README.md).
Use **TBD** when the implementation or procedure still needs verification, and briefly name the missing checks.
Do not fill it from main's documentation alone or infer product support from parser acceptance.
Replace a TBD only when the text can link to the implementation, tests, or scoped qualification that supports its claims.

Label historical findings with their revision and scope; do not rewrite retained results to imply that later code was tested.

## Write the Procedure

Give each page one primary task, with descriptive headings and one prose sentence per source line.
Add the SPDX Apache-2.0 header to new documentation and preserve upstream notices.
For operational instructions:

1. State prerequisites and effects on resources, credentials, and external services before the commands.
2. Give commands from a named working directory.
3. Explain the expected result, how to verify it, and how to recover from a partial failure.

Example image pins and deployment IDs do not authorize access to the original deployment's resources.
Use relative file links and existing heading anchors.
When moving content, update inbound links and the index; retain old paths or anchors only when they have consumers.

## Validate and Review

Verify changed commands against their parser, script, or executable help, and check local links and anchors.
Run `python3 tools/docs/fern.py check` from the repository root to check the generated reference, local links, and Fern routes; [tool prerequisites](AUTOMATION.md#validate-locally) apply.
The documentation build parses every `yaml` and `yml` fenced example on rendered pages and checks complete deployments with the SDK parser.
Keep fragments syntactically valid; put settings for different YAML locations in separate fences.
Fragment parsing checks syntax only; maintained complete examples have separate parser, schema, and adapter-contract tests.
For structural changes, account for moved or removed content.
Run the repository checks required by [AGENTS.md](../AGENTS.md) and `git diff --check`; report checks that could not run and why.
Documentation-only changes need no new runtime tests or live resources.

Obtain an independent documentation review with the reader's task, changed content, validation results, and writing guide.
Resolve factual errors, missing prerequisites, broken links, and writing findings before handoff.
Use `docs:` commits and explain the decision and validation in their bodies.
