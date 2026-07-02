---
name: nemoclaw-maintainer-cut-release-tag
description: Creates deterministic NemoClaw semver release tags on origin/main after release readiness is frozen, handles release housekeeping, and drafts announcement notes. Use when cutting a release, tagging a version, shipping a build, creating vX.Y.Z tags, or preparing release announcements.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cut Release Tag

Use the release scripts for normal release operations. Do not run raw `git tag`, `git push`, `gh api`, or version-bump commands by hand for the normal release flow.

The release is one annotated semver tag on an already-merged `origin/main` commit. The GitHub workflow moves `latest`; release admins promote `lkg` manually after validation. This skill consumes completed release readiness, generates the final plan as the commit-freeze boundary, pushes the semver tag, verifies `latest`, moves remaining open issues/PRs from the released version label to the next patch label, and drafts announcement notes for the maintainer to post.

## Hard Rules

- Tag only the commit captured in a generated release plan.
- Do not generate the release plan until release readiness is complete: docs merged or waived, docs scan delta reviewed, pre-tag checks complete or waived, and no further intended merge remains.
- Any merge after plan generation invalidates the plan. Regenerate the plan after re-checking readiness against the new candidate SHA.
- Ask the maintainer to paste the exact confirmation phrase from the final plan before cutting the tag.
- Push only the semver tag (`vX.Y.Z`) from the agent-controlled step.
- Never push `latest` or `lkg` from this skill.
- Never move, delete, or force-push an existing remote semver tag unless the maintainer explicitly starts protected-tag remediation.
- Do not launch or merge the release-prep docs PR from this skill. Return to `nemoclaw-maintainer-evening` if mutable readiness work remains.
- Draft announcement notes locally. Do not create the GitHub Discussion; the maintainer does that.
- Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md) for SSH, authentication, remote access, authorization, or permission failures.

## Workflow

Copy this checklist and update it as you proceed:

```text
Release Progress:
- [ ] Step 1: Confirm release readiness and freeze inputs
- [ ] Step 2: Generate final release plan
- [ ] Step 3: Show final plan and ask for exact confirmation
- [ ] Step 4: Cut the semver tag from the confirmed plan
- [ ] Step 5: Wait for workflow-managed latest
- [ ] Step 6: Bump remaining open issues/PRs
- [ ] Step 7: Generate announcement data and draft Markdown
- [ ] Step 8: Hand off announcement steps
```

### Step 1: Confirm Release Readiness and Freeze Inputs

Before running `release:plan`, confirm the maintainer can report:

- cutoff inventory and post-tag straggler plan;
- release-prep docs status, either merged with PR and merge SHA or waived with reason;
- docs scan SHA, current candidate SHA, and the `docs_scan_sha..candidate_sha` delta review;
- required pre-tag checks, with waiver reasons for any skipped check;
- confirmation that no further intended merge remains.

If release-prep docs are `pending`, stop before generating the release plan.
If any mutable release prerequisite is still in progress, return to `nemoclaw-maintainer-evening`.

### Step 2: Generate Final Release Plan

Run exactly one of:

```bash
npm run release:plan -- --bump patch
npm run release:plan -- --bump minor
npm run release:plan -- --bump major
```

Patch is the default if the maintainer says "yes", "go", or similar without choosing.

This is the commit-freeze boundary.
Do not merge additional PRs after this point.
If `origin/main` changes after plan generation, discard the stale plan, re-check release readiness, and generate a fresh plan.

The script writes a plan outside the checkout root, for example:

```text
../nemoclaw-release-v0.0.58/plan.json
```

### Step 3: Show Final Plan and Ask for Exact Confirmation

Read the generated `plan.json` and show the maintainer:

- previous tag,
- next tag,
- target `origin/main` commit and headline,
- plan hash,
- release readiness summary,
- forbidden operations,
- exact confirmation phrase,
- open issue/PR housekeeping plan for the release label.

Ask the maintainer to paste the exact phrase:

```text
CONFIRM RELEASE vX.Y.Z <full-origin-main-sha>
```

Do not proceed on a generic "yes" at this step.

### Step 4: Cut the Semver Tag

Run the cut script with the plan and the maintainer's exact phrase:

```bash
npm run release:cut -- --plan <plan.json> --confirm "CONFIRM RELEASE vX.Y.Z <full-origin-main-sha>"
```

The script verifies a clean worktree, unchanged `origin/main`, tag availability, target reachability, and remote peeled tag state. It writes:

```text
<release-dir>/cut-result.json
```

If the script fails because of SSH, authentication, remote access, authorization, or permissions, follow [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md). For other precondition failures, report the failed precondition and use the recovery guidance below. Do not improvise git commands.

### Step 5: Wait for Workflow-Managed `latest`

Run:

```bash
npm run release:wait-latest -- --plan <plan.json>
```

The script waits until `vX.Y.Z^{}` and `latest^{}` both peel to the planned commit and verifies `lkg` did not change from the plan. It writes:

```text
<release-dir>/latest-result.json
```

If it fails, report the failed workflow/status. Do not manually move `latest`.

### Step 6: Bump Remaining Open Issues/PRs

Move every remaining open issue or PR carrying the released version to the next patch label:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/bump-stragglers.ts <released-version> <next-version>
```

This is automatic post-tag housekeeping covered by the release plan and exact confirmation in Step 4. The script creates the next patch label when needed, removes the released-version label, and adds the next-version label to every open straggler. Do not run it before Step 5 verifies both the semver tag and workflow-managed `latest`.

Then verify the released version has no open stragglers:

```bash
gh issue list --repo NVIDIA/NemoClaw --state open --label <released-version> --limit 100
gh pr list --repo NVIDIA/NemoClaw --state open --label <released-version> --limit 100
```

Summarize:

- open issues/PRs bumped to `<next-version>`;
- any items that need manual maintainer attention.

### Step 7: Generate Announcement Data and Draft Markdown

Collect deterministic announcement input:

```bash
npm run release:notes-data -- --plan <plan.json>
```

This writes:

```text
<release-dir>/notes-data.json
```

If `notes-data.json` has `status: "partial"` or non-empty `pullRequestWarnings`, report the warnings and ask the maintainer whether to fetch/fill the missing PR metadata before drafting.

Draft announcement notes from `notes-data.json` using the style from `nemoclaw-maintainer-release-notes`. Save only Markdown, outside the checkout root:

```text
<release-dir>/announcement-notes-draft.md
```

Do not create or update a GitHub Discussion.

### Step 8: Hand Off Announcement

Return:

- release tag,
- confirmed release commit,
- release readiness summary, including docs status and docs scan delta review,
- plan path and plan hash,
- `cut-result.json`, `latest-result.json`, and `notes-data.json` paths,
- Markdown draft path,
- issue/PR housekeeping summary,
- suggested discussion title: `NemoClaw <new-version> is out`,
- reminder: maintainer creates the Announcement discussion and shares its link in external channels.

## Recovery

- Plan generation fails: fix the named precondition, then regenerate the plan.
- `origin/main` moved after plan generation: regenerate the plan and ask for the new exact confirmation phrase.
- Remote semver tag already exists: stop; do not retag unless the maintainer explicitly starts protected-tag remediation.
- `latest` workflow fails or times out: report the workflow/status; do not move `latest` manually.
- `latest` workflow rejects a rollback: keep `latest` unchanged, inspect the plan target commit, and regenerate the plan for the current `origin/main` tip if appropriate.
- `lkg` changed: stop and escalate to a release admin.
- Post-tag housekeeping fails: report the error and list items still carrying the released label. After the failure is fixed, rerun the same bump command; already-moved items no longer match the source label.
