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
Do not put an ordinary integration test in `e2e/` or `package-contract/`.

Run `npm run test:projects:check` after adding or moving a test.
