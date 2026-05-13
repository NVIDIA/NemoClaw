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

The loop MUST survive session death. All state is checkpointed to disk.

### Checkpoint File

```
~/.nemoclaw/ci-loop/<PR_NUMBER>.json
```

Schema:
```json
{
  "pr": 3128,
  "branch": "issue-2342-brev-launchable-version-pin-and-gateway-token",
  "worktree": "${NEMOCLAW_WORKTREE_BASE}/issue-2342",
  "started": "2026-05-06T15:00:00Z",
  "iteration": 5,
  "status": "waiting_for_e2e",
  "waiting_for": {
    "type": "e2e_run",
    "run_id": 25445645261,
    "jobs": ["device-auth-health-e2e", "cloud-e2e"],
    "triggered_at": "2026-05-06T15:44:50Z"
  },
  "coderabbit_e2e_jobs": ["cloud-e2e", "sandbox-operations-e2e"],
  "e2e_triggered": true,
  "fixes_applied": [
    {
      "iteration": 2,
      "timestamp": "2026-05-06T15:10:00Z",
      "issue": "E2E timeout: 15m too short for cold Docker build",
      "fix": "Bumped workflow timeout to 30m, script timeout to 1200s",
      "commit": "e0c18a201"
    }
  ],
  "log": [
    {"iteration": 1, "timestamp": "...", "action": "...", "result": "..."}
  ]
}
```

### On Startup: Always Check for Existing Checkpoint

```bash
CHECKPOINT="$HOME/.nemoclaw/ci-loop/${PR_NUMBER}.json"
if [ -f "$CHECKPOINT" ]; then
  # RESUME from where we left off
  # Read status, iteration, waiting_for, etc.
else
  # FRESH START — create new checkpoint
fi
```

**The first thing this skill does on EVERY invocation is check for a checkpoint.**
If one exists, it resumes. If not, it starts fresh.

### Status Values

| Status | Meaning | Next Action |
|--------|---------|-------------|
| `checking_pr_ci` | Waiting for PR checks to complete | Poll `gh pr checks` |
| `fixing_ci` | Actively fixing a failure | Apply fix, push, update to `checking_pr_ci` |
| `checking_review_threads` | CI green, checking unresolved review threads and review decision | Query GraphQL review threads + reviews |
| `fixing_review_feedback` | Safe review-thread fix is being applied | Apply fix, push, update to `checking_pr_ci` |
| `waiting_for_coderabbit` | PR CI green and blocking review feedback clear, waiting for CodeRabbit E2E comment | Poll PR comments |
| `triggering_e2e` | About to dispatch E2E | Dispatch, record run_id, update to `waiting_for_e2e` |
| `waiting_for_e2e` | E2E dispatched, waiting for results | Poll run status |
| `fixing_e2e` | E2E failed, applying fix | Apply fix, push, update to `checking_pr_ci` |
| `complete` | CI green, review threads clear, E2E recommendations passing | Produce summary, delete checkpoint |
| `blocked` | Unfixable failure, needs human | Report and stop |

### Checkpoint Updates

Write the checkpoint after EVERY state transition:
- After pushing a fix
- After triggering an E2E run
- After detecting a new failure
- After confirming a check passed
- After detecting unresolved review feedback
- After resolving or explicitly deferring a review thread

---

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

### Phase 0: Identify PR, Check Checkpoint, Gather State

```bash
# If not given a PR number, infer from current worktree
cd "$WORKTREE_PATH"
BRANCH=$(git branch --show-current)
PR_NUMBER=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number')

# CHECK FOR EXISTING CHECKPOINT (resume support)
CHECKPOINT="$HOME/.nemoclaw/ci-loop/${PR_NUMBER}.json"
if [ -f "$CHECKPOINT" ]; then
  echo "Resuming from checkpoint (iteration $(jq .iteration $CHECKPOINT))..."
  # Read: status, waiting_for, fixes_applied, e2e_triggered, etc.
  # Jump to the appropriate phase based on status
fi

# Gather full PR state. Always do this before inspecting CodeRabbit or E2E.
PR_DATA=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json \
  number,title,headRefName,statusCheckRollup,comments,reviews,files)

# Summarize current checks from statusCheckRollup so failures are visible even
# when the user originally asked about review feedback.
echo "$PR_DATA" | jq -r '
  .statusCheckRollup[]?
  | select(.name != null)
  | [.name, (.status // ""), (.conclusion // ""), (.detailsUrl // "")]
  | @tsv'
```

**Resume routing based on checkpoint status:**
| Checkpoint Status | Jump To |
|-------------------|---------|
| `checking_pr_ci` | Phase 1 |
| `checking_review_threads` | Phase 2 |
| `fixing_review_feedback` | Phase 3 |
| `waiting_for_coderabbit` | Phase 4 |
| `waiting_for_e2e` | Phase 6 |
| `fixing_ci` / `fixing_e2e` | Phase 3 (re-check if fix was pushed) |
| `complete` | Phase 7 (re-display summary) |

### Phase 1: Check PR CI Status

```bash
# Get all check statuses. Run this on every invocation before CodeRabbit/E2E work.
gh pr checks "$PR_NUMBER" --repo "$REPO" --watch=false || true

# Machine-readable failure/pending split.
gh pr view "$PR_NUMBER" --repo "$REPO" --json statusCheckRollup --jq '
  .statusCheckRollup[]?
  | select(.name != null)
  | select(.status != "COMPLETED" or (.conclusion != "SUCCESS" and .conclusion != "SKIPPED" and .conclusion != null))
  | {name, status, conclusion, detailsUrl}'
```

Classify each check:
- ✅ **PASS** — no action needed
- ❌ **FAIL** — needs diagnosis and fix
- 🔄 **PENDING/IN_PROGRESS** — wait (do not take action yet)
- ⏭ **SKIPPED** — ignore

**If any checks are PENDING/IN_PROGRESS → report status and WAIT for next loop iteration.**

**If any checks FAIL → proceed to Phase 3 (Fix CI). Do not inspect only CodeRabbit feedback while checks are red.**

**Only if all non-skipped checks PASS → proceed to Phase 2.**

This ordering is mandatory: PR check failures (`checks`, `markdown-links`, `commit-lint`, etc.) take priority over CodeRabbit comments and E2E recommendations.

### Phase 2: Review Thread and Review Decision Gate

After PR CI is green, verify that review state is also clear before moving to E2E. This includes human review threads and CodeRabbit review threads, not only top-level PR comments.

```bash
# Review decision must not be blocking.
gh pr view "$PR_NUMBER" --repo "$REPO" --json reviewDecision,isDraft,mergeStateStatus \
  --jq '{reviewDecision, isDraft, mergeStateStatus}'

# Unresolved review threads. Use GraphQL because REST review comments do not expose resolved state.
gh api graphql -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      isDraft
      reviewDecision
      mergeStateStatus
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 20) {
            nodes {
              id
              author { login }
              path
              line
              body
            }
          }
        }
      }
    }
  }
}' -f owner=NVIDIA -f repo=NemoClaw -F pr="$PR_NUMBER" \
  --jq '.data.repository.pullRequest as $pr
        | {
            isDraft: $pr.isDraft,
            reviewDecision: $pr.reviewDecision,
            mergeStateStatus: $pr.mergeStateStatus,
            unresolvedThreads: [
              $pr.reviewThreads.nodes[]
              | select(.isResolved == false)
              | {latest: (.comments.nodes[-1] // {}), comments: .comments.nodes}
            ]
          }'
```

Classify review state:

- ✅ **CLEAR** — no unresolved threads, not draft, no `CHANGES_REQUESTED` decision.
- ❌ **BLOCKING** — `reviewDecision == "CHANGES_REQUESTED"`, unresolved human thread, or unresolved critical/major CodeRabbit thread.
- 🟡 **NON-BLOCKING / DEFERABLE** — unresolved style/nit comment that user explicitly chooses to defer.
- 🔄 **WAITING** — reviewer asked a question or requested confirmation; stop and report.

Rules:

1. If `isDraft == true`, report blocked; do not declare complete.
2. If `reviewDecision == "CHANGES_REQUESTED"`, inspect unresolved threads and either fix or report blocked.
3. If any unresolved human review thread exists, fix safe/mechanical requests; otherwise report blocked with thread URLs/context.
4. If unresolved CodeRabbit thread exists:
   - fix critical/major correctness, security, CI, docs-link, or lint issues;
   - fix trivial formatting/style only if it is causing CI or is obviously safe;
   - otherwise summarize and ask whether to defer.
5. After applying any review-thread fix, push and return to Phase 1.
6. Only proceed to Phase 4 when review threads are clear or explicitly deferred by the user in the checkpoint.

### Phase 3: Fix Failing CI or Review Feedback

For each failing check or blocking review thread:

#### 3a: Get failure logs

List every failing check first; do not stop after the first failure unless applying a one-fix-per-iteration change.

```bash
FAILED_CHECKS=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json statusCheckRollup --jq '
  [.statusCheckRollup[]?
   | select(.name != null)
   | select(.status == "COMPLETED" and (.conclusion != "SUCCESS" and .conclusion != "SKIPPED" and .conclusion != null))
   | {name, conclusion, detailsUrl}]')
echo "$FAILED_CHECKS" | jq -r '.[] | [.name, .conclusion, .detailsUrl] | @tsv'

# For GitHub Actions checks, inspect each failing run/job URL.
echo "$FAILED_CHECKS" | jq -r '.[].detailsUrl // empty' | while read -r URL; do
  RUN_ID=$(echo "$URL" | grep -oE 'runs/[0-9]+' | head -1 | cut -d/ -f2)
  if [ -n "$RUN_ID" ]; then
    echo "===== run $RUN_ID ====="
    gh run view "$RUN_ID" --repo "$REPO" --log-failed 2>&1 | tail -120
  fi
done
```

#### 3b: Diagnose the failure

Common failure categories and actions:

| Failure Pattern | Diagnosis | Fix Action |
|----------------|-----------|------------|
| `commitlint` / commit message | Bad commit message format | Interactive rebase to fix message |
| `tsc --noEmit` / type errors | TypeScript compile error | Fix the type error in source |
| `biome check` / lint errors | Formatting or lint violation | Run `npx biome check --write` |
| `vitest` / unit test failure | Test assertion broken | Read test, understand failure, fix code or test |
| `shellcheck` | Shell script lint | Fix the shellcheck warning |
| `markdown-links` | Broken Markdown link / anchor / file reference | Fix or remove the broken link/reference |
| `checks` | Aggregate repo checks; inspect failed sub-step in run logs | Fix underlying lint/test/build failure |
| `build-sandbox-images` | Docker build error | Fix Dockerfile or build deps |
| `dco-check` | Missing sign-off | `git commit --amend -s` |
| E2E timeout | Test took too long | Increase timeout or optimize |
| E2E assertion failure | Product bug or test bug | Analyze logs, fix product or test code |

#### 3c: Apply the fix

1. Make the code change
2. Commit with appropriate conventional commit message
3. Push to the PR branch

```bash
git add <files>
git commit -m "fix(<scope>): <description of fix>"
git push origin "$BRANCH"
```

#### 3d: Log the fix

Record in the running log:
```
ITERATION: 2
TIMESTAMP: 2026-05-06T16:00:00Z
ACTION: Fixed biome lint error in src/lib/verify-deployment.ts (trailing comma)
RESULT: Pushed commit abc1234, waiting for CI re-run
```

**After pushing → immediately re-run Phase 1 once to report the new check state, then WAIT for next loop iteration** (CI will re-trigger and may be pending).

### Phase 4: CodeRabbit / E2E Advisor Recommendations

After PR CI is green and review threads are clear/deferred, check for CodeRabbit's E2E recommendations.

```bash
# Look for CodeRabbit comments recommending E2E tests
gh pr view "$PR_NUMBER" --repo "$REPO" --json comments \
  --jq '.comments[] | select((.author.login // "") | test("(?i)coderabbit")) | .body'   \
  | grep -i "e2e\|nightly\|workflow"
```

#### If CodeRabbit has NOT commented yet

- Report "Waiting for CodeRabbit review with E2E recommendations"
- **WAIT for next loop iteration**

#### If CodeRabbit/E2E Advisor has commented with E2E recommendations

Extract recommended workflow and job names from the current comments. Validate each name against current workflow files before dispatching.

If recommendations are missing or ambiguous, derive a fallback from current repo state instead of a hardcoded path-to-job table:

```bash
# Changed files
FILES=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json files --jq '.files[].path')

# Current workflow jobs and dispatch inputs
rg -n "^[[:space:]]+[A-Za-z0-9_-]+:" .github/workflows/*e2e*.yaml
rg -n "workflow_dispatch|inputs:|jobs:" .github/workflows/*e2e*.yaml

# Current advisor config, if present
test -f .coderabbit.yaml && rg -n "e2e|nightly|workflow|path" .coderabbit.yaml
```

Map changed paths to jobs only after reading the current workflows/advisor config.

### Phase 5: Trigger E2E Tests

Once PR CI is green, blocking review threads are clear/deferred, and CodeRabbit/E2E Advisor recommendations are known:

```bash
# Trigger selective nightly dispatch
BRANCH=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefName --jq '.headRefName')
JOBS="job1,job2,job3"  # From CodeRabbit + path mapping

gh workflow run nightly-e2e.yaml --repo "$REPO" \
  --ref "$BRANCH" -f jobs="$JOBS"
```

Track which E2E jobs were triggered and their run IDs:

```bash
sleep 10
RUN_ID=$(gh run list --repo "$REPO" --workflow=nightly-e2e.yaml \
  --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')
```

### Phase 6: Monitor E2E Results

```bash
gh run view "$RUN_ID" --repo "$REPO" --json status,conclusion,jobs \
  --jq '{status, conclusion, jobs: [.jobs[] | select(.conclusion != "skipped") | {name, status, conclusion}]}'
```

- **If still running → WAIT for next loop iteration**
- **If all passed → proceed to Phase 7 (Done)**
- **If any failed → go back to Phase 3 with E2E failure logs**

For E2E failures, get logs:
```bash
gh run view "$RUN_ID" --repo "$REPO" --log-failed 2>&1 | tail -100
```

### Phase 7: All Green — Summary

When ALL of the following are true:

- ✅ All PR CI checks passing.
- ✅ No failed or pending required workflows remain in `statusCheckRollup`.
- ✅ PR is not draft.
- ✅ Review decision is not `CHANGES_REQUESTED`.
- ✅ No unresolved blocking human review threads remain.
- ✅ No unresolved blocking CodeRabbit review threads remain.
- ✅ CodeRabbit/E2E Advisor recommendations have been triggered, explicitly deemed unnecessary, or explicitly deferred by the user.
- ✅ All triggered E2E jobs are passing.

**Only then EXIT the loop** and produce the final summary. If any item is unknown, do not mark complete; report `blocked` or continue waiting.

---

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
4. **Don't force-push unless absolutely necessary** (repo rules may block it). Prefer fixup commits.
5. **Track everything.** Every action, every wait, every fix goes in the log.
6. **Exit conditions:**
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
