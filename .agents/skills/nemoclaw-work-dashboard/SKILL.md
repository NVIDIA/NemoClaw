---
name: nemoclaw-work-dashboard
description: Comprehensive work dashboard for the NemoClaw repo. Reviews assigned issues, assigned PRs, authored PRs, unassigned NV QA bugs available to pick up (sorted by priority:high and security), trivial unassigned PRs ready for quick review/merge, and bigger unassigned PRs needing substantial review. Use when asking "what's on my plate", "show my work", "work dashboard", "what can I pick up", "review my issues and PRs", "show open bugs", or "what needs review".
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---


<!-- markdownlint-disable MD022 MD026 MD031 MD032 MD036 MD040 MD058 -->

# NemoClaw Work Dashboard

Generate a comprehensive, prioritized work dashboard for the current GitHub user across the NVIDIA/NemoClaw repository. Covers your assignments, your PRs, available bugs, and the full unassigned PR landscape.

## Prerequisites

- `gh` (GitHub CLI) must be installed and authenticated.
- `jq` must be installed.
- You must be in a NemoClaw worktree or the repo root.

## Step 1: Identify the User and Repo

```bash
GH_USER=$(gh api user --jq '.login')
REPO="NVIDIA/NemoClaw"
echo "User: $GH_USER | Repo: $REPO"
```

## Step 2: Build the "Has Open PR" Set

Before presenting any issues, determine which issue numbers already have an associated open PR. This prevents recommending issues that are already being worked on.

### 2a: Extract issue references from all open PR titles and bodies

```bash
gh pr list --repo "$REPO" --state open \
  --json number,title,body --limit 300 | jq -r '.[] |
  (.title + " " + (.body // ""))' | \
  grep -oE '(#|[Ff]ixes |[Cc]loses |[Rr]esolves )\#?[0-9]+' | \
  grep -oE '[0-9]+' | sort -un > /tmp/nemoclaw-issues-with-prs.txt
```

### 2b: Also check PR branch names for issue references

Many NemoClaw PRs use branch naming like `fix/issue-1234` or `feat/1234-description`:

```bash
gh pr list --repo "$REPO" --state open \
  --json headRefName --limit 300 | jq -r '.[].headRefName' | \
  grep -oE '[0-9]+' | sort -un >> /tmp/nemoclaw-issues-with-prs.txt
sort -un -o /tmp/nemoclaw-issues-with-prs.txt /tmp/nemoclaw-issues-with-prs.txt
```

This file is now the lookup set. Any issue number found in this file likely has active PR work.

**Note:** Branch-name matching can produce false positives (e.g., version numbers). When filtering issues, cross-reference conservatively — if uncertain, keep the issue in the list but annotate it with "⚠️ may have PR" rather than silently removing it.

## Step 3: Fetch Your Assigned Issues

```bash
ISSUES_FILE="${ISSUES_FILE:-$(mktemp -t nemoclaw-issues-XXXXXX.json)}"
gh issue list --repo "$REPO" --assignee "$GH_USER" --state open \
  --json number,title,labels,createdAt,url --limit 100 > "$ISSUES_FILE"
```

### Filter out issues with associated open PRs

For each issue, check if its number appears in `/tmp/nemoclaw-issues-with-prs.txt`. Separate into two groups:

- **Active issues (no open PR):** Present these as your working list.
- **Issues with open PRs:** Show these in a separate collapsed note (e.g., "N issues already have open PRs — #X, #Y, #Z") so the user knows they exist but aren't actionable for new work.

```bash
# Example jq + grep filtering:
for num in $(jq -r '.[].number' "$ISSUES_FILE"); do
  if grep -qw "$num" /tmp/nemoclaw-issues-with-prs.txt; then
    echo "HAS_PR: $num"
  else
    echo "NO_PR: $num"
  fi
done
```

Present the "no PR" issues as a table with columns: `#`, `Title`, `Key Labels`, `Created`.

Flag any issues marked `wontfix`, `status: blocked`, or `status: needs-info` — these may not need active work.

## Step 4: Fetch PRs Assigned to You (as reviewer/assignee)

```bash
gh pr list --repo "$REPO" --assignee "$GH_USER" --state open \
  --json number,title,labels,createdAt,url,author,additions,deletions,reviewDecision,reviews --limit 100
```

Present as a table with: `#`, `Title`, `Author`, `+/−`, `Review Status`, `Created`.

If empty, report "None" — this is useful information.

## Step 5: Fetch Your Open (Unmerged) PRs

```bash
gh pr list --repo "$REPO" --author "$GH_USER" --state open \
  --json number,title,labels,createdAt,url,additions,deletions,reviewDecision,reviews,isDraft --limit 100
```

Present as a table with: `#`, `Title`, `+/−`, `Draft?`, `Review Status`, `Created`.

If empty, report "None".

## Step 6: Fetch Unassigned NV QA Bugs

Fetch all open issues labeled `NV QA` + `bug`:

```bash
BUG_FILE="${BUG_FILE:-$(mktemp -t nemoclaw-bugs-XXXXXX.json)}"
gh issue list --repo "$REPO" --label "NV QA,bug" --state open \
  --json number,title,labels,createdAt,url,assignees --limit 200 > "$BUG_FILE"
```

**Important:** The output may be large (50KB+). If `gh` output is truncated, use the temp file path provided and process with `jq`.

### Filter to unassigned only AND no associated open PR

First filter to unassigned, then exclude any issue whose number appears in `/tmp/nemoclaw-issues-with-prs.txt`:

```bash
# Filter to unassigned
cat "$BUG_FILE" | jq '[.[] | select(.assignees | length == 0)]' > /tmp/unassigned-bugs.json

# Then exclude issues with open PRs
for num in $(cat /tmp/unassigned-bugs.json | jq -r '.[].number'); do
  if grep -qw "$num" /tmp/nemoclaw-issues-with-prs.txt; then
    echo "SKIP (has PR): $num"
  fi
done
```

Present only bugs that are unassigned AND have no open PR. Note the count of skipped bugs at the bottom (e.g., "N bugs excluded because they already have open PRs").

### Sort by priority

Separate into tiers and present in this order:

1. **🔴 `priority:high` + `security`** — show first
2. **🔴 `priority:high`** — show second
3. **🟠 `security`** — show third
4. **🟡 Remaining** — sorted oldest → newest (oldest bugs deserve attention)

```bash
cat "$BUG_FILE" | jq '
[.[] | select(.assignees | length == 0) | {
  number,
  title,
  createdAt: (.createdAt | split("T")[0]),
  labels: [.labels[].name],
  hasPriorityHigh: ([.labels[].name] | any(. == "priority:high" or . == "priority: high")),
  hasSecurity: ([.labels[].name] | any(. == "security")),
  sortKey: (if ([.labels[].name] | any(. == "priority:high" or . == "priority: high")) and ([.labels[].name] | any(. == "security")) then 0
            elif ([.labels[].name] | any(. == "priority:high" or . == "priority: high")) then 1
            elif ([.labels[].name] | any(. == "security")) then 2
            else 3 end)
}] | sort_by(.sortKey, .createdAt)'
```

Present as a table with: `#`, `Title`, `Created`, `Key Labels`.

Also note how many `priority:high` and `security` bugs are already assigned (and to whom) — this gives context on team coverage.

## Step 7: Fetch All Open PRs Without Assignees

```bash
PR_FILE="${PR_FILE:-$(mktemp -t nemoclaw-prs-XXXXXX.json)}"
gh pr list --repo "$REPO" --state open \
  --json number,title,labels,createdAt,url,author,additions,deletions,reviewDecision,reviews,isDraft,assignees,changedFiles,reviewRequests --limit 200 > "$PR_FILE"
```

**Important:** This output is often very large (1-2MB+). Always process via the temp file with `jq`.

### Filter to non-draft PRs without assignees, then classify ownership

PRs without assignees are NOT all equally available. Distinguish two tiers:

- **Truly unowned:** No assignees AND no pending review requests. These are genuinely up for grabs.
- **Unassigned but has reviewer:** No assignees but someone has been requested to review. These have implicit ownership — someone is already expected to look at them.

```bash
# Truly unowned (no assignees, no review requests)
cat "$PR_FILE" | jq '[.[] | select(.assignees | length == 0) | select(.isDraft == false) |
  select(.reviewRequests | length == 0)]'

# Unassigned but has pending review requests
cat "$PR_FILE" | jq '[.[] | select(.assignees | length == 0) | select(.isDraft == false) |
  select(.reviewRequests | length > 0) |
  {number, title, author: .author.login, reviewers: [.reviewRequests[].login],
   totalLines: (.additions + .deletions), createdAt: (.createdAt | split("T")[0]),
   labels: [.labels[].name]}]'
```

### Classify truly unowned PRs into Trivial vs Bigger

Use these thresholds:
- **Trivial:** `(additions + deletions) <= 100` AND `changedFiles <= 5`
- **Bigger:** everything else

```bash
# Trivial (truly unowned only)
cat "$PR_FILE" | jq '[.[] | select(.assignees | length == 0) | select(.isDraft == false) |
  select(.reviewRequests | length == 0) |
  select((.additions + .deletions) <= 100 and .changedFiles <= 5) |
  {number, title, author: .author.login, additions, deletions, changedFiles,
   totalLines: (.additions + .deletions), createdAt: (.createdAt | split("T")[0]),
   labels: [.labels[].name], reviewDecision}] | sort_by(.totalLines)'

# Bigger (truly unowned only)
cat "$PR_FILE" | jq '[.[] | select(.assignees | length == 0) | select(.isDraft == false) |
  select(.reviewRequests | length == 0) |
  select((.additions + .deletions) > 100 or .changedFiles > 5) |
  {number, title, author: .author.login, additions, deletions, changedFiles,
   totalLines: (.additions + .deletions), createdAt: (.createdAt | split("T")[0]),
   labels: [.labels[].name], reviewDecision}] | sort_by(-.totalLines)'
```

## Step 8: Present the Trivial PRs (Section 5)

Title: **"Trivial Unassigned PRs — Quick Wins"**

**Only include truly unowned PRs here** (no assignees AND no review requests).

Sub-group into:
- **🟢 Smallest / Mechanical (1–12 lines)** — dependabot bumps, one-liners, typo fixes
- **🟢 Small but Meaningful (14–100 lines)** — targeted bug fixes, preset additions, test additions

Highlight with special callouts:
- ✅ **APPROVED** — PRs with `reviewDecision: "APPROVED"` are merge candidates
- 🔴 **`security` or `priority: high`** — small security PRs deserve fast-track review
- ⚠️ **`status: rebase`** — will need a rebase before merge

Present as tables with: `#`, `Title`, `Author`, `+/−`, `Files`, `Created`, `Notes`.

## Step 9: Present the Bigger PRs (Section 6)

Title: **"Bigger Unassigned PRs — Substantial Reviews"**

**Only include truly unowned PRs here** (no assignees AND no review requests).

Sub-group into:
- **🔴 Security** — PRs with `security` or `priority: high` labels
- **🟠 Major Features / Refactors** — large PRs (500+ lines) introducing new capabilities or restructuring
- **🟡 Platform / Integration** — new platform support, messaging bridges, provider integrations

Present as tables with: `#`, `Title`, `Author`, `Lines`, `Files`, `Created`.

## Step 9b: Present PRs With Pending Review Requests (Section 6b)

Title: **"Unassigned PRs With Pending Reviewers"**

These PRs have no formal assignee but someone has been requested to review. They are **not truly unowned** — show them separately so the user knows someone is already on the hook.

Present as a table with: `#`, `Title`, `Author`, `+/−`, `Requested Reviewer(s)`, `Created`.

This section provides awareness without suggesting these are available to pick up. If a review request has been pending for a long time (>7 days), flag it as potentially stale — the requested reviewer may have missed it.

## Step 10: Summary and Recommendations

### Summary Table

Present aggregate counts:

| Category | Count |
|----------|-------|
| Your open issues | N |
| PRs assigned to you | N |
| Your open PRs | N |
| Unassigned NV QA bugs | N (X priority:high, Y security) |
| Truly unowned trivial PRs | N |
| Truly unowned bigger PRs | N |
| Unassigned PRs with pending reviewers | N |
| Total open PRs in repo | N |

### Recommended Priority Actions

Generate 5–6 actionable recommendations sorted by impact:

1. **Merge now** — any PRs that are already `APPROVED` and unassigned
2. **Security quick-wins** — small unassigned PRs with `security` + `priority: high`
3. **Triage** — unassigned `priority:high` NV QA bugs
4. **Low-effort merges** — dependabot bumps, 1-line fixes
5. **Your active work** — focus areas from your assigned issues (especially new ones from today)
6. **Critical security reviews** — larger security PRs that need attention

## Output Format

Use markdown with clear section headers, tables, emoji indicators, and callout blocks. The full output should read as a single dashboard document with these sections:

```markdown
# NemoClaw — Work Review for @<user>
**Date:** <today> | **Repo:** NVIDIA/NemoClaw

## 1️⃣  Open Issues Assigned to You (N)
## 2️⃣  Open PRs Assigned to You (N)
## 3️⃣  Your Open (Unmerged) PRs (N)
## 4️⃣  Unassigned NV QA Bugs to Pick Up (N)
## 5️⃣  Truly Unowned Trivial PRs — Quick Wins (N)
## 6️⃣  Truly Unowned Bigger PRs — Substantial Reviews (N)
## 6b️⃣  Unassigned PRs With Pending Reviewers (N)
## 📊 Summary
### 🎯 Recommended Priority Actions
```

## Notes

- The `gh` CLI may truncate large JSON outputs. When this happens, the output is saved to a temp file — always check for truncation messages and use the temp file path with `jq`.
- Label names are case-sensitive. The NemoClaw repo uses `NV QA` (with space), not `NVQA`. Similarly `priority: high` (with space after colon) and `priority:high` (without space) may both appear — check for both variants.
- The `reviewDecision` field values are: `APPROVED`, `REVIEW_REQUIRED`, `CHANGES_REQUESTED`, or empty.
- PRs from `app/dependabot` are almost always trivial merge candidates if CI passes.
- Run all `gh` API calls in parallel where possible to minimize wall-clock time.
- **Ownership distinction is critical.** A PR with no assignees but a pending `reviewRequests` entry is NOT truly unowned — someone has been asked to review it. Only PRs with BOTH `assignees: []` AND `reviewRequests: []` should be presented as available to pick up. PRs with pending reviewers go in a separate awareness section.
- **Issues with open PRs are excluded from actionable lists.** An issue that already has an associated open PR is being worked on — presenting it as available to pick up is misleading. The "Has Open PR" set is built from PR titles, bodies (Fixes/Closes/Resolves references), and branch names. Branch-name matches can produce false positives (version numbers, etc.), so when uncertain annotate with "⚠️ may have PR" rather than silently dropping the issue.
