<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding suites

Suites that validate the onboarding lifecycle. Onboarding is the #1 UAT/NV QA
bug hotspot (62 traced fix PRs; `src/lib/onboard.ts` touched by 53 PRs), so
this bucket is deliberately the widest.

## Current

| Suite | Scenario | Covers |
|---|---|---|
| `hermes/` | `ubuntu-repo-cloud-hermes` | Hermes agent onboarding health check. |

## Planned (from UAT/NV QA hotspot analysis)

| Suite | Originating bug class | Migrating from |
|---|---|---|
| `smoke/` | Happy-path onboarding baseline | today's `test-full-e2e.sh` |
| `resume/` | Interrupted onboard → `--resume` completes (regression #446) | `test-onboard-resume.sh` (currently unwired) |
| `repair/` | Resume-repair + invalidation of missing sandboxes (regression #446) | `test-onboard-repair.sh` (currently unwired) |
| `double-onboard/` | Gateway reuse, stale-registry reconciliation, rebuild guidance (UAT #2174) | `test-double-onboard.sh` (currently unwired) |
| `provider-reconfig/` | Re-entering onboard with bad credentials (UAT #1568, #1912, #1960) | **NEW** |
| `gateway-restart-mid-onboard/` | Gateway healthy but provider setup fails (UAT #2020) | **NEW** |
| `skip-permissions/` | `--dangerously-skip-permissions` activates permissive policy (not Pending) | `test-skip-permissions-policy.sh` |

Coverage gap explicitly called out by the hotspot analysis: the 7 scripts
prefixed with `test-onboard-` / `test-double-onboard` are written but **not
wired to any workflow today** (§1, E2E categorization). Rewiring them into
this directory is one of the highest-leverage moves in the migration.
