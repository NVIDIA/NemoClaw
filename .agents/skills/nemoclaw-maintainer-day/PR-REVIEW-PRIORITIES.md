<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Review Priorities

Use this order when you review a PR. Hard gates block approval. Queue signals set review order.

## Hard gates (all must pass to approve)

1. **Product scope approved** — The PR implements supported behavior or a linked product decision.
   Working code and passing checks do not approve a new product surface.
   Do not approve when ownership and lifecycle are not defined.
   Route independent solutions through [Community Solutions](../../../docs/resources/community-contributions.mdx).
2. **Contributor compliance** — The PR body has the contributor's DCO declaration.
   GitHub shows every commit as `Verified`. Maintainers reject a noncompliant PR and do not repair its history.
3. **Security correctness** — No sandbox escape, SSRF, credential exposure, policy bypass, or installer trust violation exists.
   Run the nine-category security review first when a PR touches a [risky area](RISKY-AREAS.md).
4. **CI green** — all required checks in `statusCheckRollup` must pass.
5. **No merge conflicts** — `mergeStateStatus` must be clean.
6. **No unresolved major or critical CodeRabbit findings** — Correctness and safety findings block the PR. Style comments do not. Assess borderline cases.
7. **Tests for touched risky code** — risky areas must have test coverage, either added in the PR or pre-existing. No exceptions.

## Manual review inputs

The PR Review Advisor provides review input. It does not authorize a merge.
Read its comment and verify each claim against code, tests, and workflow evidence.
Apply a confirmed problem to the related gate. Ask the user about ambiguous or design-changing advice.
Advisor labels, absence, and comment source do not affect `check-gates.ts` or `allPass`.

Apply [NemoClaw Technical English](../../../CONTRIBUTING.md#nemoclaw-technical-english) to changed comments, test titles, PR discussion, changelog entries, and Announcements.
During the changed-text pilot, a language finding blocks only when ambiguity can change behavior, security, data safety, test meaning, or release meaning.
Treat other findings as suggestions and include a proposed rewrite.

## Quality expectations (block if violated, but fixable via salvage)

1. **Narrow scope** — Each PR has one objective.
   Restore configuration, refactor, and tool-setting changes that do not support the objective.
2. **Contributor intent preserved** — the fix must match what the contributor intended. Stop and ask when the diff would change semantics or when intent is unclear.
3. **Small changes** — Extract a helper, test the existing behavior, and then apply the fix.
   Process one file cluster in each pass. Use sequencing when the next step requires a redesign.

## Queue ranking signals (inform priority, not approval)

1. **Actionability** — Rank an approval-ready PR before one that needs a fix. Rank a PR that needs a fix before a blocked PR.
2. **Security** — Rank an actionable PR that touches risky code before an equivalent PR.
3. **Wait time** — Rank a PR that has waited more than seven days before an equivalent newer PR.
4. **Merge conflicts** — Prefer a PR that reduces conflicts in files that change often.

## Daily cadence

The team follows a daily ship cycle. All maintainer skills operate within this rhythm.

1. **Morning** (`/nemoclaw-maintainer-morning`) — triage the backlog, pick items for the day, label them with the target version (e.g., `v0.0.8`).
2. **During the day** (`/nemoclaw-maintainer-day`) — land PRs using the maintainer loop. Version labels make progress visible on dashboards.
3. **Evening** (`/nemoclaw-maintainer-evening`) — Check shipped work and the pre-tag changelog PR.
   Confirm that the pre-tag changelog PR contains `docs/changelog/YYYY-MM-DD.mdx` for the release.
   Identify open items and prepare the QA summary. Record the release SHA and required E2E evidence.
   Cut the tag after confirmation. Move open items to the next patch label and delete the released label.
   Prepare the Announcement.
4. **Overnight** — A QA team in another time zone validates the tag.
   Put new issues into the next morning's triage.

Version labels activate release work. They do not show readiness.
If an open item misses the tag, move its label to the next patch after the release.
Delete the released label when no open item has it. Do not rename or reuse it.

## Not priorities

- **Code style and formatting** — Do not block or delay a PR for style. Do not change unrelated formatting.
- **Unrelated language cleanup** — Do not expand the PR beyond changed text during the technical-English pilot.
- **Documentation completeness** — not required for approval unless the PR changes user-facing behavior.
- **Architecture style** — Reduce future merge conflicts. Do not add style-only refactors.

Product scope approval is distinct from architectural elegance and remains a hard gate.
