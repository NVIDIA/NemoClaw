<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E Migration Notes

This file describes how to move coverage into the single E2E system
without confusing that work with the retired typed-shell target runner or a
second bash-driven harness. Vitest is the harness, GitHub Actions is the matrix,
and NemoClaw fixtures may invoke real subprocess and system boundaries when
those boundaries are the contract.

Migration state is tracked outside the repository in GitHub issues and pull
requests. Use GitHub issues and pull requests as the source of truth for status
changes, ownership, replacement coverage, and contract-preserving migration
decisions.

## Current State

The target runner cutover is complete:

- `e2e.yaml` is the target workflow.
- `test/e2e/live/registry-targets.test.ts` is the registry-driven
  live target entrypoint.
- `test/e2e/fixtures/` owns phase fixtures, clients, artifact
  capture, redaction, cleanup, and shell-probe bridges.
- `test/e2e/registry/run.ts` only lists targets and emits the live
  matrix.
- The typed-shell target runner, shell validation-suite tree, and retiring
  target workflows are removed. See `RETIREMENT.md`.

Direct E2E implementations have been migrated by contract. The former
`test/e2e/test-*.sh` entry points are removed, and current workflows call
E2E targets directly. Shell, install, platform, process, and full user-flow
behavior should remain in E2E tests and fixtures when those boundaries are
the contract.

## Target Architecture

The durable E2E system has one execution path:

- Vitest owns execution, filtering, reporters, timeouts, fixture lifecycle,
  skip handling, and CI integration.
- NemoClaw fixtures own setup, onboarding, lifecycle mutations,
  expected-state probes, assertion helpers, expected-failure evidence,
  cleanup, artifacts, and secret redaction.
- Registry-driven live targets publish sanitized onboard trace timing evidence
  at `e2e-artifacts/live/<target>/cloud-onboard-trace-timing-summary.json`.
  The workflow owns `NEMOCLAW_TRACE_DIR`, keeps raw traces under runner
  temporary storage, and deletes those raw traces before uploading artifacts.
  Older issue and migration notes may call this the Vitest artifact path; in
  the current consolidated workflow that path is the live registry-target
  artifact root.
  The dedicated `cloud-onboard` artifact remains the only source for the
  Slack and GitHub scorecard timing comparison.
- `test/e2e/fixtures/` is fixture/support code, not a test harness
  or runner.
- Typed target definitions and matrix helpers describe stable target IDs
  and supported combinations without becoming a second runner.
- Product-facing manifests describe desired setup/onboarding state, not test
  execution logic.
- Shell and system-boundary behavior should be exercised from the E2E test
  when it is the contract or lowest-risk adapter.

## Migration Governance

The former `test/e2e/migration/legacy-inventory.json` ledger and
generated retired assertion inventories are removed because they duplicated live
GitHub issues and pull requests and quickly became stale sources of truth.

The useful deletion invariant is deterministic and small: workflows call Vitest
directly, source-shape checks reject reintroduced top-level shell E2E
entrypoints, and workflow contract tests cover the current CI wiring.

GitHub issues and PRs still explain why a script is migrated or retired, but the
repository should not depend on a separate PR-body proof format. The
machine-checkable boundary is the source tree plus workflow tests.

## Migration Pattern

When moving behavior from a former E2E script:

1. Identify the actual contract: CLI behavior, installer behavior, full user
   journey, process boundary, platform boundary, or another observable behavior.
2. Add or update manifests only when product setup/onboarding state changes.
3. Add typed target registry coverage when the live matrix needs a stable
   target ID.
4. Add only the fixture or helper needed for the migration.
5. Preserve real boundaries. Use `bash`, login shells, `/proc`, process
   signals, `sudo`, Docker host state, installer scripts, or full journey flows
   from the E2E test when they are the behavior being tested.
6. Prove equivalence in the PR discussion, then remove the bash implementation
   and update any workflow callers to invoke the E2E target directly.

## Useful Commands

```bash
# Target registry and matrix
npx tsx test/e2e/registry/run.ts --list
npx tsx test/e2e/registry/run.ts --emit-live-matrix
npx tsx test/e2e/registry/run.ts --emit-live-matrix --targets ubuntu-repo-cloud-openclaw

# Fixture/support tests
npx vitest run --project e2e-support --silent=false --reporter=default

# Opt-in live E2E targets
npm run build:cli
NEMOCLAW_RUN_LIVE_E2E=1 npx vitest run --project e2e-live --silent=false --reporter=default
```

The old `--emit-matrix` and `--plan-only` interfaces are retired.
