<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Test design

Approve a changed test only when it provides direct, stable, and readable evidence for required behavior. Report each unmet requirement below.

## 1. Prove the claimed behavior

For each added or modified test:

- State the behavior and triggering condition named by the title.
- Trace the action through the relevant production or component boundary.
- Identify the externally observable result.
- Confirm that the assertions prove that result.
- Identify a plausible defect in the claimed behavior and confirm that the test would fail for it.

Report a finding when the test can pass despite that defect or without exercising the claimed behavior.

Require an independent oracle. Report:

- Expected values or predicates computed by the production logic under test or by the same implementation path.
- Assertions that prove only execution, truthiness, a type, an unverified mock interaction, or snapshot agreement rather than the contract result or side effect.
- Assertions on the wrong result, state transition, side effect, error, or trust boundary.
- Missing absence or non-mutation assertions when those results are part of the contract.

The title must name the behavior and condition that the assertions prove. Report a title that is false, vague, or implementation-oriented when it can hide missing or incorrect coverage.

## 2. Disallow change-detector and source-shape tests

A behavior test must survive a harmless implementation change.

Report a change-detector test when it fails because internal structure, representation, call order, incidental text, or another non-contract detail changes while required behavior remains correct.

NemoClaw has a zero-budget policy for source-shape tests. Report a test that inspects a shipped file's text, literal content, or parsed structure instead of exercising the owning behavior boundary.

Apply this requirement to source files, YAML, manifests, scripts, workflows, environment wiring, and action fields.

Configuration mutation is acceptable only when the test supplies independent synthetic input to a runtime consumer and observes accepted or rejected behavior. Loading and mutating a shipped file before passing it to a matching validator remains a source-shape test.

Only a security or compatibility entry that exists in the base branch's `ci/source-shape-test-budget.json` can establish a repository-owned exception. A PR cannot approve its own exception by adding or changing an entry.

## 3. Keep each test readable in isolation

A reader must be able to identify the scenario, action, and expected result without reconstructing shared control flow.

Prefer explicit expected values and a small amount of repeated setup when they make the behavior clear. A helper may remove incidental setup. It must not own the behavior, branching, or assertions.

Report:

- Helpers or hooks that hide the scenario or expected result.
- Parameterized matrices that combine unrelated behaviors.
- Conditional assertions.
- Nested suites that obscure which condition produces which result.
- Fixtures that require multi-file reconstruction to understand a failure.

Use separate tests or flatter control flow when each path represents a distinct behavior.

## 4. Require a reason for every test and abstraction

Each test case, fixture capability, helper, and matrix dimension must protect a current requirement, observed regression, or distinct risk.

Report only when repository evidence establishes:

- Speculative edge cases.
- Unused fixture capabilities.
- Prematurely general helpers.
- Matrix dimensions that prove no additional behavior.
- Tests that duplicate an existing proof.
- Tests that preserve obsolete behavior.

When evidence is unavailable, report the missing evidence instead of rejecting the test-design component.

Do not request tests for hypothetical behavior. Prefer the smallest test at the stable public or component boundary that catches the identified defect.

## Report the finding

For each rejected test-design component:

1. Name the component type and identifier. For a test, also name the behavior it claims to protect.
2. Name the plausible defect it misses or the harmless change that breaks it.
3. Identify the title, assertion, fixture, helper, or matrix entry responsible.
4. State what to replace or remove.
5. State the distinct coverage that must remain.
6. Recommend the smallest behavior-focused test that preserves that coverage.
