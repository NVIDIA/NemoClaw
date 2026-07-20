---
name: nemoclaw-maintainer-pr-comparator
description: Compare open PRs that address the same issue and recommend one to merge. Apply eligibility, correctness, quality, and tie-break checks. Report the score and evidence. Use when an issue has two or more open PRs.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Comparator

Compare PRs for one issue. Tier 0 determines eligibility. Tiers 1 and 2 score correctness and quality.
Tier 3 resolves ties. If no PR passes Tier 0, rank eligible PRs for salvage.

## Prerequisites

- `gh` CLI installed and authenticated
- A target repository with an issue that has two or more open PRs

## Repo policy

The defaults use NemoClaw conventions for CODEOWNERS, DCO, CodeRabbit, and `docs/`.
Edit `repo-policy.md` for another repository.

## Workflow

Copy this checklist into your response and check off each step:

```text
PR Comparison Progress:
- [ ] Step 1: Parse issue (body + comments) for acceptance criteria
- [ ] Step 2: Discover candidate PRs in the defined order
- [ ] Step 3: Detect supersession (parse PR bodies)
- [ ] Step 4: Run Tier 0 gates per PR
- [ ] Step 5: Run Tier 1 correctness checks per PR
- [ ] Step 6: Run Tier 2 quality checks per PR
- [ ] Step 7: Compute weighted scores
- [ ] Step 8: Apply Tier 3 ranking (happy path or degraded mode)
- [ ] Step 9: Emit verdict using templates/verdict.md
```

### Step 1: Parse issue

Read the issue body and all comments. Extract each acceptance criterion:

```bash
gh issue view <issue-number> --json title,body,comments
```

Comments can add requirements that are absent from the issue body.

### Step 2: Discover candidate PRs

```bash
scripts/find-candidates.sh <issue-number>
```

Applies a single default order with stop conditions.

### Step 3: Detect supersession

```bash
scripts/parse-supersession.sh <pr-number-1> <pr-number-2> ...
```

Parse these statements from each PR body: `supersedes #N`, `replaces #N`, `closes in favor of #N`, and `folds in #N`.
Use supersession as the first tiebreaker.

### Step 4: Tier 0 gates

```bash
scripts/collect-gates.sh <pr-number>
scripts/check-coderabbit-threads.sh <pr-number>
node --experimental-strip-types --no-warnings ../nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number>
```

All six gates are required.
Treat PR Review Advisor output as input for maintainer review. Do not treat it as merge authorization.
See `checks/tier-0-gates.md`.

### Step 5: Tier 1 correctness

Apply the six model checks in `checks/tier-1-correctness.md`.

### Step 6: Tier 2 quality

Apply the four model checks in `checks/tier-2-quality.md`.

### Step 7: Weighted score

- Build the Tier 0 eligibility set from these Boolean keys: `state_open`, `ci_green_sha`, `mergeable`, `contributor_compliance`, `branch_protection`, and `coderabbit_threads_resolved`.
- Stop if a candidate omits a required key, has an unknown key, or has a value that is not Boolean.
- Only PRs for which all six gates are `true` enter happy-path scoring.
- Each pass = full points
- Each yellow = half points
- Each fail = zero
- Tier 1 weight: 2.0× per check
- Tier 2 weight: 1.0× per check

### Step 8: Tier 3 ranking

Compute the mode from the Tier 0 results. Do not accept a mode from the caller.
In happy mode, set `winner` only to an eligible PR and set `closest_to_ready` to null.
Leave `winner` null when the evidence does not support a merge recommendation.
In degraded mode, set `winner` to null.
Set `closest_to_ready` only to an open PR that passes contributor requirements.
See `tiebreakers.md`.

### Step 9: Emit verdict

Use `templates/verdict.md` and render the result with `scripts/render-verdict.py`.
Stop if the renderer exits with a nonzero status. Do not recommend a merge.
The renderer validates the gate schema, mode, winner eligibility, and salvage-candidate eligibility.
The reviewer remains responsible for the score, ranking, and evidence.
For each judgment, include evidence, the inference, and the score.

## Reference files

- [repo-policy.md](repo-policy.md) — Repository settings.
- [checks/tier-0-gates.md](checks/tier-0-gates.md) — Six eligibility gates.
- [checks/tier-1-correctness.md](checks/tier-1-correctness.md) — Six correctness checks.
- [checks/tier-2-quality.md](checks/tier-2-quality.md) — Four quality checks.
- [tiebreakers.md](tiebreakers.md) — Tier 3 ranking and degraded mode.
- [templates/verdict.md](templates/verdict.md) — Output template.
- [validation/backtest.md](validation/backtest.md) — Historical test cases for the skill.

## Scripts (execute, do not read)

- `scripts/find-candidates.sh` — PR discovery
- `scripts/collect-gates.sh` — Tier 0 gate evaluation
- `scripts/check-coderabbit-threads.sh` — GraphQL thread-resolution check
- `scripts/parse-supersession.sh` — body parsing for supersession refs
- `scripts/render-verdict.py` — verdict scorecard renderer

## Limits

Run `nemoclaw-maintainer-cross-issue-sweep` separately when you need related-issue evidence.

This skill does not:

- run PR code against adversarial inputs
- scan other issues for related behavior
- simulate reverts against related PRs
- run static analyzers such as CodeQL or Semgrep
