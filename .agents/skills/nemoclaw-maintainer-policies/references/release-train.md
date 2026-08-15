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

Before asking for the release confirmation phrase, require a completed, successful `Release qualification` check from a pre-tag manual run at that SHA.

### Temporary Staging Launchable Qualification Policy

Issue #8924 temporarily limits the trusted staging Launchable job to exact image publication.
NemoClaw maintainers own this policy while that issue remains open.
For each release candidate, the required automated evidence is a successful `Publish staging Brev Launchable image` job and its `launchable-image.json` artifact, bound to the exact candidate SHA through the successful `Release qualification` check.
GitHub retains the workflow logs and artifact under the repository's normal Actions retention policy.
An image-publication failure still blocks release qualification unless a repository administrator uses the existing documented job-waiver mechanism.

The temporary risk acceptance permits a release tag without automated or manual proof of the staging Launchable web deployment, environment access, exact booted image, baked runtime, inference, or workspace cleanup.
Manual validation remains advisory, and a missing, partial, or failed result needs no per-release waiver.
It must not be reported as an automated E2E pass.

Restore the automated deployment lane when a published Brev CLI release contains the Launchable image-forwarding fix and the host-route fix tracked by #8924.
NemoClaw must checksum-pin that release and complete a trusted `main` run that verifies deployment, environment access, exact image and runtime identity, hosted and sandbox inference, and workspace cleanup.
That successful run is the reactivation evidence; closing #8924 records the end of this temporary policy.

- `.github/workflows/e2e.yaml` derives the release-required jobs from its E2E metadata. Do not copy them into a second release test list.
- Push runs publish `Relevant E2E`; only full manual runs dispatched against `main` with empty selectors publish `Release qualification`.
- By default, the check requires every default-required workflow result to succeed, including `Publish staging Brev Launchable image`.
- A repository administrator may waive one or more release-required E2E execution jobs with `release_qualification_waived_jobs` and `release_qualification_waiver_reason`.
- `release_qualification_waived_jobs` is a comma-separated list of requested job IDs.
- The reason must begin with an ASCII letter or digit and contain 10-500 characters chosen from ASCII letters, digits, spaces, and `.,:;/_()'-`.
- Both inputs must be nonempty, or both inputs must be empty.
- Both `github.actor` and `github.triggering_actor` must have repository `admin` permission for the waiver.
- The trusted planner must reject unknown, duplicate, or non-release-required job IDs.
- Trusted controller jobs cannot be waived.
- The trusted planner removes only the named jobs from `release_required_jobs` and emits canonical waived-job JSON.
- Every waived job still runs, and `include_staging_brev_launchable=true` remains required.
- The `generate-matrix` dispatch receipt is written after waiver authorization and before that job's source checkout. It records the requested job IDs, reason, both actor identities, and candidate SHA.
- After trusted planner validation, the `Release qualification` summary and waiver artifact record the canonical job IDs and each waived job's completed outcome.
- A normal full run must conclude with `success`.
- An administrator-waived full run may conclude with `failure` when a waived execution job fails, `Release qualification` succeeds, and the waiver artifact binds that failure to the candidate, run, actors, reason, and canonical waived job IDs.
- `jetson-nvmap-gpu`, `llama-cpp-dgx-spark-plan`, and `llama-cpp-dgx-spark-qualification` remain separate opt-in work and do not block this check.
- A successful Launchable image job proves that the producer published the exact candidate image to the staging family. Its `launchable-image.json` artifact records Launchable, runtime, and inference validation as not run.
- Manual staging Launchable validation is advisory while issue #8924 blocks the automated deployment path. A missing, partial, or failed manual result does not block the release tag and must not be reported as an automated E2E pass.
- A skipped, queued, in-progress, cancelled, or failed `Release qualification` check is not release evidence.
- A check from another commit SHA is not release evidence.
- Use an existing qualifying pre-tag run for the candidate SHA; run `nemoclaw-maintainer-e2e` in full mode when none exists, with an administrator-authorized job waiver when required.

Record the workflow and `Release qualification` job URLs.
Run the release script's signing preflight before confirmation.
For the canonical `NVIDIA/NemoClaw` remote, `scripts/release-cut-tag.sh` searches completed, successful manual `.github/workflows/e2e.yaml` runs and completed failed manual runs at the exact planned `origin/main` commit.
It accepts the first successful run with exactly one completed, successful `Release qualification` job.
For a failed run, it also requires a valid waiver artifact with at least one planner-validated waived job failure.
It fails closed when no qualifying run exists.
A run with zero or multiple jobs of that name is not evidence.
The script repeats this check before it pushes the tag.
Local fixture remotes skip the production gate only when tests set `NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL=1` and the shared classifier confirms a noncanonical origin.
Canonical-equivalent `NVIDIA/NemoClaw` remotes always run the gate, even when that override is set.
A local fixture cannot authorize a release.
If the candidate SHA changes, discard the earlier check, regenerate the release plan, and require qualifying full manual E2E for the new SHA.
This does not freeze `main` or prevent merges.
No release-note-only delta exception is currently defined.

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
