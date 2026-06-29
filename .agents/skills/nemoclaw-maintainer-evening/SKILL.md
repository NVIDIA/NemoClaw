---
name: nemoclaw-maintainer-evening
description: Runs the end-of-day maintainer handoff for NemoClaw. Checks version target progress, records stragglers for an automatic post-tag bump, generates a QA handoff summary, and cuts the release tag. Use at the end of the workday. Trigger keywords - evening, end of day, EOD, wrap up, ship it, cut tag, handoff, done for the day.
user_invocable: true
---

# NemoClaw Maintainer Evening

Wrap up the day: check progress, identify stragglers, summarize for QA, cut the tag, automatically bump stragglers to the next patch, and prepare release notes for posting.

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

If an item should leave the daily release flow instead of moving forward, remove it from the released-version label before asking for the release confirmation phrase.

## Step 3: Generate Handoff Summary

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary.ts
```

This lists commits since the last tag, identifies risky areas touched, and suggests QA test focus areas. Format the output as a concise summary the user can paste into the tag annotation or a handoff channel.

## Step 4: Cut the Tag and Publish Release Notes

Load `cut-release-tag`. The version is already known — default to patch bump, but still show the commit, changelog, post-tag bump plan, and release notes draft for confirmation. NemoClaw releases are tag-based: tag `main`, let the workflow move `latest`, automatically bump remaining open issues/PRs to the next patch label, and prepare the release notes announcement for the maintainer to post.

## Step 5: Confirm and Share

After the tag is cut and release notes are drafted or posted by the maintainer, present the final summary:

- **Tag**: `v0.0.8` at commit `abc1234`
- **Release notes draft**: `../nemoclaw-release-v0.0.8/release-note-draft.md`
- **Shipped**: 4 items (#1234, #1235, #1236, #1237)
- **Bumped to v0.0.9**: 1 item (#1238 — still needs CI fix)
- **QA focus areas**: installer changes, new onboard preset

This summary can be shared in the team's handoff channel.

## Step 6: Update State

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts history "tag-cut" "<version>" "shipped N items, bumped M"
```

## Notes

- Never cut a tag or hand off release notes without user confirmation.
- If nothing was labeled or nothing shipped, ask whether to skip the tag today.
- A PR version label activates release work; it is not a readiness claim.
- If an open item misses the tag, post-tag housekeeping moves its target to the next patch version.
