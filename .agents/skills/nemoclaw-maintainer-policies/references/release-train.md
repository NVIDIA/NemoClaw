<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Release Train

Daily release labels coordinate release work. They do not classify issues and they do not promise readiness.

## Rules

- PRs own the release-inclusion meaning of daily version labels.
- Engineers and agents may add the current `v0.0.x` label to open PRs to activate them for day work.
- After a PR merges to `main`, the trusted post-merge workflow adds the next patch label only when the merge is ahead of the latest release tag. A merge already contained in a release tag receives no release label.
- A scheduled and manually dispatchable reconciliation pass repairs missed or failed merge events only across the untagged interval from the latest release tag to `main`.
- Post-merge assignment and tag-triggered label retirement share one queued GitHub Actions concurrency group. Authorized automation cannot add a released label during the retirement verification-and-delete window.
- Issues may also carry daily version labels when they need a PR, fix, or regression follow-up for the daily tag.
- Applying a daily version label is not a readiness claim.
- Release includes PRs that both carry the daily version label and are merged by cutoff.
- Issue version labels are tracking signals. An issue label does not include work in the release without a merged, labeled PR.
- Open PRs and issues that miss a tagged release carry forward automatically by moving from the released version label to the next patch label.
- After the semver tag and workflow-managed `latest` are verified, post-tag housekeeping moves open stragglers and deletes the released version label. Tags and commit ancestry are the only durable release-membership record.
- Released version labels must be deleted, never renamed or reused for a later release.

## Release-Prep Docs

Run `/nemoclaw-contributor-update-docs for vX.Y.Z` before generating the final release plan for `vX.Y.Z`.
The pre-tag release-note docs PR must create or update `docs/changelog/YYYY-MM-DD.mdx`.
Use the required `## vX.Y.Z` heading, parser-safe MDX SPDX comment, summary, and detailed bullets.
This dated file is the release history for all documentation variants. Ordinary documentation pages and the post-tag Announcement do not replace it.
Release-prep docs, including that entry, must be merged or explicitly waived before `release:plan` captures the release commit.
If any merge lands after `release:plan`, generate a fresh plan before cutting the tag.

## Cutoff

The daily cutoff is the maintainer-defined point where the release tag is prepared.

At cutoff:

1. List merged PRs carrying the target version label.
2. Confirm each is intended for the release.
3. List open PRs and issues still carrying the target label as post-tag stragglers.
4. Confirm the merged release-note docs PR contains the dated changelog entry for the target version, or record an explicit waiver that names the missing entry.
5. Generate QA handoff from merged PRs.
6. Generate the release plan to capture the candidate commit. Merges may continue; a late drift check advances the candidate and invalidates evidence for the older SHA.
7. Review the candidate commit's pre-tag E2E evidence.
8. Cut the release tag only with explicit maintainer confirmation.
9. After the tag and workflow-managed `latest` are verified, automatically move every open straggler to the next patch label, verify none remain, and delete the released version label.

## Pre-Tag E2E Evidence

The release candidate is the full `origin/main` commit SHA captured by the generated release plan. At that commit, `.github/workflows/e2e.yaml` is the sole source of truth for the release E2E test set. Do not maintain a separate release-gating test list.

Before asking for the release confirmation phrase, build and show an evidence ledger for that SHA:

- Preflight the candidate workflow and existing candidate evidence before dispatching new work.
- Derive the denominator from the candidate workflow. Do not copy it into a second release test list.
- Require every declared `RELEASE_E2E_ACTIVATION_PATH` to exist at the candidate SHA. A missing path is a preflight failure.
- Require the workflow-produced trusted dispatch receipt to bind the accepted run candidate SHA, run ID, attempt, and selector inputs.
- Run `nemoclaw-maintainer-e2e` in full mode when the ledger lacks complete evidence for the candidate SHA.
- Require one completed, successful full workflow run for all default-selected workflow E2E jobs and the full-mode additions, including `Exact staging Brev Launchable`.
- Require the trusted dispatch receipt to record `allowJetsonRunnerQueue: false` and `allowDgxSparkRunnerQueue: false`.
- Exclude `jetson-nvmap-gpu`, `llama-cpp-dgx-spark-plan`, and `llama-cpp-dgx-spark-qualification` from the required denominator.
- Require the trusted dispatch receipt to bind the workflow run and an attempt no later than the run's latest attempt. The receipt must record empty selectors and `include_staging_brev_launchable=true`.
- Require the Launchable E2E receipt to identify the candidate SHA in the repository and provision records.
- Require the cleanup receipt to identify the qualified workspace and report `ABSENT`.
- Every E2E execution selected by the accepted dispatch must have at least one completed, successful execution for the candidate SHA.
- Treat each expanded matrix execution as a separate ledger entry. Use its matrix `id`, or all distinguishing matrix dimensions when no single ID exists, in the test identifier so results for distinct expansions are never collapsed under the parent job.
- Successful evidence may accumulate across rerun attempts of that workflow run. Evidence from another workflow run does not satisfy the ledger. A later failure does not erase an earlier successful execution for the same test and SHA.
- Skipped, unexecuted, queued, in-progress, cancelled, and failing results do not count as successful evidence.
- Map each test with successful evidence to its successful run or job URL and attempt number.
- Each missing or skipped execution in the accepted successful workflow run requires its own itemized maintainer exception. Record the test identifier, relevant run links or available evidence, the current result, and the rationale.
- Missing or invalid exact Brev Launchable E2E evidence in the accepted successful workflow run requires a separate itemized maintainer exception. Record the run and job URLs, the missing or invalid receipt, and the rationale.

The accepted workflow run must be completed and have a `success` conclusion. A failed workflow run cannot supply the release ledger. Rerun its failed jobs until the workflow concludes with `success`. An itemized test exception applies only to a missing or skipped execution in that otherwise successful run.

Each test and the exact Brev Launchable E2E job in the accepted successful workflow run must have successful evidence or its own permitted itemized exception before release confirmation. Immediately before confirmation, compare `origin/main` with the planned SHA. If the candidate SHA changes, discard the ledger and its exceptions, including Launchable E2E evidence. Regenerate the release plan and repeat the review for the new SHA. This does not freeze `main` or prevent merges. No release-note-only delta exception is currently defined.

## Carry Forward

Open PRs and issues that miss the cutoff remain active carry-forward work, but their target changes after the release succeeds. Post-tag housekeeping creates the next patch label if needed, removes the released-version label from every open straggler, adds the next patch label, verifies no open item remains on the released label, and deletes the released label.

The `release-latest-tag` workflow runs automatic carry-forward after moving `latest`. It shares the release-label coordination queue with post-merge assignment and must complete before housekeeping is considered successful. The release confirmation must include the housekeeping plan, so the post-tag label writes remain inside the authorized release operation. Do not run the retirement script directly or manually add a label whose semver tag already exists.

Maintainers may:

- Add the current version label when they want the PR visible in the current day queue.
- Remove a version label without replacement when an item is deferred, superseded, closed, or no longer part of the daily cycle.
- Rerun post-tag housekeeping after a partial failure. Moved items no longer have the released label, so the operation can resume safely.

## Label Retirement

Release labels are temporary planning state. Retire one only when all conditions are true:

1. The semver tag and workflow-managed `latest` both resolve to the confirmed release commit.
2. Every open PR and issue has moved to the next patch label or explicitly left the daily release cycle.
3. A final query finds no open item carrying the released label.
4. The release confirmation explicitly authorizes deletion of that released label.
5. Retirement runs inside the shared release-label coordination queue.

Delete the repository label after those checks. Deletion removes it from merged and closed items without preserving a second, mutable release-membership signal. Never rename a released label into a future version, and never recreate a label whose semver tag already exists.
