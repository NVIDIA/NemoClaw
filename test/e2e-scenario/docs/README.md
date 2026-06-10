<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E scenario framework

NemoClaw's scenario E2E framework is currently a **hybrid** migration model.
It combines typed scenario builders, product-facing setup manifests, YAML
runtime metadata, and reusable shell suites while the older live E2E scripts
continue to run in parallel.

This hybrid model is transitional. The target architecture for #3588 and #4941
is **Vitest as the single scenario execution runner**, extended by NemoClaw
fixtures and typed domain helpers. Vitest owns test discovery, filtering,
timeouts, reporters, fixture lifecycle, skips, and CI integration. NemoClaw owns
scenario vocabulary, setup/onboarding helpers, product clients, evidence
collection, redaction, cleanup, and assertion helpers.

Shell scripts should be kept to the smallest practical set of system-boundary
probes or command fixtures, not a second planning or assertion-control runtime.

## Current sources of truth

Use the source that matches the task while the migration is in progress:

| Task | Current source |
| --- | --- |
| Scenario workflow fan-out and live execution | `test/e2e-scenario/scenarios/registry.ts`, `test/e2e-scenario/scenarios/scenarios/baseline.ts`, and `test/e2e-scenario/scenarios/run.ts` |
| Typed expected-state registry (single source of truth) | `test/e2e-scenario/scenarios/expected-states.ts` |
| Product-facing desired setup/onboarding state | `test/e2e-scenario/manifests/*.yaml` |
| Shell runner scenario resolution and live scenario execution | `test/e2e-scenario/nemoclaw_scenarios/scenarios.yaml` and `validation_suites/suites.yaml` (legacy YAML resolver path retired) |
| Reusable live suite assertions | `test/e2e-scenario/validation_suites/` |
| Existing nightly and platform E2E coverage | legacy `test/e2e/test-*.sh` scripts and their workflows |

The near-term migration goal is to keep these surfaces aligned while coverage is
being moved into scenario contracts and suites. The long-term goal is to remove
the split between typed planning and shell execution. Do not add new
legacy-style `test/e2e/test-*.sh` entrypoints unless there is a specific
maintainer-approved reason.

## Target runner model

Future scenario coverage should move toward one Vitest-based runner with these
properties:

- Vitest is the execution surface for live scenarios and owns lifecycle,
  filtering, reporting, timeouts, and fixture scopes;
- NemoClaw fixtures expose scenario-level helpers for setup, onboarding, host
  CLI access, gateway checks, sandbox checks, provider fixtures, evidence
  artifacts, redaction, and cleanup;
- typed scenario data and matrix helpers describe stable scenario IDs and
  supported combinations without becoming a second runner;
- product-facing manifests remain declarative setup inputs, not executable test
  programs;
- assertion modules prefer TypeScript probes and typed client helpers;
- shell is used only when the system under test is a shell command, host
  process, container command, or platform-specific probe;
- every shell call goes through a controlled spawn boundary with scoped
  environment, timeout, redaction, artifact capture, and command/argument
  validation;
- bridge work that expands the YAML/bash runner must also identify how that
  behavior will move into Vitest fixtures before legacy runner paths are
  removed.

The #4347-#4357 audit-phase issues should be read as acceptance coverage
requirements, not as a permanent requirement to keep YAML resolver or bash
runner deliverables. If a phase issue names YAML or shell-runner artifacts, map
that requirement to equivalent single-runner behavior unless maintainers
explicitly decide to keep a bridge path for the current migration step.

## Layered scenario model

The conceptual model is layered:

```text
base environment
  → onboarding profile / manifest
    → onboarding assertions
      → expected state
        → post-onboard suites
```

The current YAML shell runner expresses this through:

- `base_scenarios`: platform + install + runtime
- `onboarding_profiles`: user onboarding choices
- `test_plans`: base + onboarding + expected state + suites
- `setup_scenarios`: friendly aliases and compatibility metadata
- `onboarding_assertions`: setup/onboarding checks that run before suites

The typed scenario registry expresses the same intent as deterministic code and
is used by the scenario workflow matrix and dry-run plan artifacts. The target
Vitest fixture model should collapse these parallel expressions into one live
execution path.

## Fixture-first scenario shape

Final-state live scenarios should read like regular Vitest tests that depend on
NemoClaw fixtures:

```ts
import { test } from "../framework/e2e-test.ts";

test("ubuntu repo cloud OpenClaw", async ({
  repo,
  openclaw,
  gateway,
  sandbox,
  inference,
}) => {
  await repo.installCurrent();

  const instance = await openclaw.onboard({
    agent: "openclaw",
    provider: "nvidia",
  });

  await gateway.expectHealthy(instance);
  await sandbox.expectRunning(instance);
  await inference.expectLocalChat(instance, { prompt: "Say ok.", expect: /ok/i });
});
```

The test body should express product behavior. Fixture implementations should
hide redacted process spawning, artifact paths, cleanup registration, secret
gating, and retry/flake classification.

## How to run

The TypeScript runner is the canonical entrypoint. There is one execution
mode — live — and `--plan-only` is for local debug only (it must not appear
in any CI workflow).

```bash
# List canonical scenario ids
npx tsx test/e2e-scenario/scenarios/run.ts --list

# Emit the GitHub Actions fan-out matrix payload
npx tsx test/e2e-scenario/scenarios/run.ts --emit-matrix

# Execute one or more scenarios live
npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id[,id...]>

# Local debug only: print the compiled plan without executing
npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id> --plan-only

# Opt-in Vitest live scenario path
npm run build:cli
NEMOCLAW_RUN_E2E_SCENARIOS=1 npx vitest run --project e2e-scenarios-live --silent=false --reporter=default
```

Override the runtime context directory with `E2E_CONTEXT_DIR=<path>` (default
`.e2e/`, gitignored). Suites communicate through `$E2E_CONTEXT_DIR/context.env`;
suites should not rediscover setup state.

## Repository layout

```text
test/e2e-scenario/
  docs/                              # This guide and migration notes
  manifests/                         # Product-facing NemoClawInstance desired state
  scenarios/                         # Typed builders, registry, compiler, assertions, dry-run orchestration
  nemoclaw_scenarios/                # YAML runtime metadata and setup helpers
    scenarios.yaml
    install/
    onboard/
    fixtures/
    helpers/
  validation_suites/                 # Suite definitions and shell assertion steps
    suites.yaml
    smoke/
    inference/
    messaging/
    platform/
    security/
    sandbox/
  runtime/                           # Shared shell helper libs sourced by validation_suites
    lib/
```

## CI entry points

- `.github/workflows/e2e-scenarios.yaml` runs typed scenario dry-runs for
  manually selected scenario IDs.
- `.github/workflows/e2e-scenarios-all.yaml` fans out typed scenario dry-runs
  from the typed registry matrix.
- `.github/workflows/e2e-vitest-scenarios.yaml` runs the opt-in Vitest live
  scenario project and uploads non-hidden `e2e-artifacts/vitest/` fixture artifacts.
- Existing workflows such as `nightly-e2e.yaml`, `e2e-branch-validation.yaml`,
  `macos-e2e.yaml`, `wsl-e2e.yaml`, `ollama-proxy-e2e.yaml`, and
  `regression-e2e.yaml` still run legacy live E2E scripts during the migration.
- `vitest.config.ts` contains the `e2e-scenario-framework` project for framework
  and metadata tests. The live scenario target should be a separate opt-in
  Vitest project so ordinary `npm test` remains fast and local-friendly.

## Migration tracking

Migration status is tracked outside the repository in GitHub issues and PRs,
not in repo-local checklists. The parent architecture issue is #3588. Active
audit-coverage work is tracked by the #4347–#4357 issue set, with focused
follow-ups such as #4378 for specific drift fixes. The execution-model decision
is tracked in #4941.

The narrow repo-local exception is
`test/e2e-scenario/migration/legacy-inventory.json`, a machine-readable deletion
gate for direct legacy `test/e2e/test-*.sh` entrypoints and explicit bridge
entrypoints. It should prevent accidental deletions, not become a parallel
status table. Remove it after #4357 completes final legacy E2E reconciliation,
or keep it only as an audit artifact if maintainers still need that record.

The old workflow-level parity report has been removed. Use scenario framework
tests, the coverage report, PR review, and the audit issues to decide what to
migrate next.

When adding a suite assertion, emit or preserve a stable `PASS: <id>` /
`FAIL: <id>` log line, and record migration evidence or follow-up state in the
owning issue or PR. Sandbox lifecycle assertions should use
`validation_suites/lib/sandbox_lifecycle.sh`, consume
`$E2E_CONTEXT_DIR/context.env`, and keep destructive snapshot restore checks
isolated in the opt-in `snapshot-lifecycle` suite. Platform-specific scenarios
such as GPU, macOS, WSL, Brev, or DGX Spark must also list
`runner_requirements` in `scenarios.yaml`.

Prefer new scenario-matrix coverage over new legacy-style `test-*.sh` scripts.
