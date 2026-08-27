<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test Directory

The test directory uses execution lanes first and behavior areas second.

## Execution lanes

| Directory | Vitest project | Purpose |
|---|---|---|
| `installer-integration/` | `installer-integration` | Tests that spawn the real installer process |
| `package-contract/` | `package-contract` | Tests that import compiled CLI or plugin artifacts |
| `e2e/support/` | `e2e-support` | Deterministic tests for E2E fixtures and support code |
| `e2e/live/` | `e2e-live` | Opt-in tests that mutate external state |

Other `*.test.js` and `*.test.ts` files outside the dedicated lanes above belong to the `integration` project.
The project globs in `vitest.config.ts` must remain disjoint and exhaustive.

## Shared test code

- Put passive inputs in `fixtures/`.
- Put deterministic reusable utilities in `helpers/`.
- Put stateful harnesses, fake services, and process setup in `support/`.
- Keep one-test companion modules with their owning test when practical.

## Adding tests

Choose the execution lane from the boundary that the test exercises.
Within the integration project, group new tests by the behavior that owns the assertion.
For example, `process-recovery/` owns sandbox process and forward recovery coverage, `channels/` owns channel lifecycle coverage, and `credentials/` owns host credential storage and reset coverage.
Do not put an ordinary integration test in `e2e/` or `package-contract/`.

Run `npm run test:projects:check` after adding or moving a test.

## Regression evidence

Reproduce a defect before fixing it when feasible. If reproduction is not feasible, record why and
preserve the strongest pre-fix evidence. Add regression coverage at the earliest stable behavior
boundary that could detect the defect. Add higher-level coverage only for a distinct integration
boundary. Include negative and state-safety evidence when the acceptance criteria or risk require it.

Rerun affected tests after an edit or hook autofix changes tested behavior.

When a defect escapes normal controls, record the product cause, detection gap, and smallest durable
prevention evidence in the issue or pull request. Search a bounded set of sibling paths for the same
failure class. Fix sibling instances only when they share the cause and fit the current scope.

## Test contracts

Do not read shipped YAML, JSON, manifests, workflows, or E2E runtime files only to assert literal
structure. Use synthetic fixtures for schema tests. Test behavior through the owning consumer or
validator.

A direct source-shape assertion requires a reviewed security or compatibility trust-boundary
exception. Put this annotation immediately above the test:

```ts
// source-shape-contract: security -- Cross-field digest equality protects the shipped trust anchor
```

Use `security` or `compatibility` as the category and state the concrete reason. Add the file, test
title, and category to the reviewed allowlist in `scripts/find-source-shape-tests.mts`.
`npm run source-shape:check` rejects unsupported categories, short or misplaced reasons, missing
allowlist entries, and unused entries.

New test files must use TypeScript. Each plugin test must execute at least one Vitest `expect`
assertion. The repository test configuration owns automatic mock and environment cleanup; restore
direct global or environment mutations in the test that owns them.

Follow [`WRITING.md`](../WRITING.md) for behavior-oriented test titles. Put a local issue reference
in a final suffix such as `(#1234)`.

## macOS host tools

Some tests require GNU command-line tools that macOS does not provide. The `macos-vitest` job in
[`.github/workflows/platform-vitest-main.yaml`](../.github/workflows/platform-vitest-main.yaml) owns
the authoritative package list. Install those tools and put their GNU binaries first on `PATH`
before running the suite on macOS. This job runs on pushes to `main` and manual dispatches, not on
pull requests.
