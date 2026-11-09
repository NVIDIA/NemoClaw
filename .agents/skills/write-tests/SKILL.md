---
name: write-tests
description: Decide which layer and suite a new test belongs in (unit, contract, integration, or live E2E), prefer tofu test HCL scenarios over Rust, and avoid repeating coverage another layer owns. Use before writing, moving, or reviewing a test.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Write Tests

This skill decides where a test goes and what it asserts.
`test-driven-development` decides how to write it: a failing behavioral test first.
[Test layers](../../../internal-docs/contributing/testing.md#test-layers) and [run integration tests](../../../internal-docs/contributing/integration-tests.md) describe each suite and how to run it.

## 1. Name the behavior and its owner

Write the behavior as circumstances and an observable outcome, then name the one component that decides it: a crate's rule, one provider type, the compiled graph across providers, the SDK or CLI, or a real engine, cluster, image, or model.
The owner picks the layer.
A test above the owner's layer repeats the owner's tests; a test below it cannot observe the behavior.

## 2. Find what already covers it

Before writing, search every layer for the behavior: the owner's crate tests, the provider `tests/contract/` scenarios, `crates/nemoclaw-e2e/tests/integration/`, and `crates/nemoclaw-e2e/tests/e2e/`.
Search by the resource type, field, error text, and fixture fault, not only by test name.

- When a lower layer covers the behavior, don't add a test; cite the covering test instead.
- When your change makes an existing higher-layer check redundant, remove it in the same change and name the test that now covers it.
- When coverage is split, such as a rule unit-tested and its wiring untested, add only the missing part at the layer that observes it.

## 3. Choose the layer

Use the cheapest layer that can observe the behavior.

| Layer | Owns | Put it in |
|---|---|---|
| Unit | One crate's rules with in-process fakes: parsing, validation, compilation, planning, formatting, provider backends, and the SDK's stage order and saved state over a scripted OpenTofu | The crate's `src` tests or its `integration` binary |
| Contract | One provider type through pinned OpenTofu against fake gateways, engines, model servers, or Kubernetes APIs: what it plans, applies, refreshes, and tears down, including after failures | `crates/<provider>/tests/contract/` |
| Integration | The SDK-compiled graph across providers, and the SDK and CLI over a bundle, against local fixtures | `crates/nemoclaw-e2e/tests/integration/` |
| Live E2E | Only what needs a real Docker engine, cluster, image, model, or host | `crates/nemoclaw-e2e/tests/e2e/` |

Keep live E2E tests to successful paths: a deployment comes up, agents answer, and an unchanged reapply changes nothing.
Inject failures, recoveries, refusals, drift, and retries at the contract or integration layer, where fixtures make them repeatable.
A live check that a fixture can simulate belongs below the live layer.

## 4. Prefer `tofu test` scenarios

Within each layer, write a native `tofu test` scenario before a Rust test:

| Layer | Scenario | Rust only for what `tofu test` cannot express |
|---|---|---|
| Contract | `tests/contract/hcl/<module>/tests/*.tftest.hcl` | `tests/contract/failures/`: a command that must fail, a saved plan, or the state file |
| Integration | `tests/integration/hcl/tests/*.tftest.hcl`, with documents in `crates/nemoclaw-e2e/cases/` or unchanged `examples/` | `tests/integration/rust/`: SDK and CLI behavior |
| Live E2E | `tests/e2e/hcl/tests/*.tftest.hcl`, run by `hcl_live::case` | A probe in `tests/e2e/hcl_live.rs` for a real boundary operation that HCL cannot run, such as invoking an agent |

Use Rust only when the behavior needs one of these:

- an expected provider error: `expect_failures` accepts only HCL preconditions, postconditions, and `check` blocks, and a run that fails any other way skips the rest of the file;
- the SDK or CLI: export, `intent.json`, the unfinished-apply guard, diagnostics files, or CLI output and exit status;
- a saved plan, an interrupt, a cancellation, or editing the state file;
- a destroy before the end of the test, or a changed NemoClaw document applied to the same deployment.

[`tofu test` patterns](references/tofu-test.md) covers the harness, fixture changes, and the framework's limits.

## 5. Assert the outcome

Assert the few semantic facts that identify a failure, one outcome per assertion, with a message that names it.

- Compare identities, bindings, and counts only when they are the contract, such as an unrelated agent that must not restart.
- Don't compare complete objects, generated names, serialization, or unrelated defaults, or repeat the same outcome through several representations.
- Check unchanged reconciliation directly, such as gateway effects or agent starts against a baseline; a second apply that succeeds proves nothing.
- Expose facts from fixtures and write the expectation in the test.

Show that each new assertion can fail: break the behavior, or point the assertion at a value the resource does hold, observe the failure, and revert.

## 6. Keep the suite fast

Don't raise a time budget; make the test faster, or split a long scenario.
Add fixture behavior once, for a concrete test, in the shared fixture, not as a per-test fake service.

## Report

State the behavior, the layer and suite you chose and why, the existing coverage you found and removed or cited, the regression the new test detected, and the checks you ran.
