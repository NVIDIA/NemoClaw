---
name: nemoclaw-contributor-engineering-guidelines
description: Apply NemoClaw engineering behavior guidelines while implementing, reviewing, refactoring, or diagnosing code. Use when defining success criteria, resolving material ambiguity, controlling change scope or complexity, verifying a fix, or addressing a defect found by QA so both the product root cause and the engineering detection gap are closed. Trigger keywords - engineering guidelines, implement, code review, refactor, bug fix, QA defect, escaped defect, root cause, regression test.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Apply NemoClaw Engineering Guidelines

Use these principles for implementation, review, refactoring, and defect investigation.
Scale the detail to the risk and ambiguity of the change; do not turn routine work into ceremony.
Treat the root `AGENTS.md` and any narrower package `AGENTS.md` as project constraints.
Use this skill to reason about the change; use the repository's contributor skills and commands for setup, verification, and pull request mechanics.

## Make Assumptions Reviewable

1. Restate the requested outcome and observable success criteria.
2. List assumptions that materially affect behavior, security, compatibility, data, or a public contract.
3. Separate verified facts from inferences and cite the evidence behind consequential choices.
4. Surface meaningfully different interpretations and their tradeoffs.
5. Ask before implementation when choosing an interpretation would change the intended outcome.
6. For routine details that do not change the outcome, follow existing patterns and state the choice without blocking progress.

Do not hide uncertainty behind an implementation choice.

## Build the Smallest Sufficient Change

- Implement the stated acceptance criteria and nothing speculative.
- Prefer an existing extension point or direct solution over a new framework for one known case.
- Add configuration, abstraction, fallback behavior, or generality only when the current requirement demonstrates the need.
- Match the surrounding architecture and style even when another approach is personally preferable.
- Simplify before handoff when the implementation is larger or more indirect than the behavior requires.

## Keep Changes Issue-Scoped

- Make every changed line traceable to the requested outcome, its verification, or cleanup caused by the change.
- Avoid drive-by refactoring, formatting, comment rewrites, renames, and unrelated cleanup.
- Remove imports, variables, branches, or helpers made obsolete by the current change.
- Report unrelated debt separately instead of including it silently.
- Explain and obtain agreement before expanding the scope beyond the issue or acceptance criteria.
- Review the final diff against the trusted base, not only the files expected to change.

## Define and Verify the Outcome

1. Convert the request into observable success criteria before editing.
2. For a defect, reproduce the failure before fixing it when feasible. If reproduction is impractical, record why and identify equivalent evidence.
3. Choose the narrowest stable test or inspection that proves the behavior rather than the implementation detail.
4. Make the change, run the targeted evidence, and iterate until the criteria are satisfied.
5. Rerun evidence after later edits or automated fixes that can affect the behavior.
6. Follow the verification commands and broad-gate boundaries in the root `AGENTS.md` and `nemoclaw-contributor-create-pr`; do not invent a duplicate or broader gate.

Passing an unrelated broad suite does not replace evidence for the changed behavior.

## Root-Cause Escaped Defects

When QA discovers a defect, treat it as two connected failures:

1. **Product failure:** the behavior was incorrect.
2. **Detection gap:** engineering controls did not expose the incorrect behavior before QA.

Perform an escape analysis proportional to the defect's risk.
Do not require a heavyweight postmortem when a concise analysis closes the gap.

1. Reproduce the reported behavior at the earliest stable boundary that can express it when doing so is feasible and safe.
2. Establish the product root cause instead of patching only the observed input or symptom.
3. Identify why the defect escaped. Check for an unstated invariant, incorrect assumption, missing or ineffective coverage, testing at the wrong boundary, a review blind spot, CI or environment mismatch, or insufficient diagnostics.
4. Fix the product root cause and the smallest durable detection gap.
5. Add regression evidence at the earliest stable boundary that would have caught the failure.
6. Add higher-level coverage only when it protects a distinct integration boundary.
7. Define and perform a bounded search across adjacent paths that share the failed invariant or implementation mechanism.
8. Record the analysis without assigning individual blame, and label uncertain conclusions as inferences.

Use this compact record in the issue, pull request, or handoff when the defect escaped to QA:

```text
Product failure:
Product root cause:
Detection gap:
Prevention evidence:
Adjacent check:
```

## Apply the Principles

- **Ambiguous request:** Before adding a custom endpoint, establish how omitted, empty, and invalid values should behave when those choices affect the public contract.
- **Unnecessary generality:** Extend the existing manifest for one provider instead of creating a plugin framework without a second demonstrated use case.
- **Surgical fix:** Change the failing parser path and its regression coverage without renaming adjacent helpers or reformatting unrelated files.
- **Verifiable outcome:** Demonstrate that the regression fails before the fix and passes after it, then run only the relevant surrounding coverage.
- **QA escape:** If unit tests covered parsed values but QA exposed a serialization-boundary failure, fix the serialization root cause, add a contract test at that boundary, and inspect sibling serializers. Add an end-to-end test only if it protects a separate failure mode.

## Final Check

Before handoff, confirm:

- Material assumptions and tradeoffs are visible.
- The design is the smallest one that meets the acceptance criteria.
- Every changed line belongs to the requested outcome.
- Verification directly proves the changed behavior.
- Any QA-escaped defect includes both product root cause and detection-gap evidence.
- Unrelated findings are reported without being folded into the change.
