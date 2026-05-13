---
name: nemoclaw-sprint-review
description: Review the current NemoClaw sprint progress, show status breakdown, your work involvement, NV QA/UAT bug triage with trend analysis, and architecture alignment. Use when asking "sprint review", "sprint progress", "how's the sprint going", "sprint dashboard", "what's in the sprint", "sprint status", "QA triage", or "bug trends".
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---

# NemoClaw Sprint Review

Analyze the current NemoClaw sprint from the GitHub Projects board to show progress, your involvement, and suggestions for moving work forward.

## When to Use

- When asked about sprint progress or status
- When asked "how's the sprint going?"
- When preparing for standup or sprint review meetings
- When looking for ways to help the team

## Process

### Step 1: Identify the Current Sprint

Query the NemoClaw Development Tracker (GitHub Project #199) to find the active sprint iteration.

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
              iterations {
                id
                title
                startDate
                duration
              }
              completedIterations {
                id
                title
                startDate
                duration
              }
            }
          }
        }
      }
    }
  }
}'
```

The sprint field is an **Iteration** field named "Sprint". Pick the iteration whose date range includes today.

### Step 2: Collect All Sprint Items (Paginated)

The project has 1400+ items. Sprint items are spread across all pages, so you **must paginate through all items**.

Use the helper script from the repository skill directory:

```bash
SCRIPT=".agents/skills/consolidation/nemoclaw-sprint-review/collect_sprint_items.py"
test -f "$SCRIPT" || SCRIPT=".agents/skills/nemoclaw-sprint-review/collect_sprint_items.py"
python3 "$SCRIPT" "Sprint 3" > /tmp/sprint_data.json
```

The script outputs a JSON array of items with: number, title, state, status, assignees, labels, type (Issue/PR), author.

If the script doesn't exist or fails, manually paginate the GraphQL API (see Step 2a below).

### Step 2a: Manual Pagination (Fallback)

Query `organization(login: "NVIDIA") { projectV2(number: 199) { items(first: 100, after: $CURSOR) { ... } } }` in a loop.

For each item, check `fieldValues` for `ProjectV2ItemFieldIterationValue` where `field.name == "Sprint"` and `title` matches the target sprint.

Extract from each matching item:
- `content.number`, `content.title`, `content.state`
- `content.assignees.nodes[].login`
- `content.labels.nodes[].name`
- Status from `ProjectV2ItemFieldSingleSelectValue` where `field.name == "Status"`
- Whether it's a PR (has `author` field) or Issue

### Step 3: Compute Metrics

From the collected data, calculate:

1. **Progress bar** — % Done vs total items, compared to % of sprint elapsed
2. **Status breakdown** — Done, In Progress, Needs Review, Backlog, No Status, Blocked
3. **Velocity check** — Are we ahead or behind pace? (done% vs time-elapsed%)

### Step 4: Identify Your (${GH_USER}) Involvement

- Items **assigned to you** grouped by status
- PRs **you authored** in this sprint
- PRs in **Needs Review** that you could review
- Issues assigned to you that are stalled

### Step 5: Find Opportunities to Help

Analyze the sprint data to suggest actionable ways to help:

1. **Unassigned PRs in Needs Review** — these are quick wins; reviewing and merging them unblocks work
2. **Unassigned high-priority / security issues** — pick one up
3. **Blocked items** — can you help unblock?
4. **Stale In-Progress items** — items with no recent activity; ping the assignee or offer help
5. **PRs with `status: rebase` label** — may just need a rebase to be mergeable

### Step 6: Present the Dashboard

Present the sprint dashboard directly in the response (not canvas_document, since it may not be available in all contexts).

#### Report Format

```
# Sprint N Dashboard

**Sprint:** Sprint N (Apr DD – May DD, YYYY)
**Day:** X of Y (ZZ% elapsed)

## Progress

████████████░░░░░░░░ 48% Done (104/216)
██████░░░░░░░░░░░░░░ 27% Time Elapsed

[AHEAD/ON TRACK/BEHIND] — done% vs elapsed%

## Status Breakdown

| Status | Count | Bar |
|--------|-------|-----|
| ✅ Done | 104 | ████████████████████ |
| 🔄 In Progress | 36 | ████████ |
| 👀 Needs Review | 27 | ██████ |
| 📋 Backlog | 20 | █████ |
| ❓ No Status | 27 | ██████ |
| 🚫 Blocked | 1 | ▌ |

## Your Work (${GH_USER})

### Active
- [In Progress] #NNNN — title
- [Needs Review] #NNNN — title

### Completed This Sprint
- [Done] #NNNN — title (×N)

### Backlog
- [Backlog] #NNNN — title

## 🎯 How You Can Help Move the Sprint

### 1. Review & Merge Unblocked PRs (Needs Review)
List unassigned PRs in Needs Review — quick wins.

### 2. Pick Up Unassigned High-Priority Work
List unassigned high-pri or security issues in In Progress or Backlog.

### 3. Unblock Stalled Work
List items you could help with.

### 4. Team Workload
Per-person summary showing who's overloaded.
```

### Step 7: NV QA / UAT Bug Triage

Query all open bugs from the NV QA team and UAT testing:

```bash
cd ${NEMOCLAW_REPO} && gh issue list --label "NV QA" --state open --limit 50
cd ${NEMOCLAW_REPO} && gh issue list --label "UAT" --state open --limit 50
```

#### 7a: Identify Trends

Group NV QA/UAT bugs by trend clusters:

1. **By platform** — macOS, Ubuntu, DGX Spark, WSL2, Brev, Jetson, All Platforms
2. **By user-experience area** — onboarding, CLI/UX, recovery/resilience, inference, security, sandbox, networking
3. **By codebase area** — map bugs to likely source modules (onboard, sandbox, gateway, CLI, shields, docker)
4. **By severity signal** — priority:high + security labels indicate critical clusters

Present as a trend table:

```
| Trend Cluster | Count | Issues | Severity |
|---------------|-------|--------|----------|
| Onboard resilience (exit-0 on failure) | 3 | #3115, #2770, #3110 | high |
| Shields/security state bugs | 3 | #3112, #3117, #3105 | high/security |
| ...
```

#### 7b: Overlap with Your Current Work

Cross-reference NV QA/UAT bugs against:
- Your assigned issues in the current sprint
- Your worktrees in `${NEMOCLAW_WORKTREE_BASE}/`
- PRs you authored that are open or recently merged

Identify:
- Bugs that touch the same code you're actively working on
- Bugs you could fix as a side-effect of current work
- Bugs that your recent merged PRs may have introduced or exposed

#### 7c: Relationship to Refactoring / Architecture Work

Reference the architecture report artifact:

```bash
# Find the most recent arch report
ls -t ${NEMOCLAW_WORKTREE_BASE}/.agent-reports/arch-report-*.md 2>/dev/null | head -1
```

If no recent report exists (or it's older than 7 days), run the `nemoclaw-arch-report` skill first to generate one.

Using the arch report context, analyze each NV QA/UAT bug cluster to determine:

1. **Caused by refactoring** — Did recent refactor PRs (especially from `<maintainer>`, `<maintainer>`, `<maintainer>`) introduce or expose these bugs? Check if bug filing dates correlate with merge dates of refactor PRs touching the same area.

2. **Opportunity to fix during refactoring** — Bugs in modules that are actively being refactored present a natural opportunity. Flag these as "fix while refactoring" candidates.

3. **Blocked until refactoring completes** — Some bugs may be in code that's about to be rewritten. Flag these as "defer — will be addressed by arch work".

4. **Indicates need for NEW refactoring** — Bug clusters that reveal architectural fragility not yet addressed by any open `arch-improve` issue. Recommend creating a new tracking issue.

Present this as:

```
## NV QA × Architecture Alignment

### Likely Introduced by Refactoring
- #NNNN — correlates with PR #MMMM (<maintainer>, merged May 4)

### Fix During Active Refactoring (opportunity)
- #NNNN — module X is being refactored by [contributor], include fix

### Defer (will be addressed by arch work)
- #NNNN — onboard monolith decomposition will resolve this

### Indicates New Architectural Gap
- Cluster: [shields state management] — 3 bugs, no arch-improve issue exists
  → Recommend: file arch-improve issue for shields state machine
```

### Step 8: Highlight Risks

Call out:
- **Pace risk** — are we behind schedule?
- **Concentration risk** — too much work on one person?
- **Review bottleneck** — too many PRs waiting for review?
- **Security debt** — open security items that should be prioritized
- **QA trend risk** — NV QA bug clusters growing in a specific area
- **Refactor regression risk** — bugs correlating with recent refactoring merges

## Notes

- The NemoClaw repo is at `${NEMOCLAW_REPO}`
- GitHub Project: NVIDIA org, project #199 "NemoClaw Development Tracker"
- Sprint field is an Iteration field named "Sprint"
- Status values: No Status, NV QA, Backlog, In Progress, Blocked, Needs Review, Done, Won't Fix, Duplicate
- User login: `${GH_USER}`
- Use `gh` CLI (authenticated to github.com as `${GH_USER}`) for all GitHub API queries
