<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Selection and Authoring

Use live E2E only for behavior that needs a real shell, installer, process,
Docker, OpenShell, `/proc`, sandbox, external service, or GitHub Actions
boundary. Put deterministic code, parser, registry, workflow-planner, and
fixture logic in unit, integration, package-contract, or `e2e-support` tests
instead. Do not add a live E2E target for a check that can be observed through a
stable local boundary.

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
