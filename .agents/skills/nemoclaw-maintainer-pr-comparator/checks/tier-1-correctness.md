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

For a bug fix, the regression test must fail on the pre-fix behavior and pass with the fix.
For a behavior-preserving refactor, passing before and after is expected; verify that the test protects the affected contract.

**How to evaluate:** Read each changed test and its assertions.
Check whether the assertion distinguishes the reported defect or protects the behavior that the refactor must preserve.

**Common false-positive patterns to flag as yellow:**

- Test calls the function but only asserts "no exception thrown"
- Test asserts on output that's unrelated to the bug
- Test mocks the very behavior the bug was in

**Evidence to record:** Diff line of the assertion + the bug's pre-fix behavior + reasoning that the assertion would have failed pre-fix.

## 1.2 Acceptance criteria from comments

Use the accepted requirements established in Step 1 of the comparison workflow.
Map each criterion to behavior and acceptance evidence in the diff.

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

Apply the shared code-change and security considerations to changed success, failure, recovery, and bypass paths.
Coverage percentage alone does not establish that assertions protect the changed behavior.

**How to evaluate:** Map each relevant outcome to its shortest stable test, including the enforcing boundary for a security control.
Record missing evidence and its effect. Do not require a separate test for each syntax branch.

## 1.5 Refactor-vs-behavior scan

For a claimed refactor, compare observable behavior before and after the change.
Inspect return values, errors, side effects, ordering, defaults, and security controls where the diff can affect them.
Use current contracts and tests to establish preservation, including relevant negative paths.

Token counts and the PR title cannot establish semantic equivalence.
Equivalent control-flow rewrites need no penalty solely because syntax counts change.
An undisclosed behavior change needs accepted scope and regression evidence, even when token counts stay equal.
Record the affected contract and evidence before assigning yellow or fail.

## 1.6 Mock boundaries

Mock external dependencies. Do not mock the unit under test.
Fail the check when a mock replaces the behavior that the test claims to verify.

**How to evaluate:** Read each mock setup.
Fail when a mock replaces the function that the test claims to verify.

**Common red flags:**

- Mocking the function whose name appears in the test description
- Mocking a function and asserting only that the mock was called (without verifying the calling code's logic)
- Mocking deep into the unit under test's call graph rather than at the external boundary
