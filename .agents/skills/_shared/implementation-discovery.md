<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Discover the Current Implementation

Use the current checkout as the source of truth. A skill defines process and priorities. It must
not substitute a maintained prose inventory for source, tests, schemas, scripts, or workflows.

## Establish the boundary

1. Read the active `AGENTS.md` files for every area that the task can change.
2. Translate the request into observable outcomes and explicit exclusions.
3. Confirm product scope before adding a supported surface.
4. Identify affected trust boundaries before implementation. When one changes, load
   `nemoclaw-maintainer-security-code-review` and use its relevant categories to plan the change
   and tests.
5. Stop when an unresolved choice can change behavior, security, data safety, or support.

## Find the owning code

Start from identifiers supplied by the task or visible in current behavior. Search for command
names, configuration keys, package names, versions, schema fields, errors, and user-visible text.

Use `rg --files` to locate candidate files and `rg` to follow each identifier through:

- production definitions and registrations;
- callers, adapters, and generated inputs;
- schemas, manifests, lockfiles, and policy;
- tests and fixtures;
- build, release, and CI workflows;
- user documentation.

Follow imports and call sites until the behavior owner and enforcement point are clear. Inspect
the closest existing implementation and its tests as examples, not as templates that must be
copied.

Use Git history, issues, PRs, and documentation to find rationale. Verify current behavior against
the checked-in implementation and tests.

## Use repository-owned tooling

Find applicable commands in active `AGENTS.md` files, package scripts, workflow inputs, and nearby
tool help. Prefer a checked-in script when it provides deterministic collection or validation.
Inspect its current interface instead of copying its arguments into a skill.

When a tool contributes security or provenance evidence, run the version from the trusted base
revision. Do not treat a helper modified by the proposed change as independent evidence for that
same change.

## Keep the change current

- Make the smallest change at the current behavior owner.
- Derive tests from the changed contract and the repository's current test organization.
- Treat existing tests as evidence only for the behavior they exercise.
- Update user documentation when the supported user-visible behavior changes.
- Record discovered paths and commands in the task plan or PR evidence, not in the skill.
