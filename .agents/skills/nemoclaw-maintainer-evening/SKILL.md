---
name: nemoclaw-maintainer-evening
description: Runs the end-of-day NemoClaw release handoff, including the pre-tag dated changelog PR, version progress, straggler planning, QA summary, tag cut, and announcement draft. Use at the end of the workday. Trigger keywords - evening, end of day, EOD, wrap up, ship it, cut tag, handoff, done for the day, pre-tag release notes.
user_invocable: true
---

# NemoClaw Maintainer Evening

Wrap up the day: check progress, identify stragglers, summarize for QA, cut the tag, automatically carry stragglers to the next patch, retire the released label, and prepare release notes for posting.

See [PR-REVIEW-PRIORITIES.md](../nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md) for the daily cadence.

## Step 1: Check Progress

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-target.ts
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-progress.ts <version>
```

The first script determines the target version. The second shows shipped vs open. Present the progress summary to the user.

## Step 2: Review Post-Tag Stragglers

```bash
gh pr list --repo NVIDIA/NemoClaw --state open --label <version> --limit 100 \
  --json number,title,url,labels
gh issue list --repo NVIDIA/NemoClaw --state open --label <version> --limit 100 \
  --json number,title,url,labels
```

List open labeled PRs and issues as the post-tag housekeeping plan. Tell the maintainer that, after the tag and workflow-managed `latest` are verified, `cut-release-tag` will automatically move all of them to the next patch label and delete the released label.

If an item should leave the daily release flow instead of moving forward, remove it from the released-version label before asking for the release confirmation phrase.

## Step 3: Generate Handoff Summary

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary.ts
```

This lists commits since the last tag, identifies risky areas touched, and suggests QA test focus areas. Format the output as a concise summary the user can paste into the tag annotation or a handoff channel.

## Pre-Tag Docs

Run `/nemoclaw-contributor-update-docs for <version>` before loading `cut-release-tag`.
Confirm that the release-prep docs PR creates or updates one direct child of `docs/changelog/` for the planned date and contains the exact `## <version>` heading, a parser-safe MDX SPDX comment, the summary, and the detailed release bullets.
An ordinary docs refresh or a post-tag Discussion draft does not satisfy this step.
The release-prep docs PR, including the dated changelog entry, must be merged, or explicitly waived with a reason that names the missing changelog entry, before `release:plan` captures the release commit.
If a docs PR or any other intended PR merges after `release:plan`, regenerate the plan before cutting the tag.

## Step 4: Cut the Tag and Publish Release Notes

Load `cut-release-tag`.
The version is already known, so use a patch bump unless the maintainer selects another bump.
Show the commit, changelog, carry-forward plan, label-retirement plan, and release notes draft.

After the release plan captures the candidate SHA, load `nemoclaw-maintainer-e2e`.
Run full mode if that SHA has no applicable exact Brev Launchable evidence.
Review the pre-tag E2E evidence ledger from `.github/workflows/e2e.yaml` at that commit.
When full mode runs, require a successful `Exact staging Brev Launchable` job, matching Launchable E2E identity, and verified workspace absence.
Each missing test result requires its own itemized maintainer exception.
Missing or invalid Launchable E2E evidence requires a separate itemized exception with run and job URLs, the result or missing receipt, and rationale.
Do not ask for the release confirmation phrase until each required result has successful evidence or its own exception.

Tag the confirmed release commit with `vX.Y.Z`.
Let the workflow move `latest`, carry open work forward, and delete the released label.
Prepare the Announcement draft for the maintainer to post.

## Step 5: Confirm and Share

After the tag is cut and release notes are drafted or posted by the maintainer, present the final summary:

- **Tag**: `v0.0.8` at commit `abc1234`
- **Pre-tag E2E evidence**: 12/13 tests and exact Brev Launchable E2E passing for the candidate SHA; 1 itemized maintainer exception
- **Release notes draft**: `../nemoclaw-release-v0.0.8/release-note-draft.md`
- **Shipped**: 4 items (#1234, #1235, #1236, #1237)
- **Moved to v0.0.9**: 1 item (#1238 — still needs CI fix)
- **Retired label**: `v0.0.8`
- **QA focus areas**: installer changes, new onboard preset

This summary can be shared in the team's handoff channel.

## Step 6: Update State

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts history "tag-cut" "<version>" "shipped N items, carried M forward"
```

## Notes

- Never cut a tag or hand off release notes without user confirmation.
- If nothing was labeled or nothing shipped, ask whether to skip the tag today.
- A PR version label activates release work; it is not a readiness claim.
- If an open item misses the tag, post-tag housekeeping moves its target to the next patch version.
- After carry-forward succeeds, post-tag housekeeping deletes the released label; never rename or reuse it.
