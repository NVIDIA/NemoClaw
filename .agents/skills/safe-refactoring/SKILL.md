---
name: safe-refactoring
description: Refactor code when the user wants behavior-preserving cleanup or raises a structural concern such as a large method, duplication, mixed responsibilities, awkward control flow, misplaced logic, or difficult naming—even when they are still exploring what to change. Use for extracting, moving, simplifying, reorganizing, renaming internals, and replacing implementations without changing behavior. Route behavior changes and bug fixes to test-driven-development; styling and declarative configuration use targeted verification instead.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Safe Refactoring

Improve the design while preserving a **green baseline**:

```text
DISCUSS → ESTABLISH GREEN → REFACTOR A SMALL STEP → VERIFY GREEN → REPEAT
```

## 1. Discuss the Refactor

Inspect the relevant code and understand the structural concern. Discuss concrete directions in the vocabulary used by the user and codebase.

Common concerns include:
- a method or class doing too much,
- duplicated logic or knowledge,
- mixed or misplaced responsibilities,
- difficult control flow,
- unclear internal names,
- an implementation that should be replaced behind the same interface.

When the user is exploring, discuss alternatives and trade-offs before editing. When the user directly requests implementation, treat that as agreement and proceed without asking for redundant confirmation.

Refactoring preserves observable behavior. A private rename is usually structural; a public API rename changes behavior. A query rewrite is structural only while results, ordering, visibility, and side effects remain stable.

**Complete when:** there is an agreed or directly requested structural direction grounded in the inspected code.

## 2. Establish the Green Baseline

Immediately before production edits, identify and run the smallest relevant existing tests.

Confirm:
- the tests pass,
- they meaningfully exercise the code being changed,
- obvious behavior relevant to the refactor is not left unprotected.

Use the existing tests as the default contract. Add one focused characterization test only when an important, relevant behavior is clearly unprotected. The characterization records current observable behavior and passes before the refactor.

When automated coverage is impractical, establish another reliable comparison such as stable input/output, schema output, query results, or visual evidence, and make the remaining uncertainty explicit.

**Complete when:** relevant protection is green and any material coverage gap is addressed or reported.

## 3. Refactor One Small Step

Make one coherent structural change, such as:
- extract one responsibility,
- move one transformation,
- rename one internal concept,
- remove one duplication,
- simplify one branch,
- replace one implementation behind the same interface.

Keep feature work, bug fixes, dependency changes, broad formatting churn, and unrelated cleanup outside the step.

Run the focused baseline after the change and inspect the diff for accidental contract changes.

**Complete when:** the structural step is green and its design benefit is clear.

Repeat for the next coherent step.

## 4. Handle Unexpected Behavior Changes

When the baseline fails, determine whether the refactor accidentally changed behavior or exposed a desired behavior change.

- Accidental change → correct or revert the structural step until green.
- Desired behavior change or bug fix → pause the refactor and switch to `test-driven-development` for valid RED.
- Implementation-coupled test → explain why it does not express a real contract before changing it, then re-establish green.

Finish or pause the green refactor before beginning a behavioral cycle.

**Complete when:** the refactor is green again or the behavior change has moved to an explicit TDD cycle.

## 5. Finish

Run broader relevant checks and account for every changed responsibility. Keep the refactor only when it makes the design materially clearer, less duplicated, or better coupled without speculative generality or unnecessary indirection.

At completion, mention:
- what changed structurally,
- which focused tests established and preserved the baseline,
- which broader checks passed,
- any remaining coverage or verification gap.

Adapt the detail to the size and risk of the refactor.

**Complete when:** all changed responsibilities are accounted for and relevant checks are green.
