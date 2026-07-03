<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tier 0 — Plumbing Gates

Mandatory prerequisites. Any gate failure means the PR cannot be merged in its current state. Six gates total. Run `scripts/collect-gates.sh <pr>` to evaluate gates 1-5 mechanically; run `scripts/check-coderabbit-threads.sh <pr>` for gate 6.

## Contents

- Gate 1: PR state OPEN
- Gate 2: CI green on latest head SHA
- Gate 3: Mergeable, no conflicts
- Gate 4: Contributor compliance satisfied
- Gate 5: Independent human approval satisfied
- Gate 6: Automated reviewer threads resolved

## Gate 1: PR state OPEN

The PR's `state` must be `OPEN`. A `CLOSED` or `MERGED` PR is not a valid merge candidate regardless of its other properties.

**Why this is a hard kill:** A closed PR cannot merge no matter how high it scores. Even degraded mode skips closed PRs entirely.

**Failure mode this catches:** When two PRs are byte-identical and the older one was closed before review completed, first-mover would otherwise pick the closed one. This gate prevents that.

## Gate 2: CI green on latest head SHA

The CI rollup must show all required checks passing on the **latest** head SHA, not on a stale ancestor.

**Why "latest" matters:** If the author force-pushed after CI ran, the green checks are on the old commit. The new commit may have introduced regressions that haven't been re-checked.

**How to evaluate:** `scripts/collect-gates.sh` returns the head SHA and a per-check status. Cross-reference each required check against `repo-policy.md`'s required-checks list.

## Gate 3: Mergeable, no conflicts

`mergeable: MERGEABLE` and `mergeStateStatus: CLEAN`. The PR must merge cleanly into its base branch.

**Common failure modes:**

- `CONFLICTING` — base branch has diverged
- `DIRTY` — staged changes block merge
- `BLOCKED` — required checks failing or reviews missing

## Gate 4: Contributor compliance satisfied

The PR body must include a valid contributor `Signed-off-by:` declaration, and every commit in the PR must appear as `Verified` in GitHub. Check both conditions directly; a passing CI job is not a substitute for commit verification.

**Why this is a hard kill:** contributor compliance is a self-serve eligibility requirement. Maintainers reject noncompliant PRs and do not amend, sign, force-push, approve, or merge them on the contributor's behalf.

## Gate 5: Independent human approval satisfied

The `independent-human-approval` check must pass for the latest reviewable push and come from the
dedicated GitHub App or service source pinned in the repository ruleset. The repository-side Actions
adapter is interim defense in depth and is not the final source-isolated gate. The qualifying
reviewer must be an eligible human reviewer who is absent from the append-only PR contributor set.
The PR opener, commit authors, recognized co-authors, human committers, pushers, and direct code
appliers remain ineligible even when GitHub reports `reviewDecision: APPROVED`.

**Why this is separate:** CODEOWNERS and ordinary required-review counts establish ownership and
review quantity, not independence. Earlier reviews remain recorded; only one new qualifying
approval is needed after the latest reviewable push.

## Gate 6: Automated reviewer threads resolved

All threads created by automated reviewers (e.g., CodeRabbit) must be in `resolved: true` state. **Zero unresolved threads is the bar.**

**Why GraphQL, not REST:** GitHub's REST `/comments` endpoint exposes individual review comments without thread-resolution state. To check whether a thread is resolved, query `pullRequest.reviewThreads.isResolved` via GraphQL. This is what `scripts/check-coderabbit-threads.sh` does.

**Configurable:** Add bot logins to `repo-policy.md` under `auto_reviewers`. Defaults to `coderabbitai` (CodeRabbit's bot login).

## Output

For each gate, the skill records:

- Pass/fail
- Evidence (head SHA, check names, mergeable state, thread IDs)
- Whether the failure is **ineligible** (missing PR-body DCO or any unverified commit), **trivial** (for example, a missing issue link), or **substantive** (CI red, conflicts, or missing approvals)

The ineligible/trivial/substantive classification feeds degraded mode (see `tiebreakers.md`). Ineligible PRs are rejected rather than ranked for salvage.
