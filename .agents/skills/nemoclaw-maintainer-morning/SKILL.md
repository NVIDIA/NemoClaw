---
name: nemoclaw-maintainer-morning
description: Runs the morning maintainer standup for NemoClaw. Triages the backlog, determines the day's target version, labels selected items, surfaces stragglers from previous versions, and outputs the daily plan. Use at the start of the workday. Trigger keywords - morning, standup, start of day, daily plan, what are we shipping today.
user_invocable: true
---

# NemoClaw Maintainer Morning

Start the day: triage, pick a version target, label items, share the plan.

See [PR-REVIEW-PRIORITIES.md](../nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md) for the daily cadence and review priorities.

## Step 1: Determine Target Version and Stragglers

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-target.ts
```

This fetches tags, computes the next patch version, and finds open items still carrying older version labels. Surface stragglers first — the team needs to decide: relabel to today's target, or defer further.

## Step 2: Triage

Run the triage script to rank the full backlog:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/triage.ts --approved-only
```

If too few results, run without `--approved-only`. The script calls `gh-pr-merge-now --json`, enriches candidates with risky-area detection, and applies the scoring model documented in [PR-REVIEW-PRIORITIES.md](../nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md).

Also use `find-review-pr` to surface PRs with `security` + `priority: high` labels. Merge these into the candidate pool.

## Step 3: Label Version Targets

Present the ranked queue to the user. After they confirm which items to target, label them:

```bash
gh label create "<version>" --repo NVIDIA/NemoClaw --description "Release target" --color "1d76db" 2>/dev/null || true
gh pr edit <number> --repo NVIDIA/NemoClaw --add-label "<version>"
gh issue edit <number> --repo NVIDIA/NemoClaw --add-label "<version>"
```

## Step 4: Save State and Output the Plan

Pipe triage output into state:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/triage.ts \
  | node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts set-queue
```

Output the daily plan:

| Target | Item | Type | Owner | Next action |
|--------|------|------|-------|-------------|
| v0.0.8 | [#1234](https://github.com/NVIDIA/NemoClaw/pull/1234) | PR | @author | Run merge gate |
| v0.0.8 | [#1235](https://github.com/NVIDIA/NemoClaw/issues/1235) | Issue | unassigned | Needs PR |

Include: total items targeted, how many are PRs vs issues, how many are already merge-ready.

## Notes

- This skill runs once at the start of the day. Use `/nemoclaw-maintainer-day` during the day to execute.
- The target version label is the source of truth for "what we're shipping today."
- Stragglers from previous versions should be addressed first — they already slipped once.
