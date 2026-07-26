<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tier 3 — Ranking and Degraded Mode

Use happy mode when one or more PRs pass Tier 0. Use degraded mode when none pass.

## Contents

- Happy mode: weighted score + tiebreakers
- Degraded mode: distance-to-ready
- Behavior-coverage matrix

## Happy mode (≥1 PR passes Tier 0)

Eliminate any PR failing Tier 0. Among survivors:

- Set `winner` only to a survivor and leave `closest_to_ready` null.

1. Compute weighted score across Tiers 1-2.
2. Build the **behavior-coverage matrix**. Use it as evidence for the weighted score and tiebreakers.
3. Apply tiebreakers in order.
   Set the winner when the evidence distinguishes a PR.
   Otherwise, leave `winner` null.

### Tiebreakers (in order)

1. **Supersession.** Prefer a PR whose body states that it supersedes another candidate. See `scripts/parse-supersession.sh`.
2. **Smaller diff.** Prefer the smaller diff when both PRs cover the issue scope.
3. **Better edge-case test coverage.** Compare Tier 1.3 (negative test coverage) outputs.
4. **Most recent activity.** Prefer the PR with the most recent commit.
5. **Lower PR number.** Use the lower PR number if the PRs remain tied.

## Degraded mode (no PR passes Tier 0)

When no PR passes Tier 0, rank eligible PRs by the work needed before merge.

1. Classify each Tier 0 failure per PR:
   - **Trivial** (author-fixable without changing commit compliance): missing issue link, stale base, force-pushed since last review
   - **Ineligible**: The PR body has no DCO declaration, or GitHub does not show each commit as `Verified`. Reject the PR. The contributor must provide a compliant history.
   - **Substantive** (real work): CI red, mergeability conflicts, missing CODEOWNERS approvals, unresolved CodeRabbit threads
2. Distance-to-ready ranking:
   - Rank each ineligible PR below every eligible PR. If all candidates are ineligible, return a rejection-only verdict.
   - Among eligible PRs, fewer substantive failures wins
   - Tie → fewer trivial failures wins
   - If still tied, use the higher Tier 1 and Tier 2 weighted score.
   - If the available evidence cannot support this ordering, leave `closest_to_ready` null.
3. Output:
   - Leave `winner` null. Use it only for an eligible merge recommendation.
   - Set `closest_to_ready` only to an open PR that passes contributor compliance. Leave it null for a rejection-only verdict.
   - Per-PR Tier 0 failure list
   - Tier 1 and Tier 2 scorecard for each PR
   - Verdict: "Neither mergeable yet. PR A is closer — fix [substantive list]. PR B has [issues]."
   - Put salvage steps for each eligible PR in that PR's evidence map so the renderer includes them in the reasoning evidence.

## Behavior-coverage matrix

For each acceptance criterion (from issue body + comments), build a row showing which PRs cover it:

```text
| Criterion                    | PR #A      | PR #B      |
|------------------------------|------------|------------|
| Empty input rejected         | covered    | covered    |
| Boundary value handled       | covered    | missing    |
| Preserve Y (commenter)        | missing    | covered    |
| Error message preserved      | covered    | partial    |
```

Use the matrix to find tests or changes that the selected PR does not include.
The verdict can recommend a small transfer from another PR.

Per-criterion winner cells: `covered` (full), `partial` (yellow), `missing` (red).
