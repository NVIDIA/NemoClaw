<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Review Priorities

Ordered list of what NemoClaw maintainers look for in a pull request. Higher items block approval; lower items inform queue ranking.

## Hard gates (all must pass to approve)

1. **Contributor compliance** — the PR body has the contributor's DCO declaration and every commit appears as `Verified` in GitHub. Maintainers reject noncompliant PRs and do not repair contributor history.
2. **Security correctness** — no sandbox escape, SSRF, credential exposure, policy bypass, or installer trust violation. PRs touching risky areas (see [RISKY-AREAS.md](RISKY-AREAS.md)) get a deep security pass before anything else.
3. **CI green** — all required checks in `statusCheckRollup` must pass.
4. **No merge conflicts** — `mergeStateStatus` must be clean.
5. **No unresolved major/critical CodeRabbit findings** — correctness and safety findings block; style nits do not. Use judgment on borderline cases.
6. **No unresolved actionable PR Review Advisor findings** — correctness, security, acceptance-coverage, and test-depth findings block unless explicitly judged false-positive. Ask the user before acting on ambiguous or design-changing advice.
7. **Tests for touched risky code** — risky areas must have test coverage, either added in the PR or pre-existing. No exceptions.

## Quality expectations (block if violated, but fixable via salvage)

1. **Narrow scope** — each PR has one clear objective. Unrelated config changes, drive-by refactors, and tool setting diffs get reverted to `main`.
2. **Contributor intent preserved** — the fix must match what the contributor intended. Stop and ask when the diff would change semantics or when intent is unclear.
3. **Small, mergeable changes** — prefer substrate-first slicing: extract helper, add tests for current behavior, land fix on top. One file cluster per pass. If the next step is a large redesign, route to sequencing.

## Queue ranking signals (inform priority, not approval)

1. **Actionability** — PRs closest to done rank highest. A merge-ready PR outranks a near-miss; a near-miss outranks a blocked item.
2. **Security-sensitive and actionable** — PRs touching risky code get a priority bump, but only when they are not otherwise blocked.
3. **Staleness** — PRs idle for more than 7 days get a mild bump to prevent rot.
4. **Hotspot relief** — PRs that reduce future conflict pressure in high-churn files are preferred over equivalent work elsewhere.

## Daily cadence

The team follows a daily ship cycle. All maintainer skills operate within this rhythm.

1. **Morning** (`/nemoclaw-maintainer-morning`) — triage the backlog, pick items for the day, label them with the target version (e.g., `v0.0.8`).
2. **During the day** (`/nemoclaw-maintainer-day`) — land PRs using the maintainer loop. Version labels make progress visible on dashboards.
3. **Evening** (`/nemoclaw-maintainer-evening`) — check what shipped, identify open stragglers, generate a QA-focused summary, cut the tag, automatically bump stragglers to the next patch, and prepare release notes for posting.
4. **Overnight** — QA team (different timezone) tests the tag. Any issues they file enter the next morning's triage like any other issue.

Version labels activate release work; they are not readiness claims. If an open item misses the tag, its label moves to the next patch during post-tag housekeeping.

## Explicitly not priorities

- **Code style and formatting** — not a reason to block or delay. No opportunistic reformatting.
- **Documentation completeness** — not required for approval unless the PR changes user-facing behavior.
- **Architectural elegance** — the goal is lower future merge pain, not aesthetic cleanup.
