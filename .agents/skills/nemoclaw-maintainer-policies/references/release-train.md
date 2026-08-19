<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Release Train

Daily release labels coordinate release work. They do not classify issues and they do not promise readiness.

## Rules

- PRs own the release-inclusion meaning of daily version labels.
- Engineers and agents may add the current `v0.0.x` label to open PRs to activate them for day work.
- After a PR merges to `main`, the trusted post-merge workflow adds the next patch label only when the merge is ahead of the latest release tag. A merge already contained in a release tag receives no release label.
- A scheduled and manually dispatchable reconciliation pass repairs missed or failed merge events only across the untagged interval from the latest release tag to `main`.
- Post-merge assignment and tag-triggered label retirement share one non-cancelling GitHub Actions
  concurrency group. GitHub retains at most one pending run, so scheduled reconciliation repairs a
  merge event that a newer pending run replaces.
- Issues may also carry daily version labels when they need a PR, fix, or regression follow-up for the daily tag.
- Applying a daily version label is not a readiness claim.
- Release includes PRs that both carry the daily version label and are merged by cutoff.
- Issue version labels are tracking signals. An issue label does not include work in the release without a merged, labeled PR.
- Open PRs and issues that miss a tagged release carry forward automatically by moving from the released version label to the next patch label.
- After the semver tag and workflow-managed `latest` are verified, post-tag housekeeping moves open stragglers and deletes the released version label. Tags and commit ancestry are the only durable release-membership record.
- Released version labels must be deleted, never renamed or reused for a later release.

## Release-Prep Docs

Use one cumulative documentation PR for all merged changes selected for the release. Continue the
managed Pi PR when one exists. If no managed PR exists and only release documentation remains, use
one direct documentation-only PR.

That PR must include all required user documentation and one canonical
`docs/changelog/YYYY-MM-DD.mdx` entry headed `## vX.Y.Z`. In the normal evening flow, merge it before
generating the release plan so the entry is in the planned candidate. If direct use of the release-tag
skill has already produced a plan whose candidate lacks the entry or another required documentation
change, merge the documentation PR and generate a new plan for the resulting candidate.

Require the exact candidate's `Docs / Post-Merge Catch-Up` run to finish with a successful
`Publish documentation catch-up` job. That success records an independently reviewed, approved
empty Pi patch for the candidate. If Pi finds a change, the workflow opens a managed PR and
publication does not succeed.

For the candidate only, require no open managed PR and no remote branch named
`automation/post-merge-docs-<first-12-candidate-characters>`. A managed PR or branch for a later
commit does not invalidate an earlier candidate. The release entry and approved-empty Pi result
cannot be waived.

## Cutoff

The daily cutoff is the maintainer-defined point where the release tag is prepared.

At cutoff:

1. List merged PRs carrying the target version label.
2. Confirm each is intended for the release.
3. List open PRs and issues still carrying the target label as post-tag stragglers.
4. Complete [Release-Prep Docs](#release-prep-docs) for the intended release range.
5. Generate the immutable release plan with the exact `--version vX.Y.Z` to capture the candidate
   commit.
6. Verify the candidate's required documentation and image evidence. If
   documentation is missing, complete [Release-Prep Docs](#release-prep-docs), merge that PR,
   generate a new plan, and repeat the evidence checks for the new candidate.
7. Show the newest full E2E context and record the maintainer's focused, full, or proceed decision.
8. Build the Markdown release brief from the exact range and evidence.
9. Cut the release tag only with the plan's explicit maintainer confirmation.

Merges may continue after planning. Keep the planned candidate when it remains an ancestor of
`origin/main`, the previous release has not changed, and its own required evidence remains valid.
Regenerate the plan only when the intended range, version, or candidate changes.

## Required Image Evidence

Before confirmation, require a successful exact-candidate E2E `base-image-publication` job. Its
checked-in verifier selects the newest applicable image-changing commit in first-parent history,
requires every managed publisher, and validates the immutable Deep Agents Code base contract.
Record the E2E workflow and aggregate-job URLs and the run attempt; do not repeat its publisher
queries in the tag skill.

The general E2E decision cannot waive required image evidence. A successful `Release
qualification` aggregate does not replace the exact-candidate result.

## General E2E Decision

The general E2E decision records whether the maintainer chooses focused tests, the full suite, or the
displayed general E2E status. General E2E informs the maintainer; it does not decide whether a tag
can exist. Show the newest full run's full SHA, status, conclusion, attempt, created, started, and
last-updated timestamps, age at inspection, workflow URL, `Release qualification` URL, and any
failed, cancelled, skipped, queued, or active results.

Offer three choices:

1. run maintainer-selected focused tests;
2. run the full suite; or
3. proceed with the status shown.

Show and record every requested run result. A requested run remains unresolved while it is queued or
running, or after it ends without success. It becomes resolved only when a successful result covers
the same requested scope.

Use `Exceptions: None` only when the maintainer accepts a successful full result for the candidate
and no requested run remains unresolved. Otherwise, record one plain-language reason that names the
different, missing, non-successful, or unresolved status and explains why the maintainer is
proceeding.

This decision applies only to E2E. It cannot cover missing documentation or required image
evidence. Do not maintain a separate exception schema or ledger.

## Signed Release Brief

Create `../nemoclaw-release-vX.Y.Z/release-brief.md` from the exact plan range. Include:

- exact range, commit and risky-file counts, risky areas, and suggested QA focus from the handoff
  helper;
- the complete canonical release entry and its path;
- Pi documentation workflow and job URLs, artifact name, and normalized approved-empty review;
- the base-image aggregate URL and identity;
- the newest full E2E result and every requested run;
- the maintainer's E2E decision; and
- `Exceptions: None` or the plain-language exception reason.

Pass that exact Markdown to `release:cut` with `--message-file`. It becomes the signed annotated tag
message and is the release evidence record. Do not create a separate exception file.

Require the full confirmation phrase from the plan. After the script reads the remote tag back and
confirms that it peels to the candidate, report the tag as cut and return.

## Post-Tag States

Moving `latest`, carrying labels forward, publishing public documentation, rebuilding and publishing release
images, promoting `lkg`, and publishing the Announcement do not extend tag cutting. Some share a
workflow or depend on another post-tag state. Report only already-known results and mark the rest
pending or unknown; do not poll before returning the tag result.

Tag-triggered image publication performs a release rebuild and can fail after the tag exists. Repair
and rerun that workflow independently. Do not describe it as promotion-only and do not move the
semver tag.

## Carry Forward

Open PRs and issues that miss the cutoff remain active carry-forward work, but their target changes after the release succeeds. Post-tag housekeeping creates the next patch label if needed, removes the released-version label from every open straggler, adds the next patch label, verifies no open item remains on the released label, and deletes the released label.

The `release-latest-tag` workflow runs automatic carry-forward after moving `latest`. It shares the
release-label concurrency group with post-merge assignment and must complete before housekeeping is
considered successful. Its status does not change whether the semver tag was cut. Do not run the
retirement script directly or manually add a label whose semver tag already exists.

Maintainers may:

- Add the current version label when they want the PR visible in the current day queue.
- Remove a version label without replacement when an item is deferred, superseded, closed, or no longer part of the daily cycle.
- Rerun post-tag housekeeping after a partial failure. Moved items no longer have the released label, so the operation can resume safely.

## Label Retirement

Release labels are temporary planning state. Retire one only when all conditions are true:

1. The semver tag and workflow-managed `latest` both resolve to the confirmed release commit.
2. Every open PR and issue has moved to the next patch label or explicitly left the daily release cycle.
3. A final query finds no open item carrying the released label.
4. Retirement runs inside the trusted release workflow's shared concurrency group.

Delete the repository label after those checks. Deletion removes it from merged and closed items without preserving a second, mutable release-membership signal. Never rename a released label into a future version, and never recreate a label whose semver tag already exists.
