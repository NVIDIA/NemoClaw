---
name: nemoclaw-release-review
description: Daily NemoClaw release readiness review. Finds the last released tag automatically, then focuses the report on today's/current next release: UAT and NV QA GitHub issues, current sprint progress, PRs needing review today, and what the current user should target today. Use when asking "release review", "release status", "daily release", "what should ship today", "what's next", "current release", "next release", "release planning", or "what should I focus on today".
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---


<!-- markdownlint-disable MD022 MD026 MD031 MD032 MD036 MD040 MD058 -->

# NemoClaw Daily Release Review

Produce a **daily/current-release readiness report** for NemoClaw.

The skill must automatically determine the **last released tag** and use it as context, but the report should primarily answer:

1. What is already queued for the next/current release?
2. What UAT and NV QA bugs could block or shape today's release?
3. How is the current sprint progressing?
4. Which PRs need review today?
5. What should `${GH_USER}` personally target today?

Keep last-release history concise. The emphasis is on **today's release decisions and next-day execution**.

## When to Use

- When asked for release status or a release review
- When preparing for a daily release / same-day tag decision
- When asking what should ship today or tomorrow
- When asking what UAT / NV QA bugs matter for release readiness
- When asking which PRs should be reviewed today
- When asking what `${GH_USER}` should focus on today
- When preparing daily standup / sprint-progress release triage

## Process

### Step 1: Identify the Last Released Tag Automatically

Work from the canonical repo:

```bash
cd ${NEMOCLAW_REPO}

git fetch --tags origin 2>&1
LAST_TAG=$(git tag --sort=-version:refname | head -1)
PREVIOUS_TAG=$(git tag --sort=-version:refname | grep -A1 "^${LAST_TAG}$" | tail -1)

echo "LAST_TAG=${LAST_TAG}"
echo "PREVIOUS_TAG=${PREVIOUS_TAG}"
git for-each-ref refs/tags/${LAST_TAG} --format='%(creatordate:iso)'
git for-each-ref refs/tags/${PREVIOUS_TAG} --format='%(creatordate:iso)'
```

Notes:
- Treat `LAST_TAG` as the last **released** tag.
- Do not ask the user for the tag unless tag discovery fails.
- If tags have suffixes or pre-release variants, prefer the most recent stable `vX.Y.Z` semver tag.

### Step 2: Concise Last Release Context

Summarize what shipped in the last release only briefly:

```bash
git log --oneline ${PREVIOUS_TAG}..${LAST_TAG}
git log --oneline ${PREVIOUS_TAG}..${LAST_TAG} | grep -oE '#[0-9]+' | sed 's/#//' | sort -n | uniq
```

For each number, verify whether it is a PR:

```bash
gh pr view $NUM --json number,title,author,mergedBy,mergedAt,state,labels 2>&1
```

Keep this section short: PR count, notable shipped fixes, and release cadence.

### Step 3: Determine Current / Next Release Payload

These are already merged after the last release tag and are confirmed candidates for the next tag:

```bash
git fetch origin main 2>&1
git log --oneline ${LAST_TAG}..origin/main
git log --oneline ${LAST_TAG}..origin/main | grep -oE '#[0-9]+' | sed 's/#//' | sort -n | uniq
```

For each PR number:

```bash
gh pr view $NUM --json number,title,author,mergedBy,mergedAt,state,labels,files,closingIssuesReferences 2>&1
```

Classify confirmed next-release payload by theme:
- UAT/NV QA fixes
- Security fixes
- E2E / CI stability
- User-facing UX / CLI changes
- Refactoring / architecture
- Docs / low-risk maintenance

### Step 4: Identify the Current Sprint and Sprint Progress

Use GitHub Project #199, matching the current date to the active Sprint iteration.

```bash
cd ${NEMOCLAW_REPO} && gh api graphql -f query='
{
  organization(login: "NVIDIA") {
    projectV2(number: 199) {
      fields(first: 30) {
        nodes {
          ... on ProjectV2IterationField {
            id
            name
            dataType
            configuration {
              iterations { id title startDate duration }
              completedIterations { id title startDate duration }
            }
          }
        }
      }
    }
  }
}'
```

The sprint field is an **Iteration** field named `Sprint`. Pick the iteration whose date range includes today.

Then collect all sprint items. Prefer the existing helper from the sprint-review skill, resolving it from the repository instead of a user-specific skills directory:

```bash
SCRIPT=".agents/skills/consolidation/nemoclaw-sprint-review/collect_sprint_items.py"
test -f "$SCRIPT" || SCRIPT=".agents/skills/nemoclaw-sprint-review/collect_sprint_items.py"
python3 "$SCRIPT" "Sprint N" > /tmp/nemoclaw_current_sprint.json
```

The script returns items with number, title, state, status, assignees, labels, type, and author.

Compute:
- Total sprint items
- Done / In Progress / Needs Review / Backlog / Blocked / No Status counts
- Percent done vs percent of sprint elapsed
- Sprint items connected to UAT or NV QA labels
- Sprint items assigned to `${GH_USER}`
- Sprint PRs authored by `${GH_USER}`
- Sprint PRs in `Needs Review`

### Step 5: UAT & NV QA Bug Release Triage

UAT and NV QA bugs are the main focus of the report.

```bash
cd ${NEMOCLAW_REPO}

gh issue list --label "NV QA" --state open --limit 100 --json number,title,assignees,labels,updatedAt,createdAt,url
gh issue list --label "UAT" --state open --limit 100 --json number,title,assignees,labels,updatedAt,createdAt,url
```

Also check closed/merged recently to identify progress since the last release tag and since the start of the current sprint:

```bash
gh issue list --label "NV QA" --state closed --limit 50 --json number,title,assignees,labels,closedAt,updatedAt,url
gh issue list --label "UAT" --state closed --limit 50 --json number,title,assignees,labels,closedAt,updatedAt,url
```

For each open UAT/NV QA issue, classify:

- **Release blocker** — priority high, security, regression, install/onboard failure, data loss, or no workaround
- **Should target today** — high user impact, already assigned, linked PR exists, or small fix likely
- **Needs triage** — unclear owner/repro/area
- **Can defer** — low impact, workaround exists, or not in current release path

Group trends by:
- Platform: macOS, Ubuntu, DGX Spark, WSL2, Brev, Jetson, All Platforms
- UX area: onboarding, CLI/UX, recovery/resilience, inference, security, sandbox, networking
- Code area: onboard, sandbox, gateway, CLI, shields, docker, tests
- Severity signal: `priority: high`, `security`, repeated duplicates, or recent UAT/NV QA cluster

Cross-reference each UAT/NV QA issue with:
- Current sprint membership
- Linked PRs / closing PRs
- Assignees
- Whether `${GH_USER}` owns or recently touched the area

Useful detail command:

```bash
gh issue view $NUM --json number,title,body,assignees,labels,comments,linkedPullRequests,projectItems,updatedAt,createdAt,url
```

### Step 6: PRs That Need Review Today

Review queue should focus on PRs that can move the release today.

Collect open PRs:

```bash
gh pr list --state open --limit 100 --json number,title,author,assignees,labels,reviewDecision,isDraft,updatedAt,createdAt,mergeStateStatus,statusCheckRollup,url
```

Find PRs with one or more of these signals:

1. Project status `Needs Review` in current sprint
2. Labels indicating review/release readiness, such as `needs review`, `review`, `ready for review`, `release`, `priority: high`, `NV QA`, `UAT`, `security`
3. `reviewDecision` is `REVIEW_REQUIRED` or `APPROVED`
4. Not draft and recently updated today/yesterday
5. Linked to UAT/NV QA/security/high-priority issues
6. Authored by someone else and reviewable by `${GH_USER}`
7. Authored by `${GH_USER}` and needs response/rebase/fix/merge shepherding

Use detailed views as needed:

```bash
gh pr view $NUM --json number,title,author,assignees,labels,reviewDecision,isDraft,updatedAt,mergeStateStatus,statusCheckRollup,reviews,comments,files,closingIssuesReferences,url
```

Categorize today's PR queue:

- **Merge today** — approved, green, non-draft, low risk or release-critical
- **Review today** — needs human review and is tied to current sprint/release/UAT/NV QA
- **Fix today** — authored by `${GH_USER}` or assigned to `${GH_USER}`, blocked by comments/CI/rebase
- **Watch** — important but not actionable today
- **Defer** — draft/stale/non-release-critical

### Step 7: Identify `${GH_USER}` Daily Targets

Build a focused daily work list from all gathered data.

Sources:

```bash
# Issues assigned to ${GH_USER}
gh issue list --assignee ${GH_USER} --state open --limit 100 --json number,title,labels,assignees,updatedAt,url

# PRs authored by ${GH_USER}
gh pr list --author ${GH_USER} --state open --limit 100 --json number,title,labels,reviewDecision,isDraft,updatedAt,mergeStateStatus,statusCheckRollup,url

# PRs requesting current-user review, if supported by gh search
gh search prs --review-requested ${GH_USER} --state open --limit 50 --json number,title,repository,author,labels,updatedAt,url 2>&1
```

Also inspect local worktrees for active work:

```bash
find ${NEMOCLAW_WORKTREE_BASE} -maxdepth 2 -name .git -type f -o -name .git -type d 2>/dev/null
cd ${NEMOCLAW_WORKTREE_BASE}/<worktree> && git status --short && git branch --show-current
```

Prioritize `${GH_USER}` targets using this order:

1. Release blockers assigned to `${GH_USER}`
2. UAT/NV QA/security bugs in current sprint
3. `${GH_USER}` PRs that can merge today after small fixes
4. PR reviews requested from `${GH_USER}` that unblock release/sprint
5. Unassigned high-priority UAT/NV QA bugs where `${GH_USER}` has relevant context
6. Cleanup/rebase/test work that turns an almost-ready PR green

### Step 8: Optional Architecture / Regression Context

If UAT/NV QA bugs cluster around refactored areas, check recent architecture/refactor context:

```bash
ls -t ${NEMOCLAW_WORKTREE_BASE}/.agent-reports/arch-report-*.md 2>/dev/null | head -1
```

If a recent report exists, use it to identify whether bugs:
- Were likely introduced by recent refactoring
- Should be fixed as part of active refactoring
- Are blocked by planned refactoring
- Reveal a new architectural gap

Do not let this section dominate the daily report; include it only when it explains release risk.

## Report Format

Use `canvas_document` when available; otherwise respond directly in markdown.

```markdown
# NemoClaw Daily Release Review — YYYY-MM-DD

## Executive Summary

- **Last released tag:** vX.Y.Z (YYYY-MM-DD), N days ago
- **Next/current release payload:** N merged PRs since tag
- **Current sprint:** Sprint N (Day X/Y, Z% elapsed, D% done)
- **UAT/NV QA open:** N total — B blockers, T target-today, R needs triage
- **PRs needing action today:** N merge-ready, N review-needed, N fix-needed
- **Recommendation:** Tag today / wait for blockers / focus on triage first

## Last Release Context: vX.Y.Z

Short context only:

| Metric | Value |
|--------|-------|
| Previous tag | vX.Y.W |
| PRs shipped | N |
| Notable themes | ... |

## Current / Next Release Payload

Already merged since `vX.Y.Z` and expected in the next tag:

| PR | Title | Author | Merged | Release Theme |
|----|-------|--------|--------|---------------|
| #NNNN | ... | @user | YYYY-MM-DD | UAT/NV QA / security / UX / refactor |

## UAT & NV QA Release Triage

### Release Blockers

| Issue | Title | Labels | Assignee | Why It Blocks | Next Action |
|-------|-------|--------|----------|---------------|-------------|
| #NNNN | ... | NV QA, priority: high | @user | ... | ... |

### Target Today

| Issue | Title | Assignee | Linked PR | Reason to Target Today |
|-------|-------|----------|-----------|------------------------|
| #NNNN | ... | @user | #MMMM | ... |

### Needs Triage

| Issue | Title | Missing Info | Suggested Owner |
|-------|-------|--------------|-----------------|
| #NNNN | ... | repro / owner / severity | @user |

### Trend Clusters

| Cluster | Count | Issues | Severity | Release Risk |
|---------|-------|--------|----------|--------------|
| Onboarding failures | 3 | #1, #2, #3 | high | blocks new-user validation |

## Current Sprint Progress

**Sprint:** Sprint N (YYYY-MM-DD – YYYY-MM-DD)
**Day:** X of Y (Z% elapsed)

| Status | Count |
|--------|-------|
| Done | N |
| In Progress | N |
| Needs Review | N |
| Backlog | N |
| Blocked | N |
| No Status | N |

**Pace:** ahead / on track / behind — explain briefly.

### Sprint Items Relevant to Release

| Item | Title | Status | Assignee | Release Relevance |
|------|-------|--------|----------|-------------------|
| #NNNN | ... | Needs Review | @user | UAT blocker / NV QA / high priority |

## PRs to Act On Today

### Merge Today

| PR | Title | Author | CI/Review | Why Today |
|----|-------|--------|-----------|-----------|
| #NNNN | ... | @user | approved + green | closes NV QA blocker |

### Review Today

| PR | Title | Author | Labels/Status | What to Check |
|----|-------|--------|---------------|---------------|
| #NNNN | ... | @user | Needs Review, UAT | release-risk area |

### Fix / Shepherd Today

| PR | Title | Owner | Blocker | Next Action |
|----|-------|-------|---------|-------------|
| #NNNN | ... | @<user> | CI/rebase/comments | ... |

## `${GH_USER}` Daily Targets

Ranked target list for today:

1. **[Blocker]** #NNNN — action and expected outcome
2. **[Review]** #MMMM — why your review unblocks release/sprint
3. **[Fix]** #PPPP — smallest next step to make it mergeable
4. **[Triage]** #QQQQ — clarify owner/repro/severity

## Release Readiness Decision

State one clear recommendation:

- ✅ **Tag today** — if no blockers and merged payload is stable
- ⚠️ **Tag after these actions** — list exact issues/PRs
- ❌ **Do not tag today** — list blockers and owners

## Risks & Watch Items

- UAT/NV QA trend risk
- Review bottleneck
- CI/E2E risk
- Sprint pace risk
- Unowned high-priority work
```

## Notes

- NemoClaw repo: `${NEMOCLAW_REPO}`
- Worktrees: `${NEMOCLAW_WORKTREE_BASE}/`
- GitHub Project: NVIDIA org, project #199 "NemoClaw Development Tracker"
- Sprint field is an Iteration field named `Sprint`
- User login: `${GH_USER}`
- Use `gh` CLI authenticated as `${GH_USER}`
- Tags follow semver like `v0.0.XX`
- No milestones are used; infer release targeting from tags, merged-since-tag, labels, sprint status, and PR readiness
- Label `priority: high` means the issue should usually be considered for the next release
- Label `NV QA` means bugs found by NVIDIA QA team and should be release-triaged carefully
- Label `UAT` means bugs found during user acceptance testing and should be central to daily release readiness
- Label `security` means potential release blocker
- Some numbers in commit messages are issues, not PRs; always verify with `gh pr view`
