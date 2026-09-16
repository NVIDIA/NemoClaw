<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Select Test Evidence

Apply this contract when a change adds, removes, moves, or repairs test evidence. Keep as much
evidence as the accepted behavior needs and as little live responsibility as possible.

## Select the Owner

Start with the shortest stable layer that can observe the behavior:

1. Use a source unit test for deterministic logic.
2. Use an integration test for component wiring and repository-owned boundaries.
3. Use a package-contract test for compiled or packaged artifacts.
4. Use an `e2e-support` test for fixtures, registries, planners, selectors, parsers, and artifact
   construction.
5. Use live E2E only for a real process, network, filesystem, container, hardware, external service,
   or GitHub Actions boundary.

Do not retain a live assertion only because a live test can observe it. Lower-layer and live evidence
may coexist only when they protect different contracts.

## Justify Live Evidence

Before adding, expanding, or repairing live E2E evidence, record:

- the real boundary that requires live execution;
- the semantic outcome and distinct regression that the evidence protects;
- the lower-layer evidence that owns deterministic behavior;
- the canonical test that owns the live outcome; and
- the smallest live assertion that proves that outcome.

Do not add or retain the live assertion when these facts do not identify a distinct live contract.

## Move or Remove Evidence

When pruning live E2E evidence:

- Move deterministic evidence to its current lower-layer owner only when equivalent evidence is
  absent.
- Remove duplicate assertions and assertions about incidental output, progress text, timing, or
  third-party wording.
- Preserve live evidence for each accepted boundary outcome, including required denial, recovery,
  cleanup, and security behavior.
- Do not hide duplicate live assertions in helpers, snapshots, aggregate receipts, or shell conditions.

## Repair a Failure

Classify the failure before changing the test:

- Fix a product or live-boundary defect in its behavior owner. Retain focused live evidence.
- Prove deterministic helper, fixture, registry, selector, parser, or planner defects in a lower layer.
- Replace an unstable incidental assertion with a stable outcome assertion, or remove it when
  another test owns the outcome.
- Do not change semantic coverage for an infrastructure or external failure.
- Add a retry only under the repository's checked-in retry policy.

Record which evidence stayed live, moved to a lower layer, or was removed, and why semantic
coverage remains complete.
