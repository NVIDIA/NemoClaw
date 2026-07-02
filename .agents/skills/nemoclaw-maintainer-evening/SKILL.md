---
name: nemoclaw-maintainer-evening
description: Runs the end-of-day maintainer handoff for NemoClaw. Checks version target progress, records stragglers for an automatic post-tag bump, completes pre-plan release readiness, and cuts the release tag. Use at the end of the workday. Trigger keywords - evening, end of day, EOD, wrap up, ship it, cut tag, handoff, done for the day.
user_invocable: true
---

# NemoClaw Maintainer Evening

Wrap up the day: check progress, identify stragglers, summarize for QA, complete pre-plan release readiness, cut the tag, automatically bump stragglers to the next patch, and prepare announcement notes for posting.

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

List open labeled PRs and issues as the post-tag housekeeping plan. Tell the maintainer that, after the tag and workflow-managed `latest` are verified, `cut-release-tag` will automatically move all of them to the next patch label.

If an item should leave the daily release flow instead of moving forward, remove it from the released-version label before declaring release readiness.

## Step 3: Generate Handoff Summary

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary.ts
```

This lists commits since the last tag, identifies risky areas touched, and suggests QA test focus areas. Format the output as a concise summary the user can paste into the tag annotation or a handoff channel.

## Step 4: Complete Pre-Plan Release Readiness

Load `nemoclaw-contributor-update-docs` for the release version before generating the final release plan.
This can run while final E2E validation finishes.
The release docs PR should use the release label being prepared, such as `v0.0.73`, and should land before `release:plan` captures the frozen candidate SHA unless the maintainer explicitly records a docs waiver.

Report one of these docs statuses before continuing:

- `merged`: release-prep docs landed for `<version>`.
- `pending`: release-prep docs PR is open and must finish before the final release plan.
- `waived`: maintainer explicitly accepted tagging without pre-tag docs and gave the reason.

Stop on `pending`.
When docs are `merged` or `waived`, record the docs scan SHA, the current candidate SHA, and whether the `docs_scan_sha..candidate_sha` delta has additional docs impact.
Also confirm that all required pre-tag checks are complete or explicitly waived, and that no further intended merge remains.

## Step 5: Freeze the Plan, Cut the Tag, and Publish Announcement Notes

Load `cut-release-tag` only after release readiness is complete.
The version is already known.
Default to patch bump, but still show the commit, changelog, release-readiness status, post-tag bump plan, and announcement draft for confirmation.
NemoClaw releases are tag-based: tag `main`, let the workflow move `latest`, automatically bump remaining open issues/PRs to the next patch label, and prepare the release announcement for the maintainer to post.

## Step 6: Confirm and Share

After the tag is cut and announcement notes are drafted or posted by the maintainer, present the final summary:

- **Tag**: `v0.0.8` at commit `abc1234`
- **Release docs**: merged or waived with reason
- **Readiness freeze**: docs scan SHA, candidate SHA, and delta review status
- **Announcement draft**: `../nemoclaw-release-v0.0.8/announcement-notes-draft.md`
- **Shipped**: 4 items (#1234, #1235, #1236, #1237)
- **Bumped to v0.0.9**: 1 item (#1238 — still needs CI fix)
- **QA focus areas**: installer changes, new onboard preset

This summary can be shared in the team's handoff channel.

## Step 7: Update State

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts history "tag-cut" "<version>" "shipped N items, bumped M"
```

## Notes

- Never cut a tag or hand off announcement notes without user confirmation.
- Never generate the final release plan until release-prep docs are merged or explicitly waived and no further intended merge remains.
- If any merge lands after plan generation, return to Step 4, re-check readiness, and generate a fresh plan.
- If nothing was labeled or nothing shipped, ask whether to skip the tag today.
- A PR version label activates release work; it is not a readiness claim.
- If an open item misses the tag, post-tag housekeeping moves its target to the next patch version.
