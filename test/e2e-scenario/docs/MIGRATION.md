<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E scenario migration notes

This file records the current migration model for contributors. It is not the
source of truth for per-domain status. Mutable migration state is tracked
outside the repository in GitHub issues and pull requests so reviewers can
discuss, update, and close work in one place.

## Current migration state

The scenario E2E migration is in a hybrid phase:

- typed scenario builders drive scenario workflow fan-out and dry-run plans;
- product-facing `NemoClawInstance` manifests describe desired setup and
  onboarding state;
- YAML metadata still drives the shell scenario runner and live suite
  resolution;
- legacy `test/e2e/test-*.sh` scripts still provide most live nightly and
  platform coverage.

This hybrid shape is not the target end state. #3588 and #4941 should converge
on one live execution path: **Vitest as the scenario runner, extended by
NemoClaw fixtures and typed domain helpers**. Until that path owns live
execution, resolver behavior, assertions, evidence, cleanup, and redaction,
treat YAML and bash runner updates as bridge work rather than durable
architecture.

Do not assume legacy scripts are deletion-ready just because a scenario or suite
name exists. The final reconciliation phase must show either evidence-complete
coverage or an explicit audit amendment before legacy executable tests are
removed.

## Target architecture

The final scenario framework should have one execution path:

- Vitest owns live execution, filtering, reporters, timeouts, fixture lifecycle,
  skip handling, and CI integration;
- NemoClaw fixtures own setup, onboarding, runtime actions, expected-state
  probes, assertion helpers, expected-failure matching, evidence artifacts,
  cleanup, and secret redaction;
- typed scenario definitions and matrix helpers describe stable scenario IDs and
  supported combinations without becoming a second execution framework;
- reusable assertions prefer TypeScript probes and typed clients;
- shell scripts remain only for host, sandbox, process, or platform boundaries
  where shell is the thing being tested or the lowest-risk adapter;
- shell execution is wrapped by fixtures so environment scoping, timeout,
  redaction, artifact capture, and argument validation are consistent.

When a bridge PR adds behavior to the current YAML/bash runner, preserve the
requirement it proves, but port that requirement into the Vitest fixture path
before removing legacy runner pieces. Do not deepen the bash runner as a second
long-term source of truth.

## Active issue tracking

Use these GitHub issues for status and follow-up work:

| Issue | Purpose |
| --- | --- |
| #3588 | Parent architecture epic for layered single-runner scenario E2E |
| #4941 | Decision issue for using Vitest fixtures as the scenario execution model |
| #4347–#4356 | Domain-specific audit-coverage phases |
| #4357 | Final audit reconciliation, placeholder cleanup, and deletion-readiness review |
| #4378 | Friendly `setup_scenarios` aliases for layered test plans |

If a migration discovery needs durable tracking, add it to the relevant issue or
open a focused child issue. Avoid adding long-lived checklists here.

## What belongs in the repo

Keep durable framework guidance here:

- how to run the scenario runner,
- where scenario metadata, typed builders, manifests, and suites live,
- how to add or review a scenario, expected state, assertion, or suite,
- stable conventions that should not change with every migration batch.

Do not add migration status tables, per-legacy-script checklists, temporary
coverage counts, or owner queues to this file. Put those in the issue or PR
that owns the work instead.

The one repo-local exception is the machine-readable deletion gate inventory at
`test/e2e-scenario/migration/legacy-inventory.json`. Keep that file focused on
deletion-readiness evidence that prevents accidental legacy E2E deletion. It
must cover every direct legacy shell entrypoint under `test/e2e/test-*.sh`,
plus any explicitly retained bridge entrypoints such as Brev. It also tracks
coarse internal legacy runner surfaces such as the YAML/bash scenario workers,
validation suites, TypeScript shell-runner orchestrators, and runtime helper
libraries so those surfaces cannot be removed without #4357 evidence. It is not
a progress dashboard or owner queue:

- `not-migrated`: legacy coverage still has no equivalent Vitest scenario.
- `bridge-probe`: coverage is temporarily represented by a bridge path.
- `covered`: equivalent Vitest live scenario coverage exists.
- `retired`: maintainers agreed the legacy coverage is no longer required.

Do not set `deletionReady: true` on a script entry or internal surface unless
the record is `covered` or `retired` and the deletion approval is recorded
through #4357.

After #4357 completes final legacy E2E reconciliation, remove the inventory if
there are no remaining legacy entrypoints to guard. If maintainers keep it, keep
it as an audit artifact rather than as a living migration checklist.

## What to migrate next

When moving behavior from a legacy E2E script into the scenario framework:

1. Identify the relevant audit issue (#4347–#4356).
2. Add or update the product-facing manifest only when the desired setup or
   onboarding state changes.
3. Add typed scenario registry coverage when the workflow matrix needs a new
   canonical scenario ID.
4. Add or update current YAML metadata only when the existing bridge runner must
   keep resolving the scenario during the migration.
5. Add the reusable assertion or probe in the Vitest fixture direction whenever
   possible instead of adding new bash-runner-only behavior.
6. Add reusable suite or assertion helpers instead of copying entire legacy
   scripts.
7. Add framework tests that prevent the typed registry, YAML aliases, workflow
   routes, manifests, suites, and runner behavior from drifting.
8. Leave legacy executable scripts in place until deletion readiness is
   recorded in the owning issue or PR. The bash scenario entrypoints
   (`runtime/run-scenario.sh`, `runtime/run-suites.sh`) and the YAML resolver
   tree are already gone — the TypeScript runner is the sole canonical
   executor.

## Useful commands

```bash
# Typed registry inventory and execution
npx tsx test/e2e-scenario/scenarios/run.ts --list
npx tsx test/e2e-scenario/scenarios/run.ts --emit-matrix
npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id[,id...]>

# Local debug only: print the compiled plan without executing
npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id> --plan-only

# Framework tests
npx vitest run --project e2e-scenario-framework --silent=false --reporter=default

# Opt-in live Vitest scenarios
npm run build:cli
NEMOCLAW_RUN_E2E_SCENARIOS=1 npx vitest run --project e2e-scenarios-live --silent=false --reporter=default
```

## Cleanup rules

- Prefer new scenario-matrix coverage over new legacy-style `test-*.sh` scripts.
- Prefer Vitest fixture behavior over new YAML/bash-runner behavior; if a bridge
  change is unavoidable, document the porting requirement in the owning issue or
  PR.
- Do not reintroduce the removed workflow-level parity report unless maintainers
  explicitly reopen that direction.
- Do not delete legacy executable E2Es as part of ordinary domain migration PRs;
  queue deletion candidates for #4357.
- Keep docs focused on how the framework works now. Put changing progress status
  in issues and PRs.
