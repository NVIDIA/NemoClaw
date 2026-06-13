<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E Migration Notes

This file describes how to move coverage into the single Vitest E2E system
without confusing that work with the retired typed-shell scenario runner or a
second bash-driven harness. Vitest is the harness, GitHub Actions is the matrix,
and NemoClaw fixtures may invoke real subprocess and system boundaries when
those boundaries are the contract.

Migration state is tracked outside the repository in GitHub issues and pull
requests. Use GitHub issues and pull requests as the source of truth for status
changes, ownership, replacement coverage, and contract-preserving migration
decisions.

## Current State

The scenario runner cutover is complete:

- `e2e-vitest-scenarios.yaml` is the scenario workflow.
- `test/e2e-scenario/live/registry-scenarios.test.ts` is the registry-driven
  live scenario entrypoint.
- `test/e2e-scenario/fixtures/` owns phase fixtures, clients, artifact
  capture, redaction, cleanup, and shell-probe bridges.
- `test/e2e-scenario/scenarios/run.ts` only lists scenarios and emits the live
  Vitest matrix.
- The typed-shell scenario runner, shell validation-suite tree, and retiring
  scenario workflows are removed. See `RETIREMENT.md`.

Direct legacy E2E scripts under `test/e2e/test-*.sh` remain in place until they
are migrated by contract. Some currently test shell, install, platform, process,
or full user-flow behavior. Preserve those real boundaries by invoking them from
Vitest tests and fixtures instead of keeping a separate durable E2E runner.
Issue #5098 tracks family-by-family migration, augmentation, and eventual
deletion decisions for those scripts.

## Target Architecture

The durable E2E system has one execution path:

- Vitest owns execution, filtering, reporters, timeouts, fixture lifecycle,
  skip handling, and CI integration.
- NemoClaw fixtures own setup, onboarding, lifecycle mutations,
  expected-state probes, assertion helpers, expected-failure evidence,
  cleanup, artifacts, and secret redaction.
- `test/e2e-scenario/fixtures/` is fixture/support code, not a test harness
  or runner.
- Typed scenario definitions and matrix helpers describe stable scenario IDs
  and supported combinations without becoming a second runner.
- Product-facing manifests describe desired setup/onboarding state, not test
  execution logic.
- Shell and system-boundary behavior should be exercised from Vitest when it is
  the contract or lowest-risk adapter.

## Migration Governance

The former `test/e2e-scenario/migration/legacy-inventory.json` ledger and
generated legacy assertion inventories are removed because they duplicated live
GitHub issues and pull requests and quickly became stale sources of truth.

The useful deletion invariant is deterministic and smaller: the top-level
legacy bash E2E script set and the scheduled `nightly-e2e.yaml` legacy wiring
are frozen by workflow contract tests. When a PR intentionally retires a
nightly-wired legacy script, it removes the script, removes the nightly workflow
reference, and updates the workflow allowlist test in the same change.

GitHub issues and PRs still explain why a script is migrated or retired, but the
repository should not depend on a separate PR-body proof format. The
machine-checkable boundary is the source tree plus workflow tests.

## Migration Pattern

When moving behavior from a legacy E2E script:

1. Identify the actual contract: CLI behavior, installer behavior, full user
   journey, process boundary, platform boundary, or another observable behavior.
2. Add or update manifests only when product setup/onboarding state changes.
3. Add typed scenario registry coverage when the live matrix needs a stable
   scenario ID.
4. Add only the fixture or helper needed for the migration.
5. Preserve real boundaries. Use `bash`, login shells, `/proc`, process
   signals, `sudo`, Docker host state, installer scripts, or full journey flows
   from Vitest when they are the behavior being tested.
6. Prove equivalence in the PR discussion, then delete the bash harness when the
   Vitest test preserves the same value. If the script is wired into nightly,
   remove that workflow reference and update the allowlist test in the same PR.

## Useful Commands

```bash
# Scenario registry and matrix
npx tsx test/e2e-scenario/scenarios/run.ts --list
npx tsx test/e2e-scenario/scenarios/run.ts --emit-live-matrix
npx tsx test/e2e-scenario/scenarios/run.ts --emit-live-matrix --scenarios ubuntu-repo-cloud-openclaw

# Fixture/support tests
npx vitest run --project e2e-vitest-support --silent=false --reporter=default

# Opt-in live Vitest scenarios
npm run build:cli
NEMOCLAW_RUN_E2E_SCENARIOS=1 npx vitest run --project e2e-scenarios-live --silent=false --reporter=default
```

The old `--emit-matrix`, direct `--scenarios` execution, and `--plan-only`
interfaces are retired.
