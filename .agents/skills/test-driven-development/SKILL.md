---
name: test-driven-development
description: Test-drive behavior changes and bug fixes with a failing behavioral test first. Routes refactors, configuration, generated code, and dependency updates to other checks.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test-Driven Development

Use TDD for behavior a caller or user can observe: what they can do, receive, or persist, and the errors they get.
Use other checks for:

- behavior-preserving structural changes: `safe-refactoring`;
- configuration and declarative metadata: schema, type, or lint checks;
- generated code and dependency updates: the generator, build, and integration checks;
- mechanical wiring and test-only maintenance: the existing tests that cover them.

For mixed work, refactor with the tests passing first, then start RED for the new behavior.

## Cycle

1. **List the cases** the change must handle: the basic case, boundaries, failures, retries, and existing behavior at risk.
   For stateful work, include interruption before and after each commit point.
   Keep the list in prose; don't write tests for all of it up front.
2. **Pick one case** that fails today.
   Derive its expected result from the requirement, not from running the code.
   The test should fail for a plausible regression and still pass under a different correct implementation.
3. **Test through the production path:** the entrypoint, the owning logic, and the observable result.
   Assert outputs, state, errors, and persisted effects, not internal calls.
   Substitute only what is slow, nondeterministic, external, or destructive, and don't claim that a substitute proves the real boundary.
4. **RED:** run the smallest command that exercises the test, and confirm it fails for the expected reason.
   A compile, fixture, or harness failure is not RED; fix it and rerun.
   If the test already passes, either the behavior exists, so keep the test as regression coverage and say so, or the assertion misses the point.
5. **GREEN:** make the smallest production change that passes, then rerun the test and nearby tests.
6. **REFACTOR** while green, then pick the next case.

When a requirement is dropped, remove its behavior and tests together.
Keep a test that something doesn't happen only when that absence is itself a promise, such as a refused authorization.

## Report

For a bug fix, confirm the test reproduced the bug before the fix.
Report the behavior, the failing and passing runs, other checks, and any case left unverified; a passing proxy doesn't close that gap.
