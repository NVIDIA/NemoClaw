---
name: find-review-pr
description: Finds open GitHub PRs with security and priority-high labels, links each to its issue, detects duplicates (multiple PRs fixing the same issue), and presents a table of review candidates. Use when looking for the next PR to review. Trigger keywords - find pr, find review, next pr, pr to review, duplicate pr, security pr.
user_invocable: true
---

# Find PR to Review

Search for open PRs labeled `security` + `priority: high`, associate each with its linked issue, detect duplicates (multiple PRs targeting the same issue), and present a clean summary so you can decide what to review or close.

## Prerequisites

- `gh` (GitHub CLI) must be installed and authenticated.
- You must be in a GitHub repository (or the user must specify `OWNER/REPO`).

## Step 1: Fetch candidate PRs

List all open PRs that carry **both** the `security` and `priority: high` labels:

```bash
gh pr list --label security --label "priority: high" --state open --limit 50 --json number,title,author,headRefName,labels,body,createdAt
```

If the result is empty, report that there are no matching PRs and stop.

## Step 2: Extract linked issues

For each PR, parse the body for linked issue references. Look for these patterns (case-insensitive):

- `Fixes #NNN`, `Closes #NNN`, `Resolves #NNN`
- `Related Issue` / `Linked Issue` section containing `#NNN`
- Issue number in the PR title, e.g. `(#NNN)` suffix
- Branch name containing an issue number, e.g. `fix/something-NNN`

Build a mapping: `PR# → [issue numbers]`.

If a PR has no detectable linked issue, mark it as `(no linked issue)`.

## Step 3: Detect duplicates

Group PRs by linked issue number. Any issue with **two or more** open PRs is a duplicate group.

For each duplicate group, fetch a brief summary of each competing PR to help the user decide which to keep:

```bash
gh pr view <number> --json number,title,author,createdAt,additions,deletions,reviewDecision,statusCheckRollup --jq '{number,title,author: .author.login,created: .createdAt,additions,deletions,review: .reviewDecision,checks: [.statusCheckRollup[]?.conclusion] | unique}'
```

## Step 4: Check for superseded PRs

Also flag PRs whose body contains phrases like:

- `follow-up to #NNN` / `supersedes #NNN` / `replaces #NNN` / `folds in #NNN`

where `#NNN` is another **open** PR number in the candidate list. These indicate one PR has absorbed another.

## Step 5: Present results

### Duplicates / Superseded

If duplicates or superseded PRs exist, present them first in a table:

```markdown
### Duplicate PRs (same issue)

| Issue | PR | Author | Title | +/- | Status |
|-------|-----|--------|-------|-----|--------|
| #804  | #1121 | user1 | ...  | +50/-10 | Checks passing |
| #804  | #1300 | user2 | ...  | +80/-20 | Checks failing |

**Recommendation:** #1121 is smaller and passing checks — consider closing #1300.
```

For superseded PRs:

```markdown
### Superseded PRs

- #1416 supersedes/folds in #1392 (shell-quote sandboxName)
  → Consider closing #1392 if #1416 covers its scope.
```

### Clean candidates

Present non-duplicate PRs in a table:

```markdown
### Review candidates (no duplicates)

| PR | Issue | Title | Author | Age |
|----|-------|-------|--------|-----|
| #1476 | #577 | disable remote uninstall fallback | user1 | 2d |
| #1121 | #804 | Landlock read-only /sandbox | user2 | 6d |
```

### Summary line

End with a one-line recommendation of which PR to review first, preferring:

1. Older PRs (waiting longest)
2. PRs with passing checks
3. PRs with smaller diff size (easier to review)

## Notes

- Do NOT automatically close any PRs. Only present findings and recommendations.
- If the user specifies additional filters (e.g., a specific scope label like `OpenShell`), apply them.
- If the user asks for a different priority label, adjust accordingly.
