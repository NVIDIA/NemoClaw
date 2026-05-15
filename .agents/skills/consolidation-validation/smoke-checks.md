# Consolidated NemoClaw Skills Smoke Checks

Use these lightweight checks when editing the consolidated skills. They cover representative activation, happy path, and blocker/safety behavior without requiring destructive GitHub actions.

## Activation checks

- `nemoclaw-pr-ci-loop`: invoke on an open PR and confirm it checks PR status before CodeRabbit/E2E work.
- `nemoclaw-maintainer-review-days-tag`: invoke with a version label and confirm it emits a prioritized read-only queue.
- `nemoclaw-e2e-health-review`: invoke from a NemoClaw worktree and confirm it discovers workflows from `.github/workflows` at runtime.

## Script smoke checks

```bash
python3 -m py_compile .agents/skills/nemoclaw-sprint-review/collect_sprint_items.py
node --experimental-strip-types --no-warnings --check \
  .agents/skills/nemoclaw-maintainer-review-days-tag/scripts/review-days-tag.ts
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-review-days-tag/scripts/review-days-tag.ts \
  v0.0.8 --repo NVIDIA/NemoClaw --json --viewer __smoke_test__ \
  | python3 -m json.tool >/dev/null
```

## Happy path checks

- `nemoclaw-pr-ci-loop`: when checks are green, unresolved review threads are zero, review decision is approved/non-blocking, and E2E recommendations are handled, the skill reports merge-ready and stops.
- `nemoclaw-pr-maintenance-loop`: when multiple authored PRs exist, it selects the highest-value actionable PR and applies at most one safe fix per pass.
- `nemoclaw-pr-e2e-loop`: when a bug-fix PR lacks coverage, it proposes PR-A/PR-B, requires checkpoint approval, and verifies RED on main-equivalent before GREEN on PR-A.

## Blocker and safety checks

- Required checks pending: `nemoclaw-pr-ci-loop` waits and does not inspect lower-priority work.
- Review decision is `CHANGES_REQUESTED`: `nemoclaw-pr-ci-loop` reports blocked unless the current safe local fix can address explicit review feedback.
- Missing E2E advisor recommendation: `nemoclaw-pr-ci-loop` triggers only recommended/approved workflows and records the run.
- Maintainer review-day sweep: never merges, never pushes, and excludes the authenticated user's PRs unless `--include-mine` is explicitly passed.
- Worktree cleanup: validates the configured worktree base before deleting anything.
