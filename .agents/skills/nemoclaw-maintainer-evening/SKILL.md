---
name: nemoclaw-maintainer-evening
description: Runs the end-of-day NemoClaw release handoff, including the pre-tag dated changelog PR, version progress, straggler planning, QA summary, tag cut, and announcement draft. Use at the end of the workday. Trigger keywords - evening, end of day, EOD, wrap up, ship it, cut tag, handoff, done for the day, pre-tag release notes.
user_invocable: true
---

# NemoClaw Maintainer Evening

Wrap up the day: prepare the dated changelog, check progress, identify stragglers, summarize for QA, observe the scheduled tag, and hand asynchronous E2E stabilization to the overnight loop.

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

If an item should leave the daily release flow instead of moving forward, remove it from the released-version label before the 4 PM tag.

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
Finish the changelog before the 4 PM scheduled tag. A later merge belongs to the next daily tag.

## Step 4: Observe the Tag and Start Overnight Stabilization

Load `cut-release-tag` and inspect `Release / Daily Tag`. At 4 PM America/Los_Angeles, it tags the current `main` commit with the next patch version regardless of E2E state. Let the workflow move `latest`, automatically carry stragglers to the next patch, and retire the released label.

Every push to `main` already runs the complete E2E workflow. From 4 PM through 8 AM, keep merging normally while agents consolidate failures, remove redundant coverage, and fix broken or flaky E2Es. Do not delay or retry the tag because of those results.

Prepare the Announcement draft for the maintainer to post. Use the manual recovery path in `cut-release-tag` only when the scheduled workflow itself fails.

## Step 5: Confirm and Share

After the tag is cut and release notes are drafted or posted by the maintainer, present the final summary:

- **Tag**: `v0.0.8` at commit `abc1234`
- **E2E stabilization**: links to remaining failed or flaky post-merge runs for overnight follow-up
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

- The scheduled 4 PM tag does not require user confirmation or passing E2E.
- If nothing was labeled or nothing shipped, ask whether to skip the tag today.
- A PR version label activates release work; it is not a readiness claim.
- If an open item misses the tag, post-tag housekeeping moves its target to the next patch version.
- After carry-forward succeeds, post-tag housekeeping deletes the released label; never rename or reuse it.
