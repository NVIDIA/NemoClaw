---
name: nemoclaw-pr-sweep
description: Batch maintenance sweep across all active NemoClaw PR worktrees. Rebases, resolves CodeRabbit comments, addresses reviewer feedback, fixes failing CI, identifies and triggers E2E, and flags merge-ready PRs. Use when user says "sweep PRs", "check my PRs", "PR sweep", "update PRs", "daily PR maintenance", "sweep worktrees", or "PR hygiene".
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---

# NemoClaw PR Sweep

Iterate over all active PR worktrees in NemoClaw-working, perform routine maintenance actions, and report status. Handles both PRs you own (authored) and PRs you're reviewing (someone else authored) with different permission levels.

## When to Use

- Daily maintenance pass across your PR portfolio
- When you want to batch-update all your PRs (rebase, respond, fix CI)
- When checking if any reviewer PRs need attention
- When user says "sweep PRs", "check my PRs", "PR sweep", "update PRs", "daily PR maintenance"

## Constants

```bash
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
MAIN_REPO="${NEMOCLAW_REPO}"
REPO="NVIDIA/NemoClaw"
```

## Role Classification

Every PR is classified into one of two roles:

| Role | Identification | Permissions |
|------|---------------|-------------|
| **OWNER** | `author.login == $GH_USER` | Full: rebase, code changes, force-push, resolve comments, trigger E2E |
| **REVIEWER** | `author.login != $GH_USER` | Read + E2E only: check status, trigger E2E, but NO code changes without user confirmation |

## Workflow

### Step 0: Setup and Discovery

```bash
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
REPO="NVIDIA/NemoClaw"
GH_USER=$(gh api user --jq '.login')

# Discover all pr-* worktrees
PR_WORKTREES=$(ls -d "${WORKTREE_BASE}"/pr-*/ 2>/dev/null)

# Also discover issue-* and fix-* worktrees that may have open PRs
OTHER_WORKTREES=$(ls -d "${WORKTREE_BASE}"/issue-*/ "${WORKTREE_BASE}"/fix-*/ "${WORKTREE_BASE}"/refactor*/ 2>/dev/null)
```

### Step 0b: Discover PRs from non-pr-* worktrees

For each `issue-*`, `fix-*`, and `refactor*` worktree, check if the branch has an open PR:

```bash
cd "$WORKTREE_PATH"
BRANCH=$(git branch --show-current)

# Check if this branch has an open PR
PR_DATA=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number,title,author,state --jq '.[0]' 2>/dev/null)

if [ -n "$PR_DATA" ] && [ "$PR_DATA" != "null" ]; then
  # This worktree has an open PR — include it in the sweep
  PR_NUMBER=$(echo "$PR_DATA" | jq -r '.number')
fi
```

Add any discovered PRs to the sweep list alongside the `pr-*` worktrees.

### Step 1: Fetch PR metadata for all discovered PRs

For each PR worktree, gather:

```bash
cd "$WORKTREE_PATH"
PR_NUMBER=<extracted from directory name or discovered in Step 0b>

gh pr view "$PR_NUMBER" --repo "$REPO" --json \
  number,title,state,author,headRefName,reviewDecision,reviews,comments,labels,\
  statusCheckRollup,mergeable,mergeStateStatus,updatedAt,files \
  --jq '.'
```

**Skip PRs that are MERGED or CLOSED** — report them as candidates for worktree cleanup and move on.

### Step 2: Classify role for each PR

```bash
AUTHOR=$(echo "$PR_DATA" | jq -r '.author.login')
if [ "$AUTHOR" == "$GH_USER" ]; then
  ROLE="OWNER"
else
  ROLE="REVIEWER"
fi
```

### Step 3: Process each PR (ordered: OWNER PRs first, then REVIEWER PRs)

Process OWNER PRs first (since you can take immediate action), then REVIEWER PRs (which may require discussion pauses).

---

## Per-PR Processing: OWNER Role

### 3a: Sync with main (auto)

```bash
cd "$WORKTREE_PATH"
git fetch origin main

# Check how far behind
BEHIND=$(git rev-list --count HEAD..origin/main)

if [ "$BEHIND" -gt 0 ]; then
  echo "Branch is $BEHIND commits behind main — rebasing..."
  git rebase origin/main

  if [ $? -ne 0 ]; then
    # Rebase conflict — abort and report
    git rebase --abort
    echo "⚠️ Rebase conflict — needs manual resolution"
  else
    # Successful rebase — force push
    git push --force-with-lease --no-verify
    echo "✅ Rebased and force-pushed ($BEHIND commits integrated)"
  fi
fi
```

### 3b: Resolve CodeRabbit comments (auto)

Check for unresolved CodeRabbit review comments:

```bash
# Get unresolved CodeRabbit review-thread comments via GraphQL.
gh api graphql -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
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
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[]
         | select(.isResolved == false)
         | .comments.nodes[]
         | select((.author.login // "") | test("(?i)coderabbit"))
         | {id, path, line, body}]'
```

For each unresolved CodeRabbit comment:
1. Read the suggestion (CodeRabbit uses ````suggestion` blocks)
2. If it's a **formatting/style/trivial** change — apply it directly to the file and commit
3. If it's a **substantive logic/architecture** change — apply it and include in the summary for the user
4. After applying, resolve the comment thread

Commit message format: `fix: apply CodeRabbit suggestion — <brief description>`

**Important:** Apply all CodeRabbit suggestions in a single commit if possible to keep history clean.

### 3c: Address reviewer feedback (semi-auto)

Check for unresolved human review comments:

```bash
# Get review threads
gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" --paginate \
  --jq '[.[] | select(.state == "CHANGES_REQUESTED" or .state == "COMMENTED") | select((.user.login // "") | test("(?i)coderabbit") | not) | {user: .user.login, state: .state, body: .body}]'

# Get unresolved comment threads
gh api graphql -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 10) {
            nodes {
              author { login }
              body
              path
              line
            }
          }
        }
      }
    }
  }
}' -f owner=NVIDIA -f repo=NemoClaw -f pr="$PR_NUMBER" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'
```

For each unresolved human comment:
1. Read the feedback
2. Analyze the code at the referenced path/line
3. Determine if a code change addresses the feedback
4. **Make the code change** and prepare it as a commit
5. **Present the change to the user** with context about what the reviewer asked and what you did
6. On user approval — push the commit
7. Optionally reply to the thread explaining the fix

### 3d: Check CI status and fix failures (semi-auto)

```bash
# Get check run results
gh pr checks "$PR_NUMBER" --repo "$REPO" 2>&1
```

For each failing check:
1. Identify the failure type:
   - **Lint/format** — auto-fix with `npm run lint:fix` or equivalent, commit and push
   - **Type errors** — analyze and fix, present diff for approval
   - **Test failures** — analyze, attempt fix, present diff for approval
   - **Build failures** — analyze root cause, fix if straightforward
   - **Flaky/infra failures** — report as informational ("pre-existing flake, re-run may fix")
2. If the failure is **unclear or complex**, report it and suggest:
   - "This may warrant a new issue — want me to file one?"
   - Stop and discuss before making changes

### 3e: Determine E2E needs (auto-trigger)

Use E2E Advisor and CodeRabbit recommendations first. If they are missing or ambiguous, inspect changed files against `.coderabbit.yaml` and the current workflow definitions:

```bash
# Get changed files
FILES=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json files --jq '.files[].path')
```

**Before triggering, check if E2E already ran on this branch:**

```bash
# Get the HEAD sha of the PR branch
HEAD_SHA=$(git rev-parse HEAD)

# Check if any recent workflow runs targeted this SHA or branch
gh run list --repo "$REPO" -w nightly-e2e --limit 20 --json headSha,conclusion,createdAt \
  --jq "[.[] | select(.headSha == \"$HEAD_SHA\" and .conclusion == \"success\")] | length"

# Also check Brev E2E
gh run list --repo "$REPO" -w e2e-brev --limit 10 --json headSha,conclusion,createdAt \
  --jq "[.[] | select(.headSha == \"$HEAD_SHA\" and .conclusion == \"success\")] | length"
```

**Only trigger E2E if:**
- The validation framework identifies a required path AND
- No passing run exists for the current HEAD SHA on that specific job

When triggering:

```bash
# Example: nightly dispatch for specific jobs
gh workflow run nightly-e2e.yaml --repo "$REPO" -f jobs="<identified-jobs>"

# Example: Brev for install-flow
gh workflow run e2e-brev.yaml --repo "$REPO" -f pr_number="$PR_NUMBER" -f test_suite=full

# Example: branch validation / install-flow
# Use the current e2e-branch-validation workflow inputs for PR-specific runs.
```

Report what was triggered and why.

---

## Per-PR Processing: REVIEWER Role

### 3a: Check sync status (info only)

```bash
cd "$WORKTREE_PATH"
git fetch origin main

BEHIND=$(git rev-list --count HEAD..origin/main)
CONFLICTS=$(git merge-tree $(git merge-base HEAD origin/main) HEAD origin/main 2>&1 | grep -c "CONFLICT" || true)

if [ "$BEHIND" -gt 0 ]; then
  echo "ℹ️ Branch is $BEHIND commits behind main"
  if [ "$CONFLICTS" -gt 0 ]; then
    echo "⚠️ Has merge conflicts with main — author needs to rebase"
  fi
fi
```

**Do NOT rebase or push.** Report status only.

### 3b: Check for author responses (info only)

Look for new comments from the PR author since your last review:

```bash
# Find your most recent review timestamp
MY_LAST_REVIEW=$(gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" --paginate \
  --jq "[.[] | select(.user.login == \"$GH_USER\")] | sort_by(.submittedAt) | last | .submittedAt")

# Find comments from the author after your review
gh api "repos/$REPO/pulls/$PR_NUMBER/comments" --paginate \
  --jq "[.[] | select(.user.login == \"$AUTHOR\") | select(.createdAt > \"$MY_LAST_REVIEW\")] | length"

# Also check issue comments (non-inline)
gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
  --jq "[.[] | select(.user.login == \"$AUTHOR\") | select(.createdAt > \"$MY_LAST_REVIEW\")] | length"
```

Report: "Author has posted N new comments since your last review" with a summary of what they said.

### 3c: Identify needed code changes (STOP and discuss)

If during status review you identify that:
- CI is failing due to a code issue the author hasn't addressed
- The rebase conflict prevents merge
- A review comment you left hasn't been addressed and the fix is clear

**DO NOT make code changes.** Instead:

1. **Stop the sweep** at this PR
2. Present the situation clearly:
   ```
   ## ⚠️ REVIEWER PR Needs Discussion: PR #NNNN

   **Issue:** <describe what needs to change>
   **Suggested fix:** <describe the code change>

   Options:
   A) I can post a comment on the PR suggesting this fix to the author
   B) Skip this for now and continue the sweep
   C) Make the change directly (unusual for reviewer PRs)
   ```
3. Wait for user input
4. On "A" — compose and post a helpful PR comment with the suggestion (using ````suggestion` blocks if applicable)
5. On "B" — continue the sweep
6. On "C" — make the change (only if user explicitly confirms)

After resolving, **resume the sweep from where it stopped**.

### 3d: Check CI status (info + trigger E2E)

Same as OWNER step 3d for identifying failures, but:
- **Do NOT fix code** — report findings only
- **DO trigger E2E** if the validation framework identifies it's needed and hasn't been run

```bash
# Same E2E decision logic as OWNER — check HEAD SHA, trigger if needed
```

E2E triggering is allowed automatically for REVIEWER PRs because it doesn't modify code — it just kicks off a workflow.

---

## Step 4: Merge-Ready Report (end of sweep)

After processing all PRs, collect any that are merge-ready:

```bash
# A PR is merge-ready if:
# - reviewDecision == "APPROVED"
# - All CI checks pass (no failing required checks)
# - mergeable == "MERGEABLE"
# - Up-to-date with main (or just rebased in this sweep)
```

Present as a batch:

```markdown
## 🚀 Merge-Ready PRs

The following PRs are approved, CI-green, and up-to-date:

| # | Title | Role | Approved By | Action |
|---|-------|------|-------------|--------|
| 2465 | refactor(cli): centralize subprocess... | OWNER | @<maintainer> | Merge? |
| 2597 | fix: network policy hot-reload... | REVIEWER | @<user> | Merge? |

Shall I merge all of these, or select specific ones?
```

Wait for user confirmation, then merge the confirmed PRs:

```bash
gh pr merge "$PR_NUMBER" --repo "$REPO" --squash --delete-branch
```

Use `--squash` by default (NemoClaw convention). If the PR has a clean linear history and conventional commits, use `--rebase` instead.

---

## Step 5: Summary Report

After all PRs are processed, produce a full summary:

```markdown
# PR Sweep Summary — <date>

## Stats
| Metric | Count |
|--------|-------|
| PRs swept | N |
| Owner PRs | N |
| Reviewer PRs | N |
| Rebased | N |
| CodeRabbit comments resolved | N |
| CI fixes applied | N |
| E2E triggered | N |
| Merge-ready | N |
| Closed/merged (cleanup candidates) | N |

## Owner PRs

### ✅ PR #NNNN — <title>
- Rebased (was N behind)
- Applied 2 CodeRabbit suggestions
- Triggered cloud-onboard-e2e

### ⚠️ PR #NNNN — <title>
- Rebase conflict — needs manual resolution
- 1 reviewer comment unresolved (presented for approval)

## Reviewer PRs

### ℹ️ PR #NNNN — <title> (@author)
- Author responded to 2/3 review comments
- Still behind main by 5 commits (no conflicts)
- E2E: cloud-e2e already passed for HEAD

### ⚠️ PR #NNNN — <title> (@author)
- CI failing: lint error in src/lib/foo.ts
- Posted suggestion comment to author

## 🚀 Merge-Ready
<merge batch from Step 4>

## 🗑️ Cleanup Candidates
These worktrees have PRs that are now MERGED or CLOSED:
- pr-1419 (MERGED)
- pr-2050 (CLOSED)
Consider running `/skill:nemoclaw-worktree-cleanup`
```

---

## Error Handling

- **Rebase conflicts on OWNER PRs:** Abort rebase, report the conflict, continue sweep. Mark PR as "needs manual attention".
- **GitHub API rate limits:** If rate-limited, pause and report how many PRs were processed vs. remaining.
- **Worktree in dirty state:** If uncommitted changes exist, report them and skip that worktree (don't lose work).
- **PR no longer exists:** If `gh pr view` fails (deleted/transferred), skip and recommend worktree cleanup.

## Git Identity

When making commits in worktrees, ensure git identity is configured:

```bash
MAIN_REPO="${NEMOCLAW_REPO}"
git config user.name  "$(git -C "$MAIN_REPO" config user.name)"
git config user.email "$(git -C "$MAIN_REPO" config user.email)"
git config user.signingkey "$(git -C "$MAIN_REPO" config user.signingkey)"
git config commit.gpgsign "$(git -C "$MAIN_REPO" config commit.gpgsign)"
git config gpg.format "$(git -C "$MAIN_REPO" config gpg.format)"
```

## Processing Order

1. **OWNER PRs first** — these are fully actionable, get them done
2. **REVIEWER PRs second** — these may require discussion pauses
3. **Merge-ready batch at the end** — after everything is processed, present the merge batch

Within each category, process by **last updated (oldest first)** — PRs that haven't been touched in a while are most likely to need attention.

## Notes

- The worktree base path is always `${NEMOCLAW_WORKTREE_BASE}`
- This skill does NOT perform deep code reviews — use `/skill:nemoclaw-pr-review` for that
- This skill does NOT perform first-time PR triage — use `/skill:nemoclaw-pr-triage` for that
- E2E decisions use E2E Advisor and CodeRabbit recommendations first; use current workflow definitions as the fallback source of dispatch mechanics
- When stopping for REVIEWER discussion, always offer to resume after the discussion is resolved
- Force-push uses `--force-with-lease` (never `--force`) for safety
- All pushes use `--no-verify` to skip local hooks (CI will catch issues)
