<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tier 1 — Correctness Checks

Six model judgments cover failures that CI can miss.
Score each check as pass = 1, yellow = 0.5, or fail = 0. Use a weight of 2.0 for each check.
Include file and line evidence for each judgment.

## Contents

- 1.1 Test exercises bug path
- 1.2 Comment-as-spec coverage
- 1.3 Negative test coverage
- 1.4 Coverage shape
- 1.5 Refactor-vs-behavior scan
- 1.6 Mock boundaries

## 1.1 Test exercises bug path

The PR's new/modified test must, when run on the pre-fix code, fail. A test that passes both before and after the fix proves nothing.

**How to evaluate:** Read each changed test and its assertions.
Check whether each assertion fails on the code before the fix. If it passes, the test does not exercise the bug.

**Common false-positive patterns to flag as yellow:**

- Test calls the function but only asserts "no exception thrown"
- Test asserts on output that's unrelated to the bug
- Test mocks the very behavior the bug was in

**Evidence to record:** Diff line of the assertion + the bug's pre-fix behavior + reasoning that the assertion would have failed pre-fix.

## 1.2 Acceptance criteria from comments

Read requirements in the issue body and comments.
Convert each requirement into an acceptance criterion. Map each criterion to a change or test in the diff.

**How to evaluate:** From the issue's parsed criteria checklist (Step 1 of the workflow), check each item against:

- Files changed in the diff
- New tests in the diff
- PR body's "Changes" section

**Yellow if:** Some criteria are addressed but one or two are missing without explanation.
**Fail if:** Half or more criteria are unaddressed.

## 1.3 Negative test coverage

The fix must have tests for invalid and boundary inputs, not only the reported valid case.

**Look for assertions on:**

- Empty / null / undefined inputs
- Boundaries (0, max, min, off-by-one)
- Type confusion (string where number expected)
- Malformed input
- Whitespace-only / non-ASCII / unicode

**Adapt for the input domain:** A Dockerfile change needs different "negative cases" than an HTTP handler. For infrastructure changes, package-presence assertions and version-pin assertions count.

**Yellow if** only happy-path is tested. **Fail if** the bug class has obvious negative cases and none are covered.

## 1.4 Coverage shape

Test each code path added by the diff.
Coverage percentage can stay unchanged when an unrelated test reaches a new branch.

**How to evaluate:** Find a test for each new `if`, `else`, `catch`, or `switch` arm.
Mark an untested branch yellow.

## 1.5 Refactor-vs-behavior scan

If the PR's title or description claims `refactor` / `rename` / `extract` / `move`, the diff must be net-zero in:

- Conditional adds (`if(`, `?`, `&&`, `||`)
- New `throw new Error(`
- Changed `process.exit(` codes
- Changed return values

**How to evaluate:** Count these tokens in added and removed lines.
A refactor must not increase the total. An increase can show a behavior change.
Mark it yellow or fail based on its effect.

A behavior change in a refactor can miss the review required for that change.

## 1.6 Mock boundaries

Mock external dependencies. Do not mock the unit under test.
Fail the check when a mock replaces the behavior that the test claims to verify.

**How to evaluate:** Read each mock setup.
Fail when a mock replaces the function that the test claims to verify.

**Common red flags:**

- Mocking the function whose name appears in the test description
- Mocking a function and asserting only that the mock was called (without verifying the calling code's logic)
- Mocking deep into the unit under test's call graph rather than at the external boundary
