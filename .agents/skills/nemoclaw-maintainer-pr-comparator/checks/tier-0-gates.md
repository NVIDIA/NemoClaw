<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tier 0 — Eligibility Gates

All six gates are required. A PR that fails a gate cannot merge.
Run `scripts/collect-gates.sh <pr>` for gates 1 through 5.
Run `scripts/check-coderabbit-threads.sh <pr>` for gate 6.

## Contents

- Gate 1: PR state OPEN
- Gate 2: CI passes on the PR SHA
- Gate 3: Mergeable, no conflicts
- Gate 4: Contributor compliance satisfied
- Gate 5: Branch protection satisfied
- Gate 6: Automated reviewer threads resolved

## Gate 1: PR state OPEN

The PR's `state` must be `OPEN`. A `CLOSED` or `MERGED` PR is not a valid merge candidate regardless of its other properties.

A closed PR cannot merge. Without this gate, ranking could select a closed PR whose diff matches an open PR.

## Gate 2: CI passes on the PR SHA

All required checks must pass on the PR SHA.
If the author pushes another commit, record its short SHA and wait for its checks.
`scripts/collect-gates.sh` returns the SHA and each check status.
Compare the results with the required checks in `repo-policy.md`.

## Gate 3: Mergeable, no conflicts

`mergeable: MERGEABLE` and `mergeStateStatus: CLEAN`. The PR must merge cleanly into its base branch.

**Common failure modes:**

- `CONFLICTING` — base branch has diverged
- `DIRTY` — staged changes block merge
- `BLOCKED` — required checks failing or reviews missing

## Gate 4: Contributor compliance satisfied

The PR body must contain the contributor's `Signed-off-by:` declaration.
GitHub must show every commit as `Verified`. A passing CI job does not replace either check.
The contributor must correct a failure.
Maintainers must not amend, sign, force-push, approve, or merge the PR for the contributor.

## Gate 5: Branch protection satisfied

Require `reviewDecision: APPROVED` and all branch-protection checks.
Use branch protection to enforce CODEOWNERS.
Gate 4 still checks DCO and commit verification.
If branch protection does not enforce CODEOWNERS, set `codeowners_enforced_via_branch_protection: false` and configure team checks.

## Gate 6: Automated reviewer threads resolved

Each automated-review thread must have `resolved: true`.
REST comments do not include thread-resolution state.
Query `pullRequest.reviewThreads.isResolved` through GraphQL.
`scripts/check-coderabbit-threads.sh` runs this query.

Add bot logins under `auto_reviewers` in `repo-policy.md`. The default is `coderabbitai`.

## Output

For each gate, the skill records:

- Pass/fail
- Evidence (short SHA, check names, merge state, and thread IDs)
- Whether the failure is **ineligible** (missing PR-body DCO or any unverified commit), **trivial** (for example, a missing issue link), or **substantive** (CI red, conflicts, or missing approvals)

The ineligible/trivial/substantive classification feeds degraded mode (see `tiebreakers.md`). Ineligible PRs are rejected rather than ranked for salvage.
