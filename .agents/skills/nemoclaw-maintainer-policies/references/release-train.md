<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Release Train

Daily release labels coordinate release work. They do not classify issues, promise readiness, or gate release tags.

## Daily Timeline

Use `America/Los_Angeles` for all boundaries.

| Time | State | Work |
|---|---|---|
| 8:00 AM–4:00 PM | Merge window | Merge reviewed PRs. Dispatch an asynchronous agent review for every exact `main` SHA range. |
| 4:00 PM | Edition closed | Stop merging. Freeze the latest GitHub-recorded `main` push at or before the cutoff. |
| 4:00 PM–4:00 AM | Frozen | Run consolidated E2E, diagnose failures, selectively rerun, and prepare fix PRs. Do not merge. |
| 4:00 AM | Edition tagged | Tag the frozen candidate regardless of E2E state. Continue the advisory loop. |
| 8:00 AM | Handoff | Give tag, review, E2E, failure, and fix state to the next release doula. Reopen merging. |

A merge after the cutoff belongs to the next edition even if the scheduled close workflow starts late. The planner selects the latest `post-merge-agent-review.yaml` push run that GitHub recorded at or before exactly 4:00 PM. It does not select the current tip at workflow execution time.

## Release Labels

- PRs own the release-inclusion meaning of daily version labels.
- Engineers and agents may add the current `v0.0.x` label to open PRs to activate them for day work.
- A PR is included only when it carries the target label and its merge is in the frozen candidate.
- Issue labels are tracking signals; they do not include code in an edition.
- Applying a version label is not a readiness claim.
- The trusted post-merge workflow labels untagged merges, and reconciliation repairs missed events.
- Open PRs and issues that miss the edition move to the next patch label after the tag succeeds.
- Released labels are deleted after carry-forward. Never rename, recreate, or reuse them.
- Tags and commit ancestry are the durable release-membership record.

Post-merge assignment and release-label retirement share one queued concurrency group so authorized writes cannot race the verification-and-delete window.

## Release-Prep Docs

Run `/nemoclaw-contributor-update-docs for vX.Y.Z` early enough for the PR to merge before 4:00 PM. The PR must create or update `docs/changelog/YYYY-MM-DD.mdx` with the exact `## vX.Y.Z` heading, parser-safe MDX SPDX comment, summary, and detailed bullets.

The frozen non-empty candidate must contain exactly one matching heading in a direct child of `docs/changelog/`. Ordinary documentation and the post-tag Announcement do not replace it. No changelog waiver exists.

## Frozen Plan

`.github/workflows/release-edition-close.yaml` is scheduled for 4:17 PM to avoid the busiest cron boundary while preserving the exact 4:00 PM cutoff. It creates a schema-v2 release plan containing:

- edition date and exact cutoff instant;
- planning-time `origin/main` and frozen candidate SHAs;
- candidate source workflow run ID and GitHub-recorded time;
- previous and next semver tags;
- untagged commit count and `ready` or `no-changes` status;
- exact changelog match for a non-empty edition;
- `latest` and `lkg` observations;
- scheduled authority and forbidden operations; and
- a SHA-256 consistency hash over the complete plan.

The trusted scheduled run uploads `release-edition-plan-YYYY-MM-DD`. The workflow run and artifact provenance establish scheduled release authority. The hash provides a stable receipt identifier and detects changes that do not update it; it does not authenticate a file from another source.

If no commits follow the latest semver tag at cutoff, the edition succeeds as `no-changes` and creates no tag.

## Asynchronous Review and Advisory E2E

Every non-initial push to `main` dispatches the existing isolated PR Review Advisor with the exact immutable `before...after` SHA range. Advisor concurrency includes the head SHA, so a later merge does not cancel an earlier review. These post-merge reviews are asynchronous findings for the overnight loop and morning triage; they are not required status checks.

`.github/workflows/e2e.yaml` is scheduled for 4:17 PM. One agent may use its consolidated results, prior exact-SHA runs, and selective reruns to:

1. classify product regressions, flaky tests, infrastructure failures, and stale tests;
2. consolidate duplicates;
3. prepare focused fix PRs or test cleanups;
4. validate those PRs without merging during the freeze; and
5. preserve unresolved state for the 8:00 AM handoff.

E2E never enters the tag authorization. Do not create an E2E waiver ledger, wait for a run, or advance the candidate in response to E2E results. This trades repeated per-PR E2E for one methodical post-merge validation window while retaining fast deterministic checks and agent review on changes.

## Tag and Promotion

`.github/workflows/release-edition-cut.yaml` is scheduled for 4:17 AM and selects the trusted plan artifact for the previous edition date. It must fail closed on:

- missing, expired, ambiguous, or wrong-date plan provenance;
- plan hash or schema mismatch;
- changelog absence or duplication;
- candidate or previous-tag ancestry failure;
- a newer remote semver tag or a tag collision;
- wrong repository, event, workflow revision, or authorization mode;
- signing-key or signer-identity failure;
- remote tag mismatch or GitHub signature-verification failure;
- `latest` rollback or tag-object mismatch;
- unexpected `lkg` movement; and
- carry-forward or released-label retirement failure.

Do not fail, wait, or branch on E2E state.

The `release-tag` environment holds a dedicated SSH private signing key and non-secret signer name/email variables. The signing key signs only; `GITHUB_TOKEN` authenticates the tag push. Because `GITHUB_TOKEN` pushes do not trigger a new push workflow, the cut workflow directly calls the reusable `release-latest-tag.yaml` workflow. Local maintainer tag pushes still use its tag trigger.

## Carry Forward and Label Retirement

After GitHub verifies the signed annotated semver tag, `release-latest-tag.yaml` moves `latest` to that exact tag object. Inside the shared release-label queue, it creates the next patch label if needed, moves every open straggler, verifies none remain on the released label, and deletes the released label.

Do not invoke the retirement script directly. Rerun `release-latest-tag.yaml` through manual dispatch after fixing a partial failure; its operations are idempotent.

## 8 AM Handoff

Hand over:

- edition date, tag, candidate SHA, and plan hash;
- `cut-result.json`, `latest-result.json`, and `notes-data.json` artifact locations;
- exact-SHA post-merge review runs and actionable findings;
- E2E classifications, reruns, flaky or broken tests, and unresolved risks;
- prepared fix PRs ready for the reopened merge window;
- carry-forward and released-label retirement state; and
- Announcement draft status.

Keep candidate internals, review diagnostics, E2E classifications, rerun details, and failure rationale out of the public Announcement.
