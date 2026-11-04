---
name: safe-refactoring
description: Refactor without changing behavior, such as extracting, moving, renaming internals, simplifying, or replacing an implementation behind the same interface. Routes behavior changes and bug fixes to test-driven-development.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Safe Refactoring

When the user is still exploring, discuss options before editing; a direct request is agreement.

1. **Start green.** Before editing, run the smallest existing tests that exercise the code, and check that they would catch a change in its behavior.
   If important behavior is unprotected, add one characterization test that passes now.
   If automated tests aren't practical, compare outputs another way and say what remains uncertain.
2. **Change one thing at a time:** extract one responsibility, rename one internal concept, or remove one duplication.
   Keep features, fixes, dependency changes, and reformatting out of the refactor.
3. **Rerun the tests after each step**, and read the diff for accidental contract changes.
   A public rename, or a query rewrite that changes results, ordering, or side effects, changes behavior.
4. **If a test fails,** fix or revert the step.
   If the failure reveals a behavior change you want, finish or pause the refactor and switch to `test-driven-development`.
   Change a test only after explaining why it pinned implementation rather than a contract.
5. **Keep the result only if it's clearer:** less duplication or better separation, without speculative abstraction.

Report what changed structurally, which tests protected it, and any remaining gaps.
