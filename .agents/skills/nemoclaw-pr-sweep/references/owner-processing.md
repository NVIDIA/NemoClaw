# Per-PR Processing: OWNER Role

<!-- markdownlint-disable MD001 MD012 MD022 MD031 MD032 MD040 MD058 -->

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
}' -f owner=NVIDIA -f repo=NemoClaw -F pr="$PR_NUMBER" \
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
