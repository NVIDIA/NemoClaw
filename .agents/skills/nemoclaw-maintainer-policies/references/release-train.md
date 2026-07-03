<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Release Train

Daily release labels coordinate release work. They do not classify issues and they do not promise readiness.

## Rules

- PRs own the release-inclusion meaning of daily version labels.
- Engineers and agents may add the current `v0.0.x` label to open PRs to activate them for day work.
- Issues may also carry daily version labels when they need a PR, fix, or regression follow-up for the daily tag.
- Applying a daily version label is not a readiness claim.
- Release includes PRs that both carry the daily version label and are merged by cutoff.
- Issue version labels are tracking signals only; an issue label does not include work in the release without a merged labeled PR.
- Open PRs and issues that miss a tagged release carry forward automatically by moving from the released version label to the next patch label.
- A PR or issue leaves the daily release cycle only when its version label is removed without a replacement.
- Version labels are pruned after seven days only after durable release history is preserved and no open PR still carries or depends on the old label.

## Release-Prep Docs

Run `/nemoclaw-contributor-update-docs for vX.Y.Z` before generating the final release plan for `vX.Y.Z`.
Release-prep docs must be merged or explicitly waived before `release:plan` captures the release commit.
If any merge lands after `release:plan`, generate a fresh plan before cutting the tag.

## Cutoff

The daily cutoff is the maintainer-defined point where the release tag is prepared.

At cutoff:

1. List merged PRs carrying the target version label.
2. Confirm each is intended for the release.
3. List open PRs and issues still carrying the target label as post-tag stragglers.
4. Generate QA handoff from merged PRs.
5. Generate the release plan to freeze the exact candidate commit.
6. Review the candidate commit's pre-tag E2E evidence.
7. Cut the release tag only with explicit maintainer confirmation.
8. After the tag and workflow-managed `latest` are verified, automatically move every open straggler to the next patch label.

## Pre-Tag E2E Evidence

The release candidate is the exact full `origin/main` commit SHA captured by the generated release plan. At that commit, `.github/workflows/e2e.yaml` is the sole source of truth for the release E2E test set. Do not maintain a separate release-gating test list.

Before asking for the exact release confirmation phrase, build and show an evidence ledger for that SHA:

- Every E2E test execution declared by the workflow must have at least one completed, successful execution for the candidate SHA. This includes tests that require explicit selection and every expanded matrix execution.
- Treat each expanded matrix execution as a separate ledger entry. Use its matrix `id`, or all distinguishing matrix dimensions when no single ID exists, in the test identifier so results for distinct expansions are never collapsed under the parent job.
- Green evidence may accumulate across multiple workflow runs, selective runs, reruns, and attempts. A later failure does not erase an earlier successful execution for the same test and SHA.
- Skipped, unexecuted, queued, in-progress, cancelled, and failing results are not green evidence.
- Map each test with green evidence to its successful run or job URL and attempt number.
- If a test has no successful execution, the tag may still proceed at maintainer discretion only with an itemized maintainer exception that records the test identifier, relevant run links or available evidence, the current result or failure summary, and the rationale for proceeding.

Every test must have either green evidence or an itemized maintainer exception before the release confirmation is requested. If the candidate SHA changes, discard the ledger and its exceptions, regenerate the release plan, and repeat the review for the new SHA.

## Carry Forward

Open PRs and issues that miss the cutoff remain active carry-forward work, but their target changes after the release succeeds. Post-tag housekeeping creates the next patch label if needed, removes the released-version label from every open straggler, and adds the next patch label.

Run the automatic bump only after both the semver tag and workflow-managed `latest` resolve to the confirmed release commit. The release confirmation must include the housekeeping plan, so the post-tag label writes remain inside the authorized release operation.

Maintainers may:

- Add the current version label when they want the PR visible in the current day queue.
- Remove a version label without replacement when an item is deferred, superseded, closed, or no longer part of the daily cycle.
- Rerun post-tag housekeeping after a partial failure; already-moved items no longer match the released source label, so the operation is safely resumable.

## Pruning

Old version labels may be deleted only when all conditions are true:

1. The label is older than seven days.
2. Durable release history has been preserved in tags, release notes, Agent Feed artifacts, or equivalent reports.
3. No open PR or issue still carries or depends on the old label after post-tag housekeeping.
4. The current authorization context explicitly allows label pruning.

Pruning is a cleanup operation, not part of ordinary daily triage.
