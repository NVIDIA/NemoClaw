---
name: nemoclaw-pr-maintenance-loop
description: Always-on maintenance loop for your open NemoClaw PRs. Discovers authored PRs, prioritizes unresolved human review comments, unresolved CodeRabbit comments, failing CI/CD workflows, and missing/unaddressed E2E advisor recommendations, then works one highest-value PR per pass. Designed for /loop usage or an optional checkpoint-gated background watcher.
user_invocable: true
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---


<!-- markdownlint-disable MD022 MD026 MD031 MD032 MD036 MD040 MD058 -->

# NemoClaw PR Maintenance Loop

Always-on breadth-first PR maintenance for **your authored open PRs**. Each invocation is one idempotent pass: discover PRs, rank them by actionable feedback, work the highest-priority item, persist state, and exit cleanly so `/loop` can call it again.

Use this when the user wants to keep all personal NemoClaw PRs healthy: reviewer feedback addressed, CodeRabbit comments resolved, CI green, and E2E advisor recommendations actioned.

## Related Skills

- `nemoclaw-pr-sweep`: batch sweep across active worktrees; this skill turns that into a persistent prioritized loop.
- `nemoclaw-pr-ci-loop`: single-PR CI/E2E checkpoint and watcher model; this skill borrows the persistence pattern.
- E2E Advisor / CodeRabbit recommendations: PR-specific E2E decision source.
- `nemoclaw-pr-review`: deep review; use when the loop finds a risky/semantic change.

## Constants

```bash
: "${NEMOCLAW_WORKTREE_BASE:?NEMOCLAW_WORKTREE_BASE must be set}"
: "${NEMOCLAW_REPO:?NEMOCLAW_REPO must be set}"
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
MAIN_REPO="${NEMOCLAW_REPO}"
REPO="${NEMOCLAW_GITHUB_REPO:-NVIDIA/NemoClaw}"
STATE_DIR="${NEMOCLAW_PR_MAINTENANCE_STATE_DIR:-$HOME/.nemoclaw/pr-maintenance-loop}"
STATE_FILE="${NEMOCLAW_PR_MAINTENANCE_STATE_FILE:-$STATE_DIR/state.json}"
LOCKFILE="${NEMOCLAW_PR_MAINTENANCE_LOCKFILE:-$STATE_DIR/loop.lock}"
PIDFILE="${NEMOCLAW_PR_MAINTENANCE_PIDFILE:-$STATE_DIR/watcher.pid}"
LOGFILE="${NEMOCLAW_PR_MAINTENANCE_LOGFILE:-$STATE_DIR/watcher.log}"
INTERVAL="${NEMOCLAW_PR_MAINTENANCE_INTERVAL:-600}"  # 10 minutes by default
```

## Invocation Patterns

Preferred interactive loop:

```text
/loop 10m /skill:nemoclaw-pr-maintenance-loop
```

One-shot pass:

```text
/skill:nemoclaw-pr-maintenance-loop
```

Do not spawn a background watcher from the skill. Agent CLI names and flags are user-environment-specific and go stale; use the harness `/loop` mechanism for persistence.

## State and Idempotency

Create/update `$STATE_FILE` on every pass. The loop must be safe to invoke repeatedly.

Suggested schema:

```json
{
  "started": "2026-05-12T00:00:00Z",
  "lastPass": "2026-05-12T00:10:00Z",
  "iteration": 3,
  "lastPr": 3128,
  "cooldowns": {
    "3128:e2e:cloud-e2e": "2026-05-12T00:05:00Z"
  },
  "history": [
    {
      "timestamp": "2026-05-12T00:10:00Z",
      "pr": 3128,
      "action": "fixed_coderabbit_comment",
      "result": "pushed abc1234"
    }
  ]
}
```

Concurrency rule:

At startup, acquire a non-blocking lock. If another pass is still running, **skip this interval immediately** and let `/loop` try again at the next scheduled interval. Do not queue, wait, or start a second pass.

```bash
mkdir -p "$STATE_DIR"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "Another PR maintenance pass is still running; skipping this interval."
  exit 0
fi
```

The lock is released automatically when the process exits.

Idempotency rules:

1. Do not trigger the same E2E job twice for the same HEAD SHA.
2. Do not apply the same suggestion twice; check current file contents first.
3. Do not push when the worktree is dirty with unrelated user changes.
4. If checks are pending, record `waiting` and exit; the next loop pass will resume.
5. Work **one PR / one coherent action** per pass unless the action is purely read-only.

## Step 0: Setup

```bash
mkdir -p "$STATE_DIR"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "Another PR maintenance pass is still running; skipping this interval."
  exit 0
fi
GH_USER=$(gh api user --jq '.login')
```

If `$STATE_FILE` does not exist, initialize it:

```bash
cat > "$STATE_FILE" <<EOF
{"started":"$(date -Iseconds)","lastPass":null,"iteration":0,"lastPr":null,"cooldowns":{},"history":[]}
EOF
```

## Step 1: Discover Your Open PRs

Use GitHub as source of truth; do not rely only on local worktrees.

```bash
gh pr list --repo "$REPO" --author "$GH_USER" --state open \
  --json number,title,headRefName,updatedAt,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,comments,reviews,labels,files \
  --limit 100
```

Skip merged/closed PRs and normally skip drafts unless they have failing CI or explicit review comments that need cleanup.

## Step 2: Ensure Local Worktree Exists for Actionable PRs

For a selected PR, use an existing worktree if present; otherwise create one under `NemoClaw-working/pr-<number>`.

```bash
PR_NUMBER=<number>
BRANCH=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefName --jq '.headRefName')
WORKTREE="$WORKTREE_BASE/pr-$PR_NUMBER"

if [ ! -d "$WORKTREE/.git" ] && [ ! -f "$WORKTREE/.git" ]; then
  git -C "$MAIN_REPO" fetch origin "$BRANCH"
  git -C "$MAIN_REPO" worktree add "$WORKTREE" "FETCH_HEAD"
fi

cd "$WORKTREE"
git config user.name  "$(git -C "$MAIN_REPO" config user.name)"
git config user.email "$(git -C "$MAIN_REPO" config user.email)"
git config user.signingkey "$(git -C "$MAIN_REPO" config user.signingkey)"
git config commit.gpgsign "$(git -C "$MAIN_REPO" config commit.gpgsign)"
git config gpg.format "$(git -C "$MAIN_REPO" config gpg.format)"
```

If `git status --porcelain` is non-empty before this skill makes changes, first determine whether it is leftover loop state or unrelated user work:

- If a rebase/merge/cherry-pick is in progress from a prior loop pass, abort it and reset to the remote PR branch before continuing.
- If the only changes are generated by the current pass, either commit them or reset them before exit.
- If there are unrelated user edits, skip and report the dirty worktree; never overwrite user work.

Do not confuse local dirty worktrees with GitHub `mergeStateStatus=DIRTY`; GitHub `DIRTY` means the PR cannot currently merge cleanly or needs base integration and should be handled by the merge-conflict path below.

## Step 3: Score and Prioritize PRs

Compute an actionable score for every authored open PR. Highest score wins.

| Condition | Score | Notes |
|---|---:|---|
| Human `CHANGES_REQUESTED` unresolved thread | +100 | Highest priority; may block merge. |
| Failing required CI/CD check | +90 | Fix before E2E. |
| Unresolved human review comment | +80 | Use GraphQL review threads. |
| Unresolved CodeRabbit comment | +60 | Apply safe suggestions automatically. |
| CodeRabbit/E2E advisor recommendation not triggered for HEAD SHA | +50 | Trigger after normal CI is green. |
| GitHub `mergeable=CONFLICTING` or `mergeStateStatus=DIRTY` | +45 | Attempt conflict-aware base integration; resolve safe conflicts. |
| Branch behind `origin/main` | +30 | Rebase if clean; use conflict-aware path if not. |
| Pending checks | +10 | Report/wait; no duplicate action. |
| Merge-ready | +5 | Report as ready; do not merge without user. |

Tie-breakers:

1. Oldest `updatedAt` first.
2. Non-draft before draft.
3. PRs not touched in recent `state.history` before recently touched PRs.

## Step 4: Gather Signals for a PR

### Human Review Threads

```bash
gh api graphql -f owner=NVIDIA -f repo=NemoClaw -F pr="$PR_NUMBER" -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewDecision
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 20) {
            nodes {
              author { login }
              body
              path
              line
              createdAt
            }
          }
        }
      }
    }
  }
}'
```

Treat unresolved non-`coderabbitai` threads as human feedback. If the latest comment is from you and explains a fix, do not repeatedly act; mark as waiting.

### CodeRabbit Comments

```bash
gh api "repos/$REPO/pulls/$PR_NUMBER/comments" --paginate \
  --jq '[.[] | select(.user.login == "coderabbitai") | {id, path, line, body, diff_hunk, created_at}]'
```

Also inspect GraphQL unresolved threads because REST comment objects may not expose resolved state consistently.

### CI/CD Checks

```bash
gh pr checks "$PR_NUMBER" --repo "$REPO" --json name,state,link,description,bucket
```

Classify as pass/fail/pending/skipped. For failing GitHub Actions, fetch failed logs:

```bash
RUN_ID=$(gh pr checks "$PR_NUMBER" --repo "$REPO" --json name,state,link \
  --jq '.[] | select(.state == "FAILURE") | .link' | grep -oE 'runs/[0-9]+' | cut -d/ -f2 | head -1)
gh run view "$RUN_ID" --repo "$REPO" --log-failed 2>&1 | tail -150
```

### E2E Advisor / CodeRabbit Recommendations

Search CodeRabbit comments and PR comments for recommended jobs:

```bash
gh pr view "$PR_NUMBER" --repo "$REPO" --json comments \
  --jq '.comments[] | select(.author.login == "coderabbitai") | .body' \
  | grep -Ei 'e2e|nightly|workflow|recommend|cloud-e2e|sandbox|hermes|brev'
```

Extract known job names from E2E Advisor and CodeRabbit comments; use `.coderabbit.yaml`, `.github/workflows/nightly-e2e.yaml`, and `.github/workflows/e2e-branch-validation.yaml` only as a stale-safe fallback.

Before triggering any E2E, verify whether the job already passed for the current HEAD SHA:

```bash
HEAD_SHA=$(git rev-parse HEAD)
gh run list --repo "$REPO" --workflow=nightly-e2e.yaml --limit 50 \
  --json databaseId,headSha,headBranch,status,conclusion,createdAt \
  --jq '[.[] | select(.headSha == "'$HEAD_SHA'")]'
```

## Step 5: Action Order for Selected PR

Do exactly one coherent action per pass, then update state and exit.

### A. Integrate Base / Resolve Merge Conflicts

Handle GitHub `mergeable=CONFLICTING`, `mergeStateStatus=DIRTY`, or a branch behind `origin/main` before treating the PR as idle. Prefer rebase to preserve a linear branch, unless the PR already uses merge commits.

Preflight:

```bash
git fetch origin main "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
if [ -n "$(git status --porcelain)" ]; then
  if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    git rebase --abort || true
    git reset --hard "origin/$BRANCH"
  elif [ -f .git/MERGE_HEAD ]; then
    git merge --abort || true
    git reset --hard "origin/$BRANCH"
  else
    echo "blocked: unrelated dirty worktree"
    exit 0
  fi
fi
BEHIND=$(git rev-list --count HEAD..origin/main)
```

If `BEHIND > 0` or GitHub reports conflict/dirty, run:

```bash
if ! git rebase origin/main; then
  git status --short
  git diff --name-only --diff-filter=U
  # inspect and resolve conflicts, or abort if semantic/unsafe
fi
```

Conflict-resolution policy:

Safe to resolve automatically when the correct result is local, mechanical, and testable:

- Formatting-only or adjacent-line conflicts where both sides can be preserved.
- Test expectation/timeouts where main and PR changes are independent.
- File moves/renames where the PR change clearly belongs in the new main location.
- YAML list/matrix additions where preserving both entries is unambiguous and schema-valid.
- Deleted-vs-modified where the file was moved/split and the PR change has an obvious new home.

Stop and ask when the conflict is semantic or policy-affecting:

- Workflow behavior changes that decide which jobs run, schedule, permissions, secrets, runners, or required gates.
- Security boundaries, credential handling, sandbox isolation, or network exposure.
- Public CLI behavior or UX where two branches intentionally changed the same behavior.
- Large refactors where the PR intent must be reinterpreted against main.
- Any conflict where preserving both sides may duplicate jobs, weaken coverage, or alter release flow.

For rebase conflicts remember: during `git rebase`, `ours` is `origin/main` and `theirs` is the PR commit being replayed. Inspect all three stages before choosing:

```bash
git show :1:path/to/file   # merge base
git show :2:path/to/file   # ours: origin/main during rebase
git show :3:path/to/file   # theirs: PR commit during rebase
git show REBASE_HEAD:path/to/file || true
```

After resolving safe conflicts:

```bash
git add <resolved-files>
git rebase --continue
# repeat until complete
```

Validate at the narrowest useful level before pushing:

- For workflow YAML: run YAML parser/checker and any repo workflow lint/convention scripts.
- For TypeScript/test conflicts: run targeted tests or typecheck if dependencies are available.
- For shell conflicts: run `bash -n` and `shellcheck` when available.

Then push:

```bash
git push --force-with-lease origin HEAD:"$BRANCH" --no-verify
```

State outcomes:

- `rebased`: clean rebase with no conflicts.
- `fixed_merge_conflict`: conflict resolved, validated, and pushed.
- `blocked_semantic_conflict`: conflict inspected but unsafe to resolve automatically; abort rebase before exit.
- `blocked_dirty_worktree`: unrelated local dirty state prevented action.

If blocked, always clean up before exit unless the user explicitly asked to leave the worktree mid-conflict:

```bash
git rebase --abort || git merge --abort || true
git reset --hard "origin/$BRANCH"
```

### B. Fix Failing CI/CD

Preferred auto-fix categories:

| Failure | Action |
|---|---|
| biome/lint/format | Run the formatter/linter fix command used by the repo. |
| shellcheck | Apply targeted shell fix. |
| TypeScript compile error | Fix type mismatch if local and obvious. |
| Unit test failure | Fix only after understanding expected behavior. |
| DCO/signoff | Amend/sign off if safe. |
| Infra/flaky failure | Re-run once or report as likely infra. |

After fix:

```bash
git add <changed-files>
git commit -m "fix: address PR CI failure"
git push --no-verify
```

Then exit so the next loop pass can observe new CI.

### C. Address Human Review Feedback

For unresolved human comments:

1. Read the referenced code and full thread.
2. If the fix is local, obvious, and preserves intent, implement it.
3. If it changes architecture, product semantics, security posture, public UX, or contributor intent, stop and ask the user.
4. Commit with a clear message:

```bash
git commit -m "fix: address reviewer feedback"
git push --no-verify
```

Optionally reply to the thread summarizing the fix. Resolve the thread only when the fix clearly addresses it.

### D. Address CodeRabbit Feedback

Apply safe CodeRabbit suggestions automatically when they are:

- Formatting/style/readability only.
- Local null/undefined guard.
- Minor test robustness improvement.
- Small shell safety improvement.

Stop and ask for user confirmation if the suggestion changes architecture, behavior, security boundaries, or E2E assumptions.

Batch multiple safe CodeRabbit fixes in one commit for the same PR:

```bash
git add <changed-files>
git commit -m "fix: address CodeRabbit feedback"
git push --no-verify
```

### E. Trigger Missing E2E Advisor Recommendations

Only trigger E2E after normal PR CI is green or only pending on non-blocking checks.

Rules:

1. Use E2E Advisor and CodeRabbit recommendations first.
2. If recommendations are missing or ambiguous, inspect `.coderabbit.yaml` and current workflow definitions as a fallback.
3. Check current HEAD SHA for prior passing runs.
4. Record triggered jobs/run IDs in state cooldowns.
5. Do not trigger if the same job is already queued/in-progress for the same HEAD SHA.

Example:

```bash
BRANCH=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefName --jq '.headRefName')
JOBS="cloud-e2e,sandbox-operations-e2e"
gh workflow run nightly-e2e.yaml --repo "$REPO" --ref "$BRANCH" -f jobs="$JOBS"
```

After triggering, exit and let a later pass inspect results.

### F. Report Merge-Ready PRs

If a PR is approved, mergeable, current, and all checks/E2E are green, report it as merge-ready but do **not** merge without explicit user approval.

## Step 6: Update State

After each pass, update:

- `lastPass`
- `iteration`
- `lastPr`
- `cooldowns` for triggered workflows
- compact `history` entry

Use `jq` or rewrite the JSON safely. Keep only the latest ~100 history entries to avoid unbounded growth.

History action examples:

- `rebased`
- `fixed_merge_conflict`
- `fixed_ci`
- `fixed_human_review_feedback`
- `fixed_coderabbit_feedback`
- `triggered_e2e`
- `waiting_for_checks`
- `blocked_rebase_conflict`
- `blocked_semantic_conflict`
- `blocked_dirty_worktree`
- `blocked_needs_user_decision`
- `merge_ready`

## Stop and Ask

Stop the loop and ask the user before acting when:

- Rebase conflict appears and is semantic/unsafe after inspection under the conflict-resolution policy.
- Human reviewer request is ambiguous.
- Fix changes public behavior, architecture, security policy, or data handling.
- Multiple failing systems suggest a broader design issue.
- The PR is not authored by the user.
- The next action would merge a PR.
- Worktree has unrelated dirty changes.
- Resolving a conflict would change workflow schedules, permissions, required gates, runner selection, secrets, security posture, or product behavior without an obvious preservation of both sides.

## Compact Report Format

Each pass should end with a short report:

```markdown
## PR Maintenance Loop — pass <N>

Worked: PR #<number> — <title>
Action: <rebased | fixed merge conflict | fixed CI | addressed reviewer | addressed CodeRabbit | triggered E2E | waiting | blocked>
Result: <commit/run/status>

Next: <what the next loop pass should pick up>
Blocked: <only if user input needed>
```

For `/loop`, keep output concise. Do not restate full logs unless blocked.

## Safety Rules

- Never use plain `git push --force`; use `--force-with-lease` only after rebases.
- Never merge without explicit user approval.
- Never modify another author's PR without explicit user approval.
- Never repeatedly trigger expensive E2E workflows for the same SHA.
- Prefer small fix commits over large mixed changes.
- If unsure whether a CodeRabbit suggestion is safe, ask.
