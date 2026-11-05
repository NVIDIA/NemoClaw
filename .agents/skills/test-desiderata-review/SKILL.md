---
name: test-desiderata-review
description: Audit existing tests against Kent Beck's twelve Test Desiderata and recommend improvements without changing files.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test Desiderata Review

This audit is read-only: recommend changes to code, tests, and configuration instead of making them.

1. **Scope.** Find the suites from repository instructions, test configuration, and CI.
   Record what you inspected, and if you sample, how.
   A request for a full audit needs full inspection or a disclosed gap.
2. **Recover each test's promise:** the circumstances, the observable outcome, where the expected value comes from, a defect the test would catch, and a correct change it should survive.
3. **Assess** each test against [the twelve properties](references/desiderata.md) as tradeoffs, not a checklist.
   Tie each concern to a file and line, a property, its consequence, and your confidence.
4. **Verify what matters.** Run safe, bounded checks, such as timing, reordering, or repeated runs, when they would settle a claim.
   Ask before anything paid, credentialed, destructive, or expensive, and don't modify the user's checkout to test a hypothesis.
   Label evidence as source inspection, recorded execution, or new execution.
5. **Report** the scope and commands run, strengths worth keeping, prioritized findings, and what remains unverified.
   Recommend keeping, strengthening, simplifying, moving, or retiring each test you flag.
   Recommend retiring a test only after naming the promise it protects and showing that it's obsolete or covered elsewhere.
