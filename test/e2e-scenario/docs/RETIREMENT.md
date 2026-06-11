<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Typed-Shell Scenario Runner Retirement

PR #5106 retired the typed-shell scenario runner as part of #5098 Phase 0.

## What Was Removed

- `.github/workflows/e2e-scenarios.yaml`
- `.github/workflows/e2e-scenarios-all.yaml`
- `test/e2e-scenario/scenarios/compiler.ts`
- `test/e2e-scenario/scenarios/orchestrators/`
- `test/e2e-scenario/scenarios/assertions/`
- `test/e2e-scenario/scenarios/probes/`
- `test/e2e-scenario/nemoclaw_scenarios/`
- `test/e2e-scenario/onboarding_assertions/`
- `test/e2e-scenario/validation_suites/`
- `test/e2e-scenario/runtime/lib/`
- `test/e2e-scenario/runtime/reports/`
- `scripts/e2e/lint-conventions.ts`

## Why

The project chose Vitest fixtures as the scenario execution model in #4941.
Keeping the typed-shell runner meant maintaining a second execution path with
its own compiler, phase orchestration, shell workers, suite dispatcher, and
workflows.

Before deleting that path, the surviving Vitest workflow gained the reporting
and artifact shape operators needed from the retired workflows:

- dispatch-time matrix summary with Scenario, Runner, and Label columns;
- per-scenario `run-plan.json`;
- per-phase `environment.result.json`, `onboarding.result.json`, and
  `state-validation.result.json`;
- per-scenario step summary rendered from `run-plan.json`;
- explicit artifact upload allowlist with action, log, shell command-evidence,
  and JSON summary paths plus 14-day retention.

## What Replaced It

- `test/e2e-scenario/scenarios/run.ts --emit-live-matrix` emits the live
  GitHub Actions matrix.
- `.github/workflows/e2e-vitest-scenarios.yaml` runs the live matrix.
- `test/e2e-scenario/live/registry-scenarios.test.ts` executes supported
  registry scenarios through Vitest.
- `test/e2e-scenario/fixtures/` owns fixtures, clients, shell-probe bridges,
  artifact writing, cleanup, and redaction.

## What Was Not Removed

Direct legacy E2E scripts under `test/e2e/test-*.sh` remain in place. Those
scripts are governed by #5098 and live GitHub issues and pull requests. They
should be migrated by contract into the single Vitest E2E system. A PR that
retires a nightly-wired legacy E2E script removes the script, removes the
`nightly-e2e.yaml` reference, and updates the workflow allowlist test in the
same change.

That includes the security and messaging contracts that the deleted typed-shell
validation suites used to mirror. Until #5098 migrates those families into
Vitest fixtures, the active source of truth remains:

- `test/e2e/test-credential-sanitization.sh` and
  `test/e2e/test-credential-migration.sh` for credential leak prevention and
  host credential-store hardening.
- `test/e2e/test-network-policy.sh`, `test/e2e/test-brave-search-e2e.sh`, and
  `test/e2e/test-openshell-gateway-upgrade.sh` for network policy and gateway
  credential-rewrite behavior.
- `test/e2e/test-shields-config.sh` for shields, config permissions, and
  redacted config output.
- `test/e2e/test-telegram-injection.sh`, `test/e2e/test-messaging-providers.sh`,
  `test/e2e/test-channels-add-remove.sh`, and
  `test/e2e/test-channels-stop-start.sh` for messaging injection, channel
  policy preservation, bridge credential isolation, and provider rewrite paths.
