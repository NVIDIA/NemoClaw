---
name: nemoclaw-maintainer-day
description: Run one NemoClaw daytime maintainer pass. Prioritize items for the release version. Select a merge, salvage, security, test, conflict, or sequencing workflow and report progress. Use during the workday to land PRs and close issues. Designed for /loop, for example /loop 10m /nemoclaw-maintainer-day. Trigger keywords - maintainer day, work on PRs, land PRs, make progress, what's next, keep going, maintainer loop.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer Day

Execute one pass of the maintainer loop, prioritizing version-targeted work.

**Autonomy:** You may push small fixes. You may approve a PR when all gates pass.
Report contributor and approver overlap as an advisory. It does not change merge readiness or require another reviewer.
Never merge. Ask the user about merge, product-scope, and architecture decisions. Also ask when contributor intent is unclear.

## References

- PR review priorities: [PR-REVIEW-PRIORITIES.md](PR-REVIEW-PRIORITIES.md)
- Risky code areas: [RISKY-AREAS.md](RISKY-AREAS.md)
- State schema: [STATE-SCHEMA.md](STATE-SCHEMA.md)

## Step 1: Check Version Progress

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-target.ts
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-progress.ts <version>
```

The first script selects the target version. The second lists shipped and open items.

## Step 2: Pick One Action

Select the first applicable action for an open item:

1. **PR ready for approval** — CI passes, no conflicts remain, and tests cover the change.
   Confirm that there is no unresolved correctness or security issue. Follow [MERGE-GATE.md](MERGE-GATE.md).
2. **PR that needs a small fix** — Follow [SALVAGE-PR.md](SALVAGE-PR.md).
3. **Security item** — The item touches a risky area. Follow [SECURITY-SWEEP.md](SECURITY-SWEEP.md).
4. **Test gap** — Risky code does not have sufficient tests. Follow [TEST-GAPS.md](TEST-GAPS.md).
5. **Repeated conflicts** — Follow [HOTSPOTS.md](HOTSPOTS.md).
6. **Work that needs sequencing** — The work is too large for one pass. Follow [SEQUENCE-WORK.md](SEQUENCE-WORK.md).

If all items for the release version are blocked, select an item from the backlog.

Prefer to complete a contribution that needs little work before you start a refactor.

## Step 3: Execute

Follow the selected workflow. Complete one outcome in each pass:

- Approve a PR.
- Push a fix.
- Add a missing test.
- Reduce a source of merge conflicts.
- Report a blocker.

## Step 4: Report Progress

Re-run the progress script and show the update:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-progress.ts <version>
```

If all items for the release version are done, suggest `/nemoclaw-maintainer-evening`.

Update `.nemoclaw-maintainer/state.json` via the state script:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts history <action> <item> "<note>"
```

## Commit Hygiene

Commit skill files only when the task changes agent guidance.
Do not include unrelated skill changes in code or documentation PRs.

## Stop and Ask When

- A PR creates a supported product surface without an accepted product decision.
- The work requires a refactor or architecture decision.
- Contributor intent is unclear and the change can alter behavior.
- CI requires changes to multiple subsystems.
- A security boundary has an unclear risk.
- The next step is to open a PR or merge.

## /loop Integration

Use this skill with `/loop 10m /nemoclaw-maintainer-day`.
Keep each pass report short. State what you did, what changed, and what needs a user decision.
Read `state.json` to avoid repeated context.
