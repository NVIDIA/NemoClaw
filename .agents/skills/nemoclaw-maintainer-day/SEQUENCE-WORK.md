<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sequence Work

Divide the work into changes that can merge separately.

## Step 1: Read the context

Read the issue body, comments, linked issues, and linked PRs.
Read review comments, PR status, changed files, tests, and documentation.
If the files change often, read recent `main` changes.

Do not use the title as the only source.

## Step 2: List related changes

List overlapping PRs and recent merged changes.
For each item, record prerequisites, dependencies, conflicts, and unrelated changes.

## Step 3: Define Slices

For each change, give one objective, a file list, tests, merge dependencies, and a stop condition.

Use this sequence when possible:

1. Extract stable helper or type boundary
2. Add regression tests for current behavior
3. Apply the behavior change or refactor
4. Remove duplication afterward

## Step 4: Rank

Use repo priorities: (1) backlog reduction, (2) security, (3) test coverage, (4) hotspot cooling.
An identified security concern overrides this default order.

Give more priority to a change that unblocks several PRs.
Give less priority to style-only work.

## Step 5: Output

| Order | Slice | Why now | Depends on | Tests |
|-------|-------|---------|------------|-------|
| 1 | Extract timeout parsing from onboard | Enables safe tests, reduces conflicts | None | Unit tests for invalid env values |

Also list outstanding blockers.
Identify changes that the maintainer loop can make.
Identify decisions that require a user.

## Notes

- Each change must name files, tests, and merge behavior.
- Prefer changes that can merge one at a time.
