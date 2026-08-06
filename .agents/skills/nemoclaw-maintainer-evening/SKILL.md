---
name: nemoclaw-maintainer-evening
description: Closes the 4 PM NemoClaw release edition, verifies pre-cutoff changelog readiness, reports shipped work and stragglers, starts the advisory overnight E2E and fix loop, and prepares the frozen handoff. Use at end of day, edition close, EOD, release freeze, or overnight QA handoff.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer Evening

Close the edition at 4:00 PM `America/Los_Angeles`. Do not cut the tag in this skill; the scheduled 4:00 AM workflow owns the normal cut.

Read [PR-REVIEW-PRIORITIES.md](../nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md) and the [release train](../nemoclaw-maintainer-policies/references/release-train.md).

## 1. Check Progress

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-target.ts
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-progress.ts <version>
```

Present merged labeled PRs as the edition contents. List open labeled PRs and issues as stragglers that post-tag housekeeping will move to the next patch label.

## 2. Finish Pre-Tag Docs

Run `/nemoclaw-contributor-update-docs for <version>` early enough for its PR to merge before cutoff. Require one direct `docs/changelog/YYYY-MM-DD.mdx` child containing the exact `## <version>` heading, parser-safe SPDX comment, summary, and detailed bullets. No waiver exists.

## 3. Freeze and Stop Merging

At 4:00 PM, announce that the edition is closed and merging remains stopped until 8:00 AM. The scheduled `release-edition-close.yaml` run at 4:17 PM must upload `release-edition-plan-YYYY-MM-DD`.

Inspect its summary and record:

- frozen candidate SHA;
- `ready` or `no-changes` status;
- previous and next tags;
- changelog match; and
- plan hash.

Do not advance the candidate if `main` moves after cutoff. A late merge belongs to the next edition.

## 4. Start the Advisory Overnight Loop

Run the handoff summary:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary.ts
```

Assign one agent to remain active through the 8:00 AM handoff. Load `nemoclaw-maintainer-e2e`. Inventory every E2E run triggered by the edition's `main` pushes and every workflow E2E selected in those runs, including automatic retry evidence and selective reruns, then classify failures, consolidate duplicates, delete stale tests when justified, and prepare focused fix PRs. Include exact-SHA post-merge advisor runs. After each diagnosis, rerun, or prepared fix, immediately select the next actionable failure. Do not merge fixes during the freeze and do not stop the loop when the 4:00 AM tag is cut.

E2E does not authorize or block the 4:00 AM tag. Do not build a release evidence ledger or request exceptions.

## 5. Publish the Overnight Handoff

Provide:

- target version and frozen SHA;
- shipped PRs and open stragglers;
- QA focus areas;
- exact-SHA agent-review runs and actionable findings;
- E2E failures, classifications, reruns, and prepared fixes; and
- carry-forward and released-label retirement state;
- the expected 4:00 AM cut and 8:00 AM handoff checkpoints.

Name the overnight agent owner and the 8:00 AM handoff destination. If the agent cannot continue, transfer the same state to one replacement instead of starting competing loops.

Save state:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts history "edition-closed" "<version>" "froze <sha>; shipped N; carried M"
```

Escalate a failed changelog, plan provenance, ancestry, signing, collision, `latest`, `lkg`, or housekeeping invariant. Report E2E failures as advisory work, not release blockers.
