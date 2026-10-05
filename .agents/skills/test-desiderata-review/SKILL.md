---
name: test-desiderata-review
description: Audit existing tests through Kent Beck's twelve Test Desiderata and recommend evidence-backed improvements.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test Desiderata Review

Produce a read-only audit of test value, not a review of whether tests were written through TDD. Preserve source, tests, configuration, snapshots, and dependencies. Offer changes as recommendations; implementation requires a separate request.

## 1. Bound and Inventory the Suite

Identify the repository, requested scope, revision, and available time or execution constraints. Inspect repository instructions, test configuration, scripts, and CI to locate the actual suites and their commands.

Inventory test files, helpers, fixtures, substitutes, and production boundaries. Record discovered file counts; count runnable cases only when runner discovery is safe, distinguishing parameterized cases from source declarations. Separate unit, integration, contract, browser/native, performance, and model-evaluation evidence by what they exercise, rather than filenames alone.

Inspect all tests when tractable. Otherwise select a disclosed sample spanning boundaries, high-risk rules, state transitions, failure paths, heavy fixtures/mocking, and apparently sound examples. Search hits select candidates; they are not findings. An explicit exhaustive request requires full inspection or an incomplete-audit disclosure, not silently substituted sampling.

**Complete when:** inventory, exclusions, inspection scope, and any sampling rule are recorded.

## 2. Recover the Promises

Read each selected test file completely, following helpers and production paths needed to understand its assertions. Consult requirements, API contracts, and relevant history when intent is unclear; distinguish documented promises from current implementation choices.

For each selected test or coherent group, identify:

- The circumstances and promised observable outcome.
- The oracle: where its expected result comes from.
- A plausible application defect it detects.
- A correct implementation change that should leave it passing.
- The production assumptions its fixtures or substitutes leave unverified.

Use outputs, persisted effects, meaningful interactions, errors, and user-visible state as behavioral evidence. Exact wording, geometry, timing, and rendered output can be contracts when explicitly required. An internal call count or prop assignment may only establish wiring; name that narrower claim honestly.

**Complete when:** every inspected group has a traceable promise and oracle, or an explicit uncertainty about its intent.

## 3. Evaluate the Desiderata

Read [the assessment guide](references/desiderata.md) in full. Apply all twelve properties at their appropriate level: test, boundary, or suite. Record supported strengths, concerns, justified tradeoffs, and unknowns; prioritize substantive findings over repeating a twelve-row checklist for every test.

Judge the feedback the test is meant to provide. A fast local test and a slower real-boundary test may complement each other. Neither mocks, integration tests, snapshots, coverage percentages, nor test counts determine quality by themselves. Assess existing value independently of test-first history.

Keep every concern attached to file-and-line evidence, the relevant property, its practical consequence, and confidence. Describe a plausible failure mechanism rather than declaring a test brittle from syntax alone.

**Complete when:** all properties have been considered, findings have evidence, and deliberate tradeoffs are distinguished from defects.

## 4. Verify Material Uncertainty

Inspect commands before execution. Run bounded local checks only when they are safe and consistent with the user's request. Ask before paid/external calls, credential use, destructive fixtures, environment installation, or expensive runs. Use temporary output locations and preserve the worktree.

Choose evidence that can settle the concern: timing, isolated/grouped or reordered execution, repeated runs, existing failure logs, or an actual host/native boundary. Record exact commands, configuration, outcomes, and whether the intended scenario executed. Repeated success supports a claim; it does not prove universal determinism or isolation.

A source-inspected defect hypothesis is not a reproduced failure. Mutation or refactoring probes require separate authorization and an isolated copy; never alter the user's checkout just to validate the audit. When execution is unavailable, identify the missing evidence and keep the claim provisional.

**Complete when:** consequential claims are supported by inspection or measured evidence at the stated confidence, with remaining uncertainty explicit.

## 5. Report Improvements

Return a concise Markdown audit in the conversation unless a destination was requested:

1. **Scope:** revision, inventory and inspected counts, exclusions, sampling, and commands run.
2. **Strengths:** useful patterns and confidence worth preserving.
3. **Prioritized findings:** location/test, property, protected promise, evidence, impact, confidence, and recommendation.
4. **Suite perspective:** which properties are supported, traded off, concerning, or unverified; important boundary gaps.
5. **Next steps and uncertainty:** the smallest useful improvements and evidence still needed.

Recommend **keep, strengthen, simplify, move to a better boundary, or retire**. Explain the expected confidence gained and maintenance cost. Suggest a concrete replacement assertion or scenario when useful. Recommend retirement only after identifying the protected promise and showing it is obsolete or adequately protected elsewhere; unclear intent warrants investigation.

Infer missing coverage from demonstrated behavioral distinctions and boundary risks, not coverage percentages alone. Use severity for practical impact, not a composite quality score. Make no suite-wide quality or completeness claim beyond the inspected scope.

**Complete when:** recommendations preserve useful protection, map to evidence, and clearly distinguish verified outcomes from hypotheses. State that files were left unchanged and disclose execution gaps.
