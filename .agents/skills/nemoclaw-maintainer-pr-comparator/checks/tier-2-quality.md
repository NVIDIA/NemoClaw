<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tier 2 — Code Quality Checks

Use four model judgments.
Score each check as pass = 1, yellow = 0.5, or fail = 0. Use a weight of 1.0 for each check.

## Contents

- 2.1 Description-vs-diff drift
- 2.2 Migration completion
- 2.3 Public surface preservation
- 2.4 Workaround-vs-root-cause

## 2.1 Description-vs-diff drift

The PR description must cover each changed file.
It can name the file or imply it through the described change. Mark an unrelated file yellow.

**How to evaluate:** Read the files and body with `gh pr view <pr> --json files,body`.
Mark a file yellow if the PR body does not name or imply it.

The description can imply a file.
For example, an onboarding-parser extraction implies changes to `onboard.ts` and `onboard-parser.ts`.
It does not imply a change to `unrelated-helper.ts`.

## 2.2 Migration completion

If the PR adds a replacement path, it must do one of these actions:

- Delete the old path in this PR.
- Link to a follow-up PR or issue in the body.

If the old path remains without a follow-up link, mark the check yellow.

**How to evaluate:** Find additions that name a replacement version of a symbol.
Search the resulting code for uses of the old symbol.
Mark the check yellow when callers remain and the PR has no follow-up link.

Two paths without a migration plan can diverge and leave callers on obsolete behavior.

## 2.3 Public surface preservation

For a content change to a public surface below, require a Notes section and update the related documentation:

- Flag definitions (`--name`, `Flags.<x>(`, oclif flag schemas)
- Help/usage strings (`Usage:`, `description:`, `summary:`)
- Error messages (`throw new Error(`, `console.error`)
- Exit codes (`process.exit(`)

A move with unchanged text does not require these updates.

**Yellow if:** Content changes are present but no Notes section.
**Fail if:** Content changes change user-facing behavior AND no Notes AND no docs update.

A Notes section records a user-facing change that can otherwise be missed during review.

## 2.4 Workaround-vs-root-cause

Grep the diff for symptom-suppression patterns:

- `try { ... } catch { /* empty or swallow */ }` blocks
- `catch (err) { return; }` with no rethrow or logging
- `if (err.code === '<errno>') return` (errno-specific silent ignores like EACCES, ENOENT, EEXIST)
- Defensive returns in error paths that hide failures from callers

If the diff adds a suppression pattern, require one item in the PR body:

- A link to an issue for the cause.
- An explanation of why suppression is the intended behavior.

Otherwise, mark the check yellow.

Suppression can hide another production failure. The explanation or follow-up records this risk.

**Score:** Tier 2 has four checks and contributes up to 4.0 points.
Tier 1 contributes up to 12.0 points. The maximum weighted score is 16.0.
