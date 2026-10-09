---
name: test-driven-development
description: Test-drive application-owned rules, interactions, state transitions, authorization, calculations, persistence, API contracts, and bug fixes—even when the user does not request TDD. Route behavior-preserving structural work to safe-refactoring. Ordinary styling, declarative configuration, generated code, dependency changes, mechanical wiring, and test-only maintenance use targeted verification instead.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test-Driven Development

```text
LIST BEHAVIORAL VARIANTS → SELECT ONE → RED → GREEN → REFACTOR → REPEAT
```

## 1. Qualify and Route the Change

Classify every requested outcome. Use TDD for meaningful application-owned behavior: what a user or caller can do, receive, access, navigate to, persist, or observe.

Route other work to its appropriate verification:

- Behavior-preserving structural change → `safe-refactoring`.
- Ordinary styling → direct implementation and required visual review.
- Declarative metadata or configuration → schema, framework, type, or lint checks.
- Generated code or dependencies → generator, build, and integration checks.
- Mechanical wiring or test-only maintenance → targeted existing checks.

A GraphQL deprecation declaration, for example, usually needs schema inspection rather than an assertion repeating the declaration.

For mixed structural and behavioral work, establish a green baseline, move existing responsibilities through `safe-refactoring`, then begin RED for the new or corrected promise. Existing behavior needs preservation, not an artificial failure.

When the user is exploring, inspect the code and clarify the behavior before editing. Treat a direct implementation or bug-fix request as agreement without redundant confirmation. Briefly explain routing when the absence of a behavioral test would be surprising.

### UI Contracts

Separate capabilities from presentation. Test interactions, accessibility roles/names/states, navigation, and information access. Implement ordinary typography, color, spacing, and layout using design inputs and established components; visual parity belongs to visual verification, not the TDD cycle.

Geometry, timing, and rendered output qualify when they are explicit behavioral promises: an effective accessible touch target, a response-time budget, or a shader lighting the requested region. Observe that outcome rather than freezing incidental classes, props, DOM nesting, or pixels.

Ordinary copy is presentation. Update an interaction test's accessible-name selector when the control is renamed. Give exact wording dedicated coverage only when it is a contract, such as legal or safety text, a required API error, or a domain distinction affecting a decision.

**Complete when:** every outcome is assigned to TDD or another verification process, and the requested direction is understood.

## 2. List Variants and Select One

List the basic case, meaningful boundaries, failures or repeated actions, and existing promises at risk. Scale the list to the change; one item may suffice. Describe outcomes in product or domain vocabulary, leaving internal design for implementation and refactoring.

For stateful or durable work, distinguish interruption before and after relevant commits and the consequences for retry, recovery, and later actions. A status label alone does not identify a failure window.

Select one example by asking:

- What outcome does the software promise under these circumstances?
- What plausible application regression would this test catch?
- What alternative correct implementation should still pass it?

Choose a stable test expressing this promise. Derive expected results independently from requirements or domain rules, rather than copying computed output. An excessive withdrawal should be rejected regardless of the internal balance representation. Testing that rejection protects our rule; repeating a framework's implementation does not.

Add discovered examples to the list as work proceeds. Make only the selected item executable before implementing it; keep the rest as scenarios rather than a batch of speculative tests.

<example>
Request: reject withdrawals above the available balance.

- A withdrawal of exactly the balance succeeds.
- A withdrawal one cent above the balance is rejected. ← selected: it states the rule and fails today.
- A rejected withdrawal leaves the balance and history unchanged.
- Resubmitting a rejected withdrawal is rejected again.
</example>

**Complete when:** the list exists and one example identifies a promise, expected failure, and freedom to change the implementation.

## 3. Choose the Production Boundary

Trace the owning path: entrypoint, responsible logic, persistence where relevant, and observable result. Exercise that path or a stable production interface beneath it. When architecture changes, migrate tests to its new seams rather than retaining obsolete branches or inventing a competing test-only application.

Prefer assertions on outputs, visible state, contract-level events, errors, and persisted effects. Use real collaborators where practical; substitute dependencies that are slow, nondeterministic, unavailable, destructive, or external.

Distinguish what each test proves. A fake, prop assertion, or direct adapter call may check wiring without establishing the native, host, network, or rendered outcome. Name the narrower subject honestly and identify proportionate boundary evidence for important unverified assumptions.

Balance fast, specific feedback with production confidence. Broader checks earn their cost when they establish a promise the focused test cannot.

**Complete when:** the selected test targets the owning path, and any necessary boundary evidence is identified.

## 4. Run the Small Cycle

### RED

Add or update the selected focused test and run the smallest relevant command. Valid RED exercises the intended behavior and fails for the expected application defect.

Repair syntax, dependency, command, fixture, or harness failures, then rerun against unchanged production before entering GREEN. Those failures do not establish behavioral RED.

If the test passes immediately, determine whether the promise already holds or the assertion misses the distinction. Retain useful already-passing regression or characterization coverage, but label it separately from RED. Revise an insufficient assertion only to express the real contract; select a genuinely missing behavior before production changes.

**Complete when:** the focused test fails for the stated behavioral reason.

### GREEN

Make the smallest direct production change satisfying the example. Defer broader design work. Keep the valid behavioral expectation intact and rerun the same test and relevant existing tests.

**Complete when:** the example and relevant prior tests pass because the missing behavior now exists.

### REFACTOR

While green, remove duplicated knowledge, clarify names, and improve responsibilities without adding behavior. Verify after each meaningful cleanup, then select the next item from the list.

**Complete when:** relevant tests remain green and cleanup preserved behavior.

## 5. Reconcile Scope Changes

Apply this branch whenever requirements are withdrawn or deferred, including removed UI or copy. Tests describe present-tense contracts, not development history.

1. Restate retained behavior and update the list.
2. Remove withdrawn production behavior and its tests.
3. Run the smallest relevant suite and classify failures by the contract they protect.
4. Update tests or production for retained contracts; delete assertions whose contract disappeared.

Keep absence coverage when absence is independently meaningful: authorization rejection, overdraft prohibition, or suppression of a dangerous side effect. A temporary test may drive removal, but retire it afterward unless that absence remains a promise. Avoid translating deleted features or incidental copy into permanent `does not` assertions.

**Complete when:** remaining tests protect retained promises, and changed assertions are justified by contract changes rather than used to conceal regressions.

## 6. Verify and Report

Reconcile every retained item on the behavioral list with RED → GREEN evidence or explicitly identified already-passing coverage. For a bug fix, confirm that its focused test reproduced the reported behavior before the fix.

Run nearby regression checks and the necessary boundary checks selected in step 3. Confirm the scenario actually executed: a green recovery flow that skipped interruption is not recovery evidence.

**Complete when:** every retained behavior is protected, test edits reflect contract or boundary changes, relevant checks pass, and the intended boundary scenarios ran. If verification is blocked, report the unverified promise; a passing proxy does not close that gap.

Report the behavior, production change, focused failure/pass evidence, other verification, and remaining confidence gaps. Adapt detail to the change's risk. Routed work uses its own verification and reporting process.
