<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Scenario Migration Notes

This file describes how to move coverage into the Vitest scenario framework
without confusing that work with the retired typed-shell scenario runner.
Changing status, ownership, and per-test decisions belong in GitHub issues and
PRs.

Migration state is tracked outside the repository in GitHub issues and pull
requests.
Use GitHub issues and pull requests for status changes.

## Current State

The scenario runner cutover is complete:

- `e2e-vitest-scenarios.yaml` is the scenario workflow.
- `test/e2e-scenario/live/registry-scenarios.test.ts` is the registry-driven
  live scenario entrypoint.
- `test/e2e-scenario/framework/` owns phase fixtures, clients, artifact
  capture, redaction, cleanup, and shell-probe bridges.
- `test/e2e-scenario/scenarios/run.ts` only lists scenarios and emits the live
  Vitest matrix.
- The typed-shell scenario runner, shell validation-suite tree, and retiring
  scenario workflows are removed. See `RETIREMENT.md`.

Direct legacy E2E scripts under `test/e2e/test-*.sh` remain in place. Many are
expected to stay because they test shell/install/user-flow behavior or preserve
umbrella integration smoke value. #5098 tracks family-by-family migration,
augmentation, and eventual deletion decisions for those scripts.

## Target Architecture

The durable scenario framework has one execution path:

- Vitest owns execution, filtering, reporters, timeouts, fixture lifecycle,
  skip handling, and CI integration.
- NemoClaw fixtures own setup, onboarding, lifecycle mutations,
  expected-state probes, assertion helpers, expected-failure evidence,
  cleanup, artifacts, and secret redaction.
- Typed scenario definitions and matrix helpers describe stable scenario IDs
  and supported combinations without becoming a second runner.
- Product-facing manifests describe desired setup/onboarding state, not test
  execution logic.
- Shell scripts remain only for direct legacy E2Es or narrow system-boundary
  probes where shell is the contract or lowest-risk adapter.

## Deletion Inventory

`test/e2e-scenario/migration/legacy-inventory.json` is a machine-readable
deletion gate.

It must cover:

- every direct legacy shell entrypoint under `test/e2e/test-*.sh`;
- explicitly retained bridge entrypoints such as `test/e2e/brev-e2e.test.ts`;
- retired internal scenario-runner surfaces removed by the cutover.

Status values:

- `not-migrated`: legacy coverage has no equivalent typed scenario yet.
- `bridge-probe`: coverage is temporarily represented by a bridge path.
- `covered`: equivalent Vitest live scenario coverage exists.
- `retired`: maintainers agreed the legacy surface is no longer required.

Do not set `deletionReady: true` on a direct legacy script unless the record is
`covered` or `retired` and the approval issue records the deletion rationale.
The retired internal scenario-runner surfaces are already marked through #5098;
that does not imply direct legacy bash scripts are deletion-ready.

## Migration Pattern

When moving behavior from a legacy E2E script:

1. Identify the test family and policy from #5098: KEEP_BASH, HYBRID, or
   MIGRATE_TYPED.
2. Add or update manifests only when product setup/onboarding state changes.
3. Add typed scenario registry coverage when the live matrix needs a stable
   scenario ID.
4. Add fixture helpers before copying shell logic.
5. For HYBRID tests, keep the bash test and add a focused typed peer for the
   contract being strengthened.
6. For MIGRATE_TYPED tests, prove parity first, then mark the inventory row
   covered before any deletion PR.
7. Leave umbrella KEEP_BASH tests in place unless the tracking issue explicitly
   revises their classification.

## Useful Commands

```bash
# Scenario registry and matrix
npx tsx test/e2e-scenario/scenarios/run.ts --list
npx tsx test/e2e-scenario/scenarios/run.ts --emit-live-matrix
npx tsx test/e2e-scenario/scenarios/run.ts --emit-live-matrix --scenarios ubuntu-repo-cloud-openclaw

# Framework tests
npx vitest run --project e2e-scenario-framework --silent=false --reporter=default

# Opt-in live Vitest scenarios
npm run build:cli
NEMOCLAW_RUN_E2E_SCENARIOS=1 npx vitest run --project e2e-scenarios-live --silent=false --reporter=default
```

The old `--emit-matrix`, direct `--scenarios` execution, and `--plan-only`
interfaces are retired.
