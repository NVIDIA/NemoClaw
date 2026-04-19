---
name: nemoclaw-maintainer-evening
description: Runs the end-of-day maintainer handoff for NemoClaw. Checks version target progress, bumps stragglers to the next patch version, generates a QA handoff summary, and cuts the release tag. Use at the end of the workday. Trigger keywords - evening, end of day, EOD, wrap up, ship it, cut tag, handoff, done for the day.
user_invocable: true
---

# NemoClaw Maintainer Evening

Wrap up the day: check progress, bump stragglers, summarize for QA, cut the tag.

See [PR-REVIEW-PRIORITIES.md](../nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md) for the daily cadence.

## Step 1: Check Progress

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-target.ts
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-progress.ts <version>
```

The first script determines the target version. The second shows shipped vs open. Present the progress summary to the user.

## Step 2: Bump Stragglers

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/bump-stragglers.ts <version> <next-version>
```

This creates the next version label if needed, then moves all open items from the current version to the next. Tell the user what got bumped.

## Step 3: Generate Handoff Summary

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary.ts
```

This lists commits since the last tag, identifies risky areas touched, and suggests QA test focus areas. Format the output as a concise summary the user can paste into the tag annotation or a handoff channel.

## Step 4: Cut the Tag

Load `cut-release-tag`. The version is already known — default to patch bump, but still show the commit and changelog for confirmation.

## Step 5: Confirm and Share

After the tag is cut, present the final summary:

- **Tag**: `v0.0.8` at commit `abc1234`
- **Shipped**: 4 items (#1234, #1235, #1236, #1237)
- **Bumped to v0.0.9**: 1 item (#1238 — still needs CI fix)
- **QA focus areas**: installer changes, new onboard preset

This summary can be shared in the team's handoff channel.

## Step 6: Update State

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts history "tag-cut" "<version>" "shipped N items, bumped M"
```

## Notes

- Never cut a tag without user confirmation.
- If nothing was labeled or nothing shipped, ask whether to skip the tag today.
- Version labels are living markers: they always mean "ship in this version." If an item slips, the label moves forward.
