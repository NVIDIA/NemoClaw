---
name: nemoclaw-maintainer-refactor-docs
description: "Reorganize NemoClaw documentation pages, navigation, or content ownership while preserving published routes. Use for structural documentation refactors."
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Refactor NemoClaw Documentation

Refactor a bounded documentation section without changing product meaning.
Improve findability while preserving every useful fact, one canonical owner per topic, and every supported published route.

## Prerequisites

- Work from the NemoClaw repository root.
- Follow the shared [Documentation Writing and Review](../_shared/documentation-writing-review.md)
  contract before planning or editing.
- Read the full target pages, their navigation entries in `docs/index.yml`, their redirects in `fern/docs.yml`, and their inbound links before editing.

## Choose the Deliverable

- Treat cross-section ownership, navigation hierarchy, and published URL changes as maintainer-owned decisions.
- For a request to plan, audit, or propose a structure, stop after the information architecture, ownership map, and URL migration plan.
- For a request to refactor, implement the plan, validate it, and report the completed migration.
- Keep the work bounded to the named docs section. Report adjacent debt instead of folding unrelated cleanup into the refactor.
- Allow a cross-section move when canonical ownership requires it, but identify the move explicitly in the plan and migration report.
- Surface a choice only when it changes topic ownership, public URLs, supported variants, or user workflow. Use established repository conventions for routine details.

## Load the phase that applies

- For an audit or structure plan, use [Structure and Ownership](references/structure.md).
- Before changing published routes or moving content, use [Migration](references/migration.md).
  A plan that changes URLs must include its route and anchor mapping.
- For an implemented refactor, use [Validation and Review](references/validation.md).
  Repair findings and rerun affected checks before reporting completion.

Do not load execution-only detail for a plan-only request. A request to perform the refactor
includes implementation and validation; it does not require a separate approval of routine layout
choices within the accepted scope.

## Completion Contract

For a plan-only request, completion means the ownership map, proposed structure, route migration
plan, and unresolved decisions are recorded. The implementation checks and validation results below
apply only when the refactor was performed.

For an implemented refactor, require all of these conditions:

- Every visible TOC item that readers can select is a real topic page.
- Every foldable grouping node is non-clickable and has no page content.
- Each page owns one primary topic or task.
- Every old section is mapped to a destination or intentionally removed with a stated reason.
- Troubleshooting and reference guidance has one canonical owner.
- No supported variant renders a link or redirect to an unpublished page.
- Legacy URLs redirect directly to final published pages.
- Shared content renders correctly for every applicable agent variant.
- Source and generated variant pages have no unresolved oversized or multi-purpose prose blocks.
- Simple lists remain compact.
- The docs build, route checks, link checks, and diff check pass.

## Report the Result

For a plan-only request, report the proposed structure, ownership, routes, and remaining decisions.
For an implemented refactor, summarize:

- The final journey-based TOC.
- Pages created, moved, consolidated, and deleted.
- Canonical troubleshooting and reference ownership decisions.
- Redirects and legacy routes preserved.
- Variant-specific differences.
- Readability edits made to dense paragraph blocks.
- Validation commands and results.
- Any intentionally deferred adjacent cleanup.

Use the Inference section as the living example of this method when a concrete pattern is needed.
Its structure separates **About Inference Routing**, choosing a provider and model, hosted/local/custom setup paths, management, validation, and canonical Reference troubleshooting.
Copy the reasoning and consistency rules, not the inference-specific page names.
