---
name: nemoclaw-contributor-engineering-guidelines
description: Apply NemoClaw engineering behavior principles to implementation work by making material assumptions reviewable, choosing the smallest sufficient design, keeping changes issue-scoped, defining verifiable outcomes, and analyzing QA-escaped defects. Use when planning or implementing a feature or fix, resolving outcome-changing ambiguity, reviewing change scope, defining success criteria, or finding root cause and prevention evidence for a QA-discovered defect. Trigger keywords - engineering guidelines, implementation assumptions, smallest change, issue scope, success criteria, escaped defect, QA defect, root cause, regression evidence.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Apply Engineering Guidelines

Use the root `AGENTS.md` principles for every coding task. Use this skill to apply them to a specific change. Read `CONTRIBUTING.md` and the closest package-specific `AGENTS.md` before editing. Use their current test and verification workflows instead of duplicating commands here.

## Frame the Work

1. Extract the explicit acceptance criteria and translate the request into observable success criteria.
2. State assumptions only when they materially affect behavior, security, compatibility, or public contracts. Distinguish confirmed facts, inferences, and unresolved ambiguity.
3. Inspect the closest implementation, tests, and local patterns. Prefer the existing architecture unless the requirement demonstrates that it is insufficient.
4. Define the intended change boundary and identify behavior that remains out of scope.
5. When an ambiguity has meaningfully different outcomes, present the interpretations and tradeoffs and ask before implementation. Do not stop for routine implementation details that repository patterns already settle.
6. For a defect, reproduce the failure before fixing it when feasible. If reproduction is not feasible, state why and preserve the strongest available pre-fix evidence.

## Implement the Narrowest Sufficient Change

- Implement only the observable success criteria. Avoid speculative features, configuration, extension points, and abstractions.
- Prefer a direct solution for one demonstrated case over a framework for possible future cases.
- Make every changed line support the problem or its required verification.
- Remove code made obsolete by the current change, but keep drive-by refactoring, formatting, comment rewrites, and unrelated cleanup out of the change. Report unrelated debt separately.
- If implementation reveals a necessary scope deviation, explain it before making the additional change.
- Keep uncertainty visible. Do not silently resolve an outcome-changing question through an implementation choice.

## Prove the Outcome

- Choose the narrowest stable test or other evidence that proves each success criterion.
- Add regression evidence at the earliest stable behavior boundary that could have caught a defect. Avoid tests coupled only to private implementation details.
- Add higher-level coverage only when it protects a distinct integration boundary.
- Include relevant negative or state-safety evidence when the acceptance criteria or risk require it.
- Iterate until every success criterion is satisfied.
- Select commands from root `AGENTS.md`, `CONTRIBUTING.md`, and package-specific guidance. Follow their rules for targeted tests, reruns after behavior-affecting edits or hook fixes, and fallback verification; do not create a parallel command matrix in this skill.

## Analyze QA-Escaped Defects

Use this section when QA discovers a defect that passed the normal engineering controls. Do not require a heavyweight root-cause process for every ordinary defect; scale the analysis to the escaped failure and its risk.

1. Establish the product root cause rather than patching only the observed symptom.
2. Identify why engineering did not detect the failure earlier. Check for an unstated or misunderstood invariant, an incorrect implementation assumption, missing or ineffective coverage, testing at the wrong abstraction level, a review blind spot, a CI or environment mismatch, or insufficient diagnostic evidence.
3. Fix the product root cause and the smallest durable detection gap.
4. Add regression evidence at the earliest stable boundary that could have caught the failure.
5. Add higher-level coverage only for a distinct integration boundary.
6. Search adjacent code paths for the same failure class within a bounded scope. Fix adjacent instances only when they share the root cause and fit the current change; otherwise report them separately.
7. Record the product root cause, detection gap, prevention evidence, and bounded-search result without assigning individual blame. Use the existing issue or pull-request narrative; do not add mandatory global template fields.

## Examples

### Resolve an Ambiguous Request

Request: "Add a force option to sandbox destruction."

Do not silently decide what `force` means. One interpretation skips only the confirmation prompt while preserving safety checks. Another bypasses safety checks as well, changing security and recovery behavior. State the alternatives and their tradeoffs, note any existing command convention, and ask which outcome is intended before implementing the public contract.

### Reduce an Over-Generalized Design

Request: "Add JSON output to one status command."

Do not introduce a configurable output-adapter framework, plugin registry, or new configuration schema for one caller. Reuse an existing serializer or output pattern, add the command boundary behavior, and prove its output contract. Generalize only when the current requirement demonstrates another consumer or a shared invariant.

### Keep a Bug Fix Issue-Scoped

Bug: a nested credential value appears in sanitized diagnostic output.

Change the sanitizer path and add regression evidence for the nested value. Remove a branch only if the fix makes it obsolete. Do not rename neighboring helpers, reformat the module, or rewrite unrelated comments in the same change. Report those cleanup opportunities separately. Every changed line should trace to preventing the leak or proving the prevention.

### Turn a Request into Success Criteria

Request: "Show a useful error when a network policy preset is missing."

Before editing, define observable criteria: a missing preset produces a nonzero result, identifies the requested preset, leaves state unchanged, and does not change the valid-preset path. Prove those facts at the narrowest stable command or action boundary, asserting stable behavior rather than incidental prose where possible.

### Prevent a QA-Escaped Defect

QA finds that rebuilding a sandbox drops an opt-in network policy.

Reproduce the loss through the rebuild path. Determine that the product root cause is a rebuild-plan mapping that omits the persisted preset list. Then identify the detection gap: tests covered initial onboarding and isolated policy serialization but not reconstruction from saved state. Fix the mapping, add a regression at the rebuild-plan boundary, and add a higher-level test only if it protects a distinct orchestration handoff. Search other saved-state reconstruction paths for the same omitted-field class, and record the root cause, escape path, evidence, and bounded-search result without blame.

## Non-Goals

- Do not replace architecture, security, testing, documentation, or pull-request guidance already maintained elsewhere in the repository.
- Do not duplicate the repository's verification command lists.
- Do not require a heavyweight RCA for every defect.
- Do not add mandatory global pull-request fields or automated subjective scoring.
- Do not turn bounded adjacent-path analysis into unrelated cleanup or feature work.
- Do not ask for clarification when local patterns settle a routine, reversible implementation detail.
