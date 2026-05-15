# Loop Phases

<!-- markdownlint-disable MD022 MD031 MD032 MD040 MD058 -->


### Phase 0: Identify PR, Check Checkpoint, Gather State

```bash
# If not given a PR number, infer from current worktree
WORKTREE_PATH="${WORKTREE_PATH:-$(pwd)}"
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
