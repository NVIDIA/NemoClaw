---
name: nemoclaw-contributor-update-docs
description: Find user-visible changes merged to NemoClaw and update their owning documentation. Use in the post-merge documentation workflow or for direct documentation catch-up. Derive pages, commands, variants, and validation from the current checkout. Trigger keywords - update docs, docs from commits, catch up docs, docs drift.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Update Documentation from Changes

Update documentation from current behavior. Use checked-in source, tests, and accepted product
scope as behavior authority.

## Establish the range

For `Docs / Author Post-Merge Catch-Up`, inspect changes from the latest reachable semver tag through the
exact pushed `main` commit. Do not advance either boundary while authoring. For a direct
documentation task, use the commit range supplied by the user or current checkout context.

Release-entry completion belongs to `nemoclaw-maintainer-evening`, not this workflow.

## Load current authority

Follow [Discover the Current Implementation](../_shared/implementation-discovery.md).

Read the active documentation guidance, the shared
[Documentation Writing and Review](../_shared/documentation-writing-review.md) contract, and the
current documentation navigation. Read the repository documentation skip file when it exists.
Apply its current exclusions and prohibited terms.

Do not duplicate writing rules, page ownership, route conventions, agent variants, changelog
format, or validation commands in this skill. Derive them from the current documentation guidance,
source tree, package scripts, and workflows.

## Find documentation impact

For each candidate change:

1. Read the commit and PR context.
2. Decide whether supported user-visible behavior changed.
3. Verify the behavior in current source and tests.
4. Confirm accepted product scope for every support claim.
5. Find the owning page by searching current terminology, commands, configuration keys, errors,
   navigation, and recent documentation history.
6. Inspect every applicable guide variant before editing shared content.

Ignore test-only and internal refactors unless they expose a documentation defect. Apply the
current skip-file reporting policy. Record other evidence-backed exclusions in task evidence.

## Update the owning content

Read each complete source page before editing. Update the narrowest page that owns the behavior.
Create or restructure pages only when the current documentation guidance requires it. Use
`nemoclaw-maintainer-refactor-docs` for information-architecture work.

State the user outcome, prerequisites, risks, lifecycle effects, and acceptance criterion that the
current behavior supports. Do not infer a command, default, path, or support claim from historical
documentation or a commit message.

## Validate and hand off

In `Docs / Author Post-Merge Catch-Up`, change only `docs/**`, `fern/docs.yml`, and `fern/assets/**`; the workflow independently reviews the patch.
Required PR checks run `npm run docs`; do not perform GitHub writes from the authoring step.

For a direct documentation task, run the current documentation checks discovered from repository
guidance and package scripts. Inspect generated variants and links affected by the change and
follow the shared writing and review contract.

Summarize updated pages, new pages, skipped changes, product-scope exclusions, and validation
evidence. Use `nemoclaw-contributor-create-pr` when the user asks to publish a direct documentation
PR.
