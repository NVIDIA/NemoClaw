---
name: nemoclaw-maintainer-review-days-tag
description: Review every open PR carrying today's version-target label (the "day's tag"). Produces a single prioritized review queue showing CI status, CodeRabbit state, mergeability, reviewer decision, and recommended next action per PR. Use when you want to sweep the whole day's release target in one pass. Trigger keywords - review days tag, review todays tag, review days PRs, sweep version label, review release target, days tag review, review all targeted PRs, todays release review.
user_invocable: true
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---

# NemoClaw Maintainer: Review the Day's Tag

Sweep every open PR that carries today's version-target label (e.g. `v0.0.8`) and produce one consolidated review queue. Unlike `nemoclaw-maintainer-day` (which picks one item and acts) or `nemoclaw-pr-sweep` (which works over local worktrees), this skill produces a **read-only review pass** across the entire day's target.

Never merges. Never pushes. Only approves (or asks before approving) once per PR.

## When to Use

- After `/nemoclaw-maintainer-morning` has labeled the day's items — to review the whole batch at once
- Mid-day check-in: "where does the day's tag stand?"
- Before `/nemoclaw-maintainer-evening` — to decide which items need to slip to the next patch

## Prerequisites

- `gh` (GitHub CLI) authenticated
- Run from inside the NemoClaw repo (for tag resolution)

## Step 1: Resolve the Day's Tag

If the user passed an explicit version (`v0.0.8`), use it. Otherwise derive it the same way the morning/day skills do:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-day/scripts/version-target.ts
```

Take the `targetVersion` field from the JSON output.

## Step 2: Build the Review Queue

Run the review-sweep script:

```bash
node --experimental-strip-types --no-warnings \
  ~/.agent-local/agent/skills/nemoclaw-maintainer-review-days-tag/scripts/review-days-tag.ts <version>
```

(Optional flags: `--repo OWNER/REPO`, `--json` for raw output.)

The script:

1. Lists every open PR with the `<version>` label
2. For each PR, gathers: mergeability, status checks, CodeRabbit unresolved threads, reviewer decision, draft state, author, age, size
3. Classifies each PR into a **next-action bucket**:
   - `APPROVE` — all gates pass, no CodeRabbit blockers, not draft, not conflicted
   - `SALVAGE` — conflicts, narrow CI failure, or stale rebase
   - `CODERABBIT` — unresolved major/critical review threads
   - `WAIT` — CI still running or awaiting external checks
   - `CONTRIBUTOR` — needs author response (changes-requested, pending questions)
   - `DRAFT` — marked draft; skip unless promoted
   - `BLOCKED` — missing required checks (fork PR needing "Approve and run")

## Step 3: Present the Queue

Output a table sorted by recommended review order (APPROVE → SALVAGE → CODERABBIT → CONTRIBUTOR → WAIT → DRAFT → BLOCKED), then within each bucket by age (oldest first):

```markdown
### Day's tag review — v0.0.8 (N open PRs)

| Bucket | PR | Title | Author | CI | CR | Conflicts | Age | Next action |
|--------|----|-------|--------|----|----|-----------|-----|-------------|
| APPROVE | [#1476](https://…/1476) | disable remote uninstall fallback | @user | ✅ | ✅ | clean | 2d | Run merge-gate + approve |
| SALVAGE | [#1121](https://…/1121) | Landlock read-only /sandbox | @user | ❌ 1 flake | ✅ | clean | 6d | Rerun failing job |
| CODERABBIT | [#1300](https://…/1300) | … | @user | ✅ | ⚠ 2 major | clean | 3d | Address SSRF comment |
| WAIT | [#1501](https://…/1501) | … | @user | ⏳ | ✅ | clean | 4h | Re-check in 30m |
```

Follow with:

- **Approvals available:** list PRs in the APPROVE bucket that only need the final gate checker run
- **Stragglers risk:** count of PRs unlikely to land today (CODERABBIT + CONTRIBUTOR + BLOCKED)
- **Recommendation:** which PR to review first, using the same rules as `find-review-pr` (older, passing, smaller)

## Step 4: Optional Follow-Through

If the user says "run merge-gate on the APPROVE bucket," loop each PR through the gate checker:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number>
```

For anything that fails, route per [MERGE-GATE.md](../nemoclaw-maintainer-day/MERGE-GATE.md) and [SALVAGE-PR.md](../nemoclaw-maintainer-day/SALVAGE-PR.md).

## Stop and Ask When

- The day's tag has zero PRs (suggest `/nemoclaw-maintainer-morning` or confirm the target version)
- More than one PR targets the same issue — surface as a duplicate group (see `find-review-pr`) before recommending approvals
- A PR touches risky areas without tests — route to [TEST-GAPS.md](../nemoclaw-maintainer-day/TEST-GAPS.md) before approval

## Commit Hygiene

This skill is read-only; it should not stage or commit anything. If an approval is issued via `gh pr review --approve`, that happens through GitHub, not through a local commit.

## Notes

- Duplicate detection is handled by `nemoclaw-maintainer-find-review-pr` — if this skill surfaces two PRs linked to the same issue, say so and recommend running that skill.
- Size/complexity isn't scored here; use `triage.ts` for that. This skill is about **reviewability today**, not priority.
- PRs labeled with an older version (`v0.0.7` while today's target is `v0.0.8`) are handled by `bump-stragglers.ts` / morning standup, not here.
