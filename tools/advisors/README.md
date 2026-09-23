<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Advisor shared utilities

Shared implementation helpers for NemoClaw model-backed advisors.

`tools/pr-review-advisor/` owns the PR Review Advisor specialist entrypoint. This directory provides:

- repository-confined, read-only Pi SDK session tools;
- deterministic turn-scoped context tools and turn validation;
- Git diff and metadata helpers;
- JSON extraction and sanitization helpers;
- artifact and file I/O helpers;
- GitHub API and sticky-comment helpers;
- the trusted E2E inventory supplied to PR Review Advisor specialists as review context.

The inventory helps specialists recommend focused E2E coverage; it does not dispatch jobs or decide
merge readiness. When a maintainer requires live E2E for a pull request, they run it explicitly through
the [current E2E workflow](../../.github/workflows/e2e.yaml) and follow the
[maintainer E2E procedure](../../.agents/skills/nemoclaw-maintainer-day/MERGE-GATE.md). Former PR E2E
check contexts remain advisory. The inventory reader uses only Node.js built-ins and checked-in
TypeScript modules, so the production advisor does not need repository development dependencies such
as TypeScript or Vitest.

GitHub workflows must execute the advisor entrypoint from the trusted `ADVISOR_DIR` checkout. PR
workspaces remain inert analysis data only.

The deterministic focused mapping recommends `staging-brev-launchable` for these behavior owners:

- Gateway discovery and ownership, shared forward recovery or startup, and connect/probe entrypoints
  listed in `BREV_LAUNCHABLE_FILES` in `risk-plan.mts`.
- Runtime files in the `src/lib/onboard/gateway-binding/` and
  `src/lib/actions/sandbox/launch-readiness/` modules, including new nested helpers.
- The `full-e2e` scenario and companion source files under `test/e2e/live/` and `test/e2e/fixtures/`,
  including new helpers in `full-e2e/` directories.

Module matching excludes source-unit tests and documentation. Scenario matching includes live tests
and source helpers, but excludes documentation and support-unit tests. Similarly named sibling modules
and Hermes-only neighboring implementations do not trigger this mapping. Existing lifecycle
recommendations remain selected, and specialist output cannot remove Brev from the deterministic plan.

This recommendation needs the full runtime scenario; `staging-brev-launchable-identity` only proves
image identity. An authorized maintainer selects `jobs=staging-brev-launchable` with empty `targets`
through the trusted workflow on `main`. Do not combine that selector with other job IDs. Follow the
[maintainer E2E procedure](../../.agents/skills/nemoclaw-maintainer-e2e/SKILL.md) for candidate eligibility,
credentials, deployment, and cleanup. The recommendation does not dispatch a run or authorize deployment.
