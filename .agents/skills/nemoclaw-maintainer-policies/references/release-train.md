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
- Require a v2 workflow-produced trusted dispatch receipt with `prNumber: null`, repository and
  candidate repository both `NVIDIA/NemoClaw`, and base, workflow, and candidate SHAs all equal to
  the release candidate. Bind the accepted run ID, attempt, and selector inputs.
- Run `nemoclaw-maintainer-e2e` in ordinary mode when the ledger lacks complete evidence for the
  candidate SHA.
- Require one completed, successful ordinary workflow run for all default-selected workflow E2E
  jobs. Qualify the release image separately so release-ledger completion does not trigger an image
  build.
- Require the trusted dispatch receipt to record `allowJetsonDispatch: false`,
  `allowJetsonRunnerQueue: false`, and `allowDgxSparkRunnerQueue: false`.
- Exclude `jetson-nvmap-gpu`, `llama-cpp-dgx-spark-plan`, and `llama-cpp-dgx-spark-qualification` from the required denominator.
- Require the trusted dispatch receipt to bind the workflow run and an attempt no later than the
  run's latest attempt. The receipt must record empty selectors and
  `include_staging_brev_launchable=false`.
- Every E2E execution selected by the accepted dispatch must have at least one completed, successful execution for the candidate SHA.
- Treat each expanded matrix execution as a separate ledger entry. Use its matrix `id`, or all distinguishing matrix dimensions when no single ID exists, in the test identifier so results for distinct expansions are never collapsed under the parent job.
- Successful evidence may accumulate across rerun attempts of that workflow run. Evidence from another workflow run does not satisfy the ledger. A later failure does not erase an earlier successful execution for the same test and SHA.
- Skipped, unexecuted, queued, in-progress, cancelled, and failing results do not count as successful evidence.
- Map each test with successful evidence to its successful run or job URL and attempt number.
- Each missing or skipped execution in the accepted successful workflow run requires its own itemized maintainer exception. Record the test identifier, relevant run links or available evidence, the current result, and the rationale.

The accepted workflow run must be completed and have a `success` conclusion. A failed workflow run cannot supply the release ledger. Rerun its failed jobs until the workflow concludes with `success`. An itemized test exception applies only to a missing or skipped execution in that otherwise successful run.

Keep the exact-candidate release ledger separate from the image choice. Before release confirmation,
show the newest historically validated image whose candidate SHA is an ancestor of the release commit.
Evidence may come from a trusted `main` push, selective Launchable run, or full run, but it must have
a successful `Exact staging Brev Launchable` job, valid immutable image identity in `brevdevprod`,
`fullE2e: passed`, and verified cleanup. An itemized exception never qualifies an image.

Include the image creation time, workflow creation time, selected job completion time, and commit
distance from the validated SHA to the release commit. Ask the maintainer to select that image as the
proposed exact-image handoff or run the selective Launchable test again and wait. A nonzero distance
requires explicit confirmation. If a fresh run fails, do not return to the earlier image without
maintainer confirmation. Image selection records evidence for the proposed handoff; it does not by
itself promote a GCP image family.

The selection is evidence only: the current `lkg` path does not consume it and still rebuilds. Do not
claim that the selected image was reused or promoted. Before a future exact-image promotion mutates a
family, its trusted downstream workflow must re-describe the image and require `READY` status plus
exact project, name, numeric ID, and self-link matches. Retained evidence does not prove that the
image still exists.

Each default-selected test in the accepted successful workflow run must have successful evidence or
its own permitted itemized exception before release confirmation. The image choice must independently
have complete Launchable E2E and cleanup evidence; no exception can qualify an image. Immediately
before confirmation, compare `origin/main` with the planned SHA. If the candidate SHA changes,
discard the ledger and its exceptions, regenerate the release plan, and repeat the review for
the new SHA. Discard the prior image decision, discover the newest qualified ancestor for the new
release SHA, present its evidence and recalculated distance, and obtain the prior-or-fresh choice
again. This does not freeze `main` or prevent merges. No release-note-only delta exception is
currently defined.

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
