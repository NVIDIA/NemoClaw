---
name: nemoclaw-maintainer-find-review-pr
description: Find open PRs with the security label and Urgent or High Project Priority. Link each PR to its issue. Identify competing or superseded PRs and report review candidates. Use when looking for the next PR to review. Trigger keywords - find pr, find review, next pr, pr to review, duplicate pr, security pr.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Find PR to Review

Find open PRs with the `security` label and Project Priority `Urgent` or `High`.
Link each PR to its issue. Identify competing or superseded PRs. Report the results for the maintainer.

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

Remove entries for closed PRs.
For each remaining PR, fetch the body, author, branch, labels, and creation time with `gh pr view`.
If no PRs remain, report that result and stop.

## Step 2: Extract linked issues

For each PR, search its body for issue references. Match these patterns without case sensitivity:

- `Fixes #NNN`, `Closes #NNN`, `Resolves #NNN`
- `Related Issue` / `Linked Issue` section containing `#NNN`
- Issue number in the PR title, such as a `(#NNN)` suffix
- Branch name containing an issue number, such as `fix/something-NNN`

Build a mapping: `PR# → [issue numbers]`.

If a PR has no detectable linked issue, mark it as `(no linked issue)`.

## Step 3: Detect duplicates

Group PRs by linked issue number.
If two or more open PRs link to one issue, put them in one competing-PR group.

Fetch these fields for each competing PR:

```bash
gh pr view <number> --json number,title,author,createdAt,additions,deletions,reviewDecision,statusCheckRollup --jq '{number,title,author: .author.login,created: .createdAt,additions,deletions,review: .reviewDecision,checks: [.statusCheckRollup[]?.conclusion] | unique}'
```

## Step 4: Check for superseded PRs

Flag a PR when its body contains one of these phrases:

- `follow-up to #NNN` / `supersedes #NNN` / `replaces #NNN` / `folds in #NNN`

The phrase must name another open candidate PR. It indicates that one PR can include the other.

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
  Consider closing #1392 if #1416 contains its full scope.
```

### Clean candidates

Present PRs without competing PRs in a table:

```markdown
### Review candidates (no duplicates)

| PR | Issue | Priority | Title | Author | Age |
|----|-------|----------|-------|--------|-----|
| #1476 | #577 | Urgent | disable remote uninstall fallback | user1 | 2d |
| #1121 | #804 | High | Landlock read-only /sandbox | user2 | 6d |
```

### Summary line

Recommend one PR to review first. Apply these priorities in order:

1. Project Priority (`Urgent` before `High`)
2. Oldest PR
3. PRs with passing checks
4. PRs with smaller diff size (easier to review)

## Notes

- Never close a PR. Report findings and recommendations only.
- Apply filters that the user gives, such as a scope label.
- If the user asks for a different priority, filter the Project Priority field. Never use or create a priority label.
