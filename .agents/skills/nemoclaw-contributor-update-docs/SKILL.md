---
name: nemoclaw-contributor-update-docs
description: Find user-visible changes in current NemoClaw history and update their owning documentation. Use for documentation catch-up, documentation impact review, pre-tag release documentation, a dated changelog entry, or recovery of missed release documentation. Derive pages, commands, variants, and validation from the current checkout. Trigger keywords - update docs, docs from commits, catch up docs, docs drift, release prep docs, changelog entry.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Update Documentation from Changes

Update documentation from current behavior. Use Git history and PR context to find candidate
changes. Use checked-in source, tests, and accepted product scope as behavior authority.

## Establish the documentation task

Determine whether the request is:

- documentation impact for one change;
- catch-up across a supplied or inferred commit range;
- pre-tag release preparation for an exact version and planned date; or
- post-release recovery for documentation that missed the release.

For `/nemoclaw-contributor-update-docs for vX.Y.Z`, use pre-tag release preparation unless the tag
already exists. Ask before selecting a release version or date when current maintainer context does
not determine them.

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

Select the commit range from the user's request or current release policy. For release preparation,
reconcile commits since the prior release with the items assigned to the target release.

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

## Handle release preparation

Every pre-tag release-note docs PR must add or update the canonical
`docs/changelog/YYYY-MM-DD.mdx` entry for the exact target version. Derive its format and link rules
from the current documentation contributor guide and neighboring entries.

For pre-tag work:

1. Confirm the target version and planned release date.
2. Include every intended release item or record its evidence-backed exclusion.
3. Identify the target release label required by the current
   [release-train policy](../nemoclaw-maintainer-policies/references/release-train.md) and verify
   that it exists.
4. Stop before PR creation when the required release label does not exist.

Use post-release recovery rules only when the target release already exists.

## Validate and hand off

Run the current documentation checks discovered from repository guidance and package scripts.
Inspect generated variants and links affected by the change. Then run the required independent
documentation writer review and apply valid findings.

Summarize updated pages, new pages, skipped changes, product-scope exclusions, and validation
evidence. Use `nemoclaw-contributor-create-pr` for PR preparation and follow-up. When the user asks
to open a PR, pass the labels required by current repository policy through that workflow.
