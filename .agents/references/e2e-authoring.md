<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Selection and Authoring

Apply this contract when a change adds, removes, moves, or repairs test evidence. Keep the evidence
that the accepted behavior needs. Give live E2E the smallest necessary responsibility.

## Select the Evidence Owner

Use the shortest stable layer that can observe the behavior:

1. Use a source unit test for deterministic logic.
2. Use an integration test for component wiring and repository-owned boundaries.
3. Use a package-contract test for compiled or packaged artifacts.
4. Use an `e2e-support` test for fixtures, registries, planners, selectors, parsers, and artifact
   construction.
5. Use live E2E only for a real shell, installer, process, network, filesystem, Docker, OpenShell,
   `/proc`, sandbox, hardware, external service, or GitHub Actions boundary.

Do not retain a live assertion only because a live test can observe it. Lower-layer and live evidence
may coexist only when they protect different contracts.

## Define the Live Contract

Before adding, expanding, or repairing live E2E evidence, record:

- the real boundary that requires live execution;
- the semantic outcome and distinct regression that the evidence protects;
- the lower-layer evidence that owns deterministic behavior;
- the canonical test that owns the live outcome; and
- the smallest live assertion that proves that outcome.

Do not add or retain the live assertion when these facts do not identify a distinct live contract.

## Add Live Coverage

Before adding or extending E2E coverage, name the semantic coverage dimension
that is missing. Existing migrated examples show the intended granularity:
catalogue targets pair environment, onboarding profile, expected state, optional
lifecycle, and `suiteIds`; `dashboard-remote-bind` owns install, onboard,
artifacts, and terminal cleanup; `credential-sanitization`,
`telegram-injection`, `messaging-providers`, `messaging-compatible-endpoint`,
and `gpu-e2e` are separate behavior contracts rather than one broad "full" run.
Extend matrix metadata only when it selects an already-defined behavior
dimension. Do not duplicate behavior logic in a second registry, workflow list,
or hand-maintained catalogue; use the typed registry and shared E2E workflow
planner documented in [`test/e2e/README.md`](../../test/e2e/README.md) and
[`test/e2e/docs/README.md`](../../test/e2e/docs/README.md).

If a gap is real but not ready for a test, record it as a combinatorial gap
instead of adding speculative coverage. State the missing dimension, the
existing nearest coverage, why a new test would duplicate or overreach current
behavior, and the issue or PR that will make it testable. A gap note must not
change release judgment by itself.

Assert outcomes, state, artifacts, and redacted diagnostics. Do not assert
incidental terminal output, progress wording, spinner frames, ANSI escape
sequences, timing text, or prompt layout unless that text is the product
contract under review. Terminal traces are evidence; they are not stable
behavior unless the issue explicitly makes them the behavior.

Retries require a checked-in bounded policy with a narrow transient signature,
owner, idempotence or reconciliation basis, and attempt evidence. Do not add
unproven retries, ambiguous mutation retries, or broad failed-job reruns. A
mutation retry is allowed only after the test reconciles the external state and
proves repeating the same desired operation is safe. Keep bounded operation
retries separate from complete workflow reruns: `E2E / Main Retry Evidence` records
attempts and does not request a broad rerun, while `Automation / Recover Platform CI Runner` owns
at most one full rerun only for authenticated GitHub-hosted runner-loss
evidence.

## Move or Remove Evidence

When pruning live E2E evidence:

- Move deterministic evidence to its current lower-layer owner only when equivalent evidence is
  absent.
- Remove duplicate assertions and assertions about incidental output, progress text, timing, or
  third-party wording.
- Preserve live evidence for each accepted boundary outcome, including required denial, recovery,
  cleanup, and security behavior.
- Do not hide duplicate live assertions in helpers, snapshots, aggregate receipts, or shell
  conditions.

For each changed live assertion, record:

- whether it stayed live, moved to a lower layer, or was removed;
- its semantic outcome and distinct regression, or that it protects no product contract;
- its lower-layer owner when moved; and
- the lower-layer evidence owner or a statement that no deterministic behavior applies, real
  boundary, canonical live test, and smallest live assertion when it stayed live.

Explain why the complete set of dispositions preserves semantic coverage.

## Repair a Failure

Classify the failure before changing the test:

- Fix a product or live-boundary defect in its behavior owner. Retain focused live evidence.
- Prove deterministic helper, fixture, registry, selector, parser, or planner defects in a lower
  layer.
- Replace an unstable incidental assertion with a stable outcome assertion. Remove it when another
  test owns the outcome.
- Do not change semantic coverage for an infrastructure or external failure.
- Add a retry only under the repository's checked-in retry policy.
