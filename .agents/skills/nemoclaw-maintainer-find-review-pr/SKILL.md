---
name: nemoclaw-maintainer-find-review-pr
description: Finds open security-labeled GitHub PRs with Urgent or High Project Priority, links each to its issue, detects duplicates, and presents a table of review candidates. Use when looking for the next PR to review. Trigger keywords - find pr, find review, next pr, pr to review, duplicate pr, security pr.
user_invocable: true
---

# Find PR to Review

Search for open PRs labeled `security` whose Project Priority is `Urgent` or `High`, associate each with its linked issue, detect duplicates (multiple PRs targeting the same issue), and present a clean summary so you can decide what to review or close.

## Prerequisites

- `gh` (GitHub CLI) must be installed and authenticated.
- The active `gh` token must have `read:project` scope.
- You must be in a GitHub repository (or the user must specify `OWNER/REPO`).

## Step 1: Fetch candidate PRs

Read the NemoClaw Development Tracker and select open PRs that carry the canonical `security` label and have Project Priority `Urgent` or `High`:

```bash
gh project item-list 199 --owner NVIDIA --limit 1000 --format json \
  | jq '[.items[]
    | select(.content.repository == "NVIDIA/NemoClaw")
    | select(.content.type == "PullRequest")
    | select(((.labels // []) | index("security")) != null)
    | select(.priority == "Urgent" or .priority == "High")
    | {number: .content.number, title: .content.title, url: .content.url,
       priority: .priority, status: .status}]'
```

Discard entries whose PR is no longer open. Fetch PR body, author, branch, labels, and creation time for the remaining numbers with `gh pr view`. If the result is empty, report that there are no matching PRs and stop.

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

| PR | Issue | Priority | Title | Author | Age |
|----|-------|----------|-------|--------|-----|
| #1476 | #577 | Urgent | disable remote uninstall fallback | user1 | 2d |
| #1121 | #804 | High | Landlock read-only /sandbox | user2 | 6d |
```

### Summary line

End with a one-line recommendation of which PR to review first, preferring:

1. Project Priority (`Urgent` before `High`)
2. Older PRs (waiting longest)
3. PRs with passing checks
4. PRs with smaller diff size (easier to review)

## Notes

- Do NOT automatically close any PRs. Only present findings and recommendations.
- If the user specifies additional filters (e.g., a specific scope label like `OpenShell`), apply them.
- If the user asks for a different priority, filter the Project Priority field. Never use or create a priority label.
