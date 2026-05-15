---
name: nemoclaw-pr-ci-loop
description: Persistent CI enforcement loop for a single NemoClaw PR. Monitors PR checks, waits for CodeRabbit E2E recommendations, triggers recommended tests, fixes failures, and loops until fully green. Designed for /loop usage. Use when user says "get CI green", "fix CI", "loop until green", "enforce CI", "keep going until tests pass", "CI loop", "make this PR green", or wants automated CI shepherding on a PR.
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---


<!-- markdownlint-disable MD022 MD026 MD031 MD032 MD036 MD040 MD058 -->

# NemoClaw PR CI Enforcement Loop

A persistent loop that shepherds a single PR to merge-ready health. Monitors checks, unresolved review threads, review decisions, CodeRabbit/E2E Advisor recommendations, and triggered E2E tests; diagnoses failures, applies safe fixes, and repeats until done.

**Designed for `/loop` usage** — e.g., `/loop 5m /nemoclaw-pr-ci-loop`

## When to Use

- After opening a PR and wanting all CI to go green without manual babysitting
- When PR checks are failing and you want automated fix-and-retry
- When you want E2E tests triggered and validated before merge
- When CodeRabbit has posted E2E recommendations and you want them actioned
- When you want the PR to terminate only after CI is green, workflows are clear, review threads are resolved, and E2E recommendations pass

## Constants

```
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
REPO="NVIDIA/NemoClaw"
```

## Inputs

The skill needs ONE of:
- A PR number (explicit)
- The current worktree (inferred from `pwd` + branch → open PR)

## Persistence: Checkpoint & Resume

See [references/checkpointing.md](references/checkpointing.md) for checkpoint and resume details.
## Looping Model

This skill is designed for the coding-agent harness to re-invoke it with `/loop` or by normal user request. Do not spawn a background process that tries to call an agent CLI; the correct CLI and invocation mechanism are harness-specific and can go stale.

Persist checkpoint state to disk, then exit whenever CI/E2E is still pending. On the next invocation, read the checkpoint and continue from the last observed state.

Suggested use:

```text
/loop 5m /skill:nemoclaw-pr-ci-loop <PR_NUMBER>
```

Manual re-invocation works the same way: "resume CI loop for PR <N>".

### Idempotency Rules

The skill MUST be safe to invoke multiple times while waiting:
- If `status == waiting_for_e2e` and the run is still in progress → just report status, don't re-trigger
- If `status == checking_pr_ci` and checks are still pending → just report, don't re-push
- Never trigger the same E2E run twice
- Never apply the same fix twice (check if HEAD already contains the fix)

### Idempotency Guarantee

The skill MUST be safe to invoke multiple times while waiting:
- If `status == waiting_for_e2e` and the run is still in progress → just report status, don't re-trigger
- If `status == checking_pr_ci` and checks are still pending → just report, don't re-push
- Never trigger the same E2E run twice
- Never apply the same fix twice (check if HEAD already contains the fix)

---

## State Tracking

Maintain a running log across loop iterations (persisted in checkpoint):

```
ITERATION: <N>
TIMESTAMP: <ISO>
ACTION: <what was done>
RESULT: <outcome>
```

At the end, this becomes the summary.

---

## Loop Phases

See [references/loop-phases.md](references/loop-phases.md) for detailed loop phases.
## Summary Format

```markdown
## PR #<N> CI Enforcement Summary

**Branch:** `<branch>`
**Total iterations:** <N>
**Duration:** <start> → <end>

### CI Checks: ✅ All Green
| Check | Status |
|-------|--------|
| checks | ✅ |
| dco-check | ✅ |
| commit-lint | ✅ |
| ... | ... |

### Review Threads: ✅ Clear
| Source | Status |
|--------|--------|
| Human review threads | ✅ none unresolved / explicitly deferred |
| CodeRabbit review threads | ✅ none blocking |
| Review decision | ✅ not CHANGES_REQUESTED |

### E2E Tests: ✅ All Green
| Job | Status | Triggered By |
|-----|--------|-------------|
| cloud-e2e | ✅ | CodeRabbit recommendation |
| sandbox-operations-e2e | ✅ | Path mapping (src/lib/onboard.ts) |
| device-auth-health-e2e | ✅ | Explicit (new test in PR) |

### Issues Found & Fixed
| # | Iteration | Issue | Fix | Commit |
|---|-----------|-------|-----|--------|
| 1 | 2 | biome lint: trailing comma | Removed trailing comma | abc1234 |
| 2 | 3 | E2E timeout: 15m too short | Bumped to 30m | def5678 |
| 3 | 5 | sandbox_exec: 000 in CI | Switched to SSH pattern | 2f47f5e |

### Waiting Periods
| Iteration | Waited For | Duration |
|-----------|-----------|----------|
| 1 | PR CI to complete | ~3 min |
| 4 | CodeRabbit review | ~5 min |
| 6 | E2E run 25445645261 | ~18 min |
```

---

## Loop Behavior Rules

1. **Always inspect PR checks first.** Even if the user asks about CodeRabbit, start by listing failing/pending workflows.
2. **Never loop faster than the CI can respond.** If checks are pending, report and wait.
3. **Only one fix per iteration.** Don't stack multiple fixes — push one, let CI validate, then address the next.
4. **Distinguish product bugs from test bugs.** If an E2E test fails due to a test infrastructure issue (not a product bug), fix the test. If it's a product bug, fix the product code.
5. **Don't force-push unless absolutely necessary** (repo rules may block it). Prefer fixup commits.
6. **Track everything.** Every action, every wait, every fix goes in the log.
7. **Exit conditions:**
   - ✅ All green (success)
   - ❌ Unfixable failure (report and ask user for input)
   - ❌ Max iterations exceeded (default: 20)
   - ❌ User interrupts

## Anti-patterns

- **Don't trigger E2E before PR CI is green** — waste of compute
- **Don't re-trigger an E2E that's still running** — check status first
- **Don't declare complete while review threads are unresolved** — fix safe items or mark blocked/deferred in the checkpoint
- **Don't churn on purely subjective CodeRabbit style comments** — ask whether to defer if they do not affect CI, correctness, security, or docs validity
- **Don't loop on a check that's been pending for >30 minutes** — flag it and ask user

## Checkpoint Cleanup

When the loop completes (all green) or is explicitly abandoned:

```bash
# On success: archive to completed/
mkdir -p ~/.nemoclaw/ci-loop/completed
mv ~/.nemoclaw/ci-loop/${PR_NUMBER}.json ~/.nemoclaw/ci-loop/completed/${PR_NUMBER}-$(date +%Y%m%d).json

# On explicit abandon:
rm ~/.nemoclaw/ci-loop/${PR_NUMBER}.json
```

Stale checkpoints (PR merged/closed) should be cleaned up on next invocation:
```bash
# Check if PR is still open
PR_STATE=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json state --jq '.state')
if [ "$PR_STATE" != "OPEN" ]; then
  rm ~/.nemoclaw/ci-loop/${PR_NUMBER}.json
  echo "PR #${PR_NUMBER} is ${PR_STATE} — removing stale checkpoint"
  exit 0
fi
```

## Integration with Other Skills

- Uses E2E Advisor / CodeRabbit recommendations for dispatch decisions.
- Uses current workflow definitions for dispatch mechanics.
- Uses GraphQL review threads for unresolved comment state.
- Complements `nemoclaw-pr-sweep` (sweep is breadth-first across PRs; this is depth-first on one PR).
- Can be followed by `nemoclaw-pr-review` for a deeper semantic review, but does not declare complete with unresolved blocking threads.
