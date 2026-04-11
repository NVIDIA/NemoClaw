---
name: nemoclaw-maintainer-day
description: Runs the daytime maintainer loop for NemoClaw, prioritizing items labeled with the current version target. Picks the highest-value item, executes the right workflow (merge gate, salvage, security sweep, test gaps, hotspot cooling, or sequencing), and reports progress. Use during the workday to land PRs and close issues. Designed for /loop (e.g. /loop 10m /nemoclaw-maintainer-day). Trigger keywords - maintainer day, work on PRs, land PRs, make progress, what's next, keep going, maintainer loop.
user_invocable: true
---

# NemoClaw Maintainer Day

Execute one pass of the maintainer loop, prioritizing version-targeted work.

**Autonomy:** push small fixes and approve when gates pass. Never merge. Stop and ask for merge decisions, architecture decisions, and unclear contributor intent.

## References

- PR review priorities: [PR-REVIEW-PRIORITIES.md](PR-REVIEW-PRIORITIES.md)
- Risky code areas: [RISKY-AREAS.md](RISKY-AREAS.md)
- State schema: [STATE-SCHEMA.md](STATE-SCHEMA.md)

## Step 1: Check Version Progress

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-target.ts
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-progress.ts <version>
```

The first script determines the target version. The second shows shipped vs open.

## Step 2: Pick One Action

From the open version-targeted items, pick the highest-value one:

1. **Ready-now PR** — green CI, no conflicts, no major CodeRabbit, has tests → follow [MERGE-GATE.md](MERGE-GATE.md)
2. **Salvage-now PR** — close to ready, needs small fix → follow [SALVAGE-PR.md](SALVAGE-PR.md)
3. **Security item** — touches risky areas → follow [SECURITY-SWEEP.md](SECURITY-SWEEP.md)
4. **Test-gap item** — risky code with weak tests → follow [TEST-GAPS.md](TEST-GAPS.md)
5. **Hotspot cooling** — repeated conflicts → follow [HOTSPOTS.md](HOTSPOTS.md)
6. **Sequencing needed** — too large for one pass → follow [SEQUENCE-WORK.md](SEQUENCE-WORK.md)

If all version-targeted items are blocked, fall back to the general backlog. Productive work on non-labeled items is better than waiting.

Prefer finishing one almost-ready contribution over starting a new refactor.

## Step 3: Execute

Follow the chosen workflow document. A good pass ends with one of:

- a PR approved, a fix pushed, a test gap closed, a hotspot mitigated, or a blocker surfaced.

## Step 4: Report Progress

Re-run the progress script and show the update:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-progress.ts <version>
```

If all version-targeted items are done, suggest running `/nemoclaw-maintainer-evening` early.

Update `.nemoclaw-maintainer/state.json` via the state script:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts history <action> <item> "<note>"
```

## Commit Hygiene

The prek "Regenerate agent skills from docs" hook auto-stages `.agents/skills/` files. Before every `git add` and `git commit` on a PR branch, run `git reset HEAD .agents/skills/nemoclaw-maintainer-*` to unstage them. Only commit skill files in dedicated skill PRs.

## Stop and Ask When

- Broad refactor or architecture decision needed
- Contributor intent unclear and diff would change semantics
- Multiple subsystems must change for CI
- Sensitive security boundaries with unclear risk
- Next step is opening a new PR or merging

## /loop Integration

Designed for `/loop 10m /nemoclaw-maintainer-day`. Each pass should produce compact output: what was done, what changed, what needs the user. Check `state.json` history to avoid re-explaining prior context on repeat runs.
