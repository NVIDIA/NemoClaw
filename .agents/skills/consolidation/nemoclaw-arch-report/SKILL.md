---
name: nemoclaw-arch-report
description: Examine NemoClaw architectural trends, refactoring direction, and progress. Produces a local report artifact in NemoClaw-working/.agent-reports/. Analyzes merged refactor PRs, open arch-improve issues, contributor patterns (core maintainers), and overall codebase direction. Use when asking "architecture status", "refactoring progress", "where are we architecturally", "arch report", "refactor direction", or "codebase trends".
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---


<!-- markdownlint-disable MD022 MD026 MD031 MD032 MD036 MD040 MD058 -->

# NemoClaw Architecture Report

Analyze the architectural evolution of the NemoClaw codebase — what's been refactored, what direction the team is heading, and what remains. Produces a timestamped report artifact stored locally.

## When to Use

- When asking about refactoring progress or architectural direction
- When preparing for planning or sprint review that involves arch context
- When other skills (e.g., sprint-review) need to reference current arch state
- When evaluating whether NV QA bugs relate to refactoring work

## Output Artifact

Reports are saved to: `${NEMOCLAW_WORKTREE_BASE}/arch-reports/arch-report-YYYY-MM-DD.md`

This location (outside `.agent-local/`) is intentional so the report is easily referenceable from within an agent session.

Create the directory if it doesn't exist:
```bash
mkdir -p ${NEMOCLAW_WORKTREE_BASE}/arch-reports
```

## Process

### Step 1: Gather Open Architectural Issues

Query issues labeled `arch-improve` (architecture label for architectural work):

```bash
cd ${NEMOCLAW_REPO} && gh issue list --label "arch-improve" --state open --limit 50
```

Also gather open `refactor` label issues:

```bash
cd ${NEMOCLAW_REPO} && gh issue list --label "refactor" --state open --limit 50
```

And closed/completed ones from the last 30 days for momentum tracking:

```bash
cd ${NEMOCLAW_REPO} && gh issue list --label "arch-improve" --state closed --search "closed:>=YYYY-MM-DD" --limit 50
cd ${NEMOCLAW_REPO} && gh issue list --label "refactor" --state closed --search "closed:>=YYYY-MM-DD" --limit 50
```

### Step 2: Gather Merged Refactoring PRs by Contributor

Analyze the last 30 days of merged refactoring work from key contributors:

```bash
cd ${NEMOCLAW_REPO} && gh pr list --label "refactor" --state merged --search "merged:>=YYYY-MM-DD" --limit 100
cd ${NEMOCLAW_REPO} && gh pr list --author <maintainer> --state merged --search "merged:>=YYYY-MM-DD" --limit 50
cd ${NEMOCLAW_REPO} && gh pr list --author <maintainer> --state merged --search "merged:>=YYYY-MM-DD" --limit 50
cd ${NEMOCLAW_REPO} && gh pr list --author <maintainer> --state merged --search "merged:>=YYYY-MM-DD" --limit 50
cd ${NEMOCLAW_REPO} && gh pr list --author ${GH_USER} --state merged --search "merged:>=YYYY-MM-DD" --limit 50
```

### Step 3: Identify Refactoring Themes from PR Titles

Group the merged refactor PRs into architectural themes by analyzing PR title patterns. Look for:

- **CLI layer restructuring** — oclif migration, command tree reorganization, module grouping
- **Module extraction** — extracting monolithic files into focused modules
- **TypeScript migration** — @ts-nocheck removal, type safety improvements
- **Security hardening** — credential isolation, secret redaction, shields
- **Infrastructure/CI** — test boundaries, import constraints, CI checks
- **Domain separation** — separating sandbox/docker/openshell/state concerns
- **Onboard decomposition** — breaking up the onboard monolith

For each theme, note:
- How many PRs in the last 30 days
- Which contributors are driving it
- Whether it has an open tracking issue

### Step 4: Assess Current Direction

Based on the PR velocity and themes, characterize:

1. **Primary refactoring vector** — What is the dominant architectural change happening right now?
2. **Secondary vectors** — What other refactoring efforts are active but smaller?
3. **Stalled efforts** — Issues labeled `arch-improve` or `refactor` with no recent PR activity
4. **Emerging patterns** — New architectural directions visible in recent PRs that don't have tracking issues yet

### Step 5: Examine Open PRs with Architectural Impact

```bash
cd ${NEMOCLAW_REPO} && gh pr list --label "refactor" --state open --limit 30
cd ${NEMOCLAW_REPO} && gh pr list --label "experimental" --state open --limit 10
```

Note any open PRs that:
- Touch shared infrastructure (onboard, sandbox, gateway, CLI core)
- Introduce new patterns or abstractions
- Have the `experimental` label (requires consensus from all maintainers)

### Step 6: Map Codebase Health Indicators

Check for structural signals:

```bash
# How many @ts-nocheck files remain (TypeScript migration progress)
cd ${NEMOCLAW_REPO} && grep -rl "@ts-nocheck" src/ | wc -l 2>/dev/null

# Check layer boundary test (if it exists)
cd ${NEMOCLAW_REPO} && find . -name "*.test.*" -path "*layer*" -o -name "*.test.*" -path "*boundary*" 2>/dev/null | head -5
```

### Step 7: Produce the Report

Write the report to `${NEMOCLAW_WORKTREE_BASE}/arch-reports/arch-report-YYYY-MM-DD.md` with this structure:

```markdown
# NemoClaw Architecture Report — YYYY-MM-DD

## Executive Summary
One paragraph summarizing where we are and what direction we're heading.

## Primary Refactoring Vector
Description of the dominant architectural change with contributor attribution.

### Recent Merged Work (last 30 days)
- PR #NNNN — title (author, date)
- ...

### Open Tracking Issues
- #NNNN — title

## Secondary Vectors

### [Theme Name]
Description, PRs, contributors, status.

## Stalled / Backlog Architectural Work
Issues that are open but have no recent activity.

## Codebase Health Indicators
- TypeScript migration: X files with @ts-nocheck remaining
- Layer boundaries: enforced/not-enforced
- Key monoliths: what large files remain

## Architectural Risks
- Areas where refactoring velocity could introduce bugs
- Modules being actively changed that NV QA bugs cluster around
- Concurrent refactoring that could conflict

## Contributor Activity (Architectural Work)

| Contributor | Refactor PRs (30d) | Primary Focus |
|-------------|--------------------:|---------------|
| <maintainer>          | N | ... |
| <maintainer>   | N | ... |
| <maintainer>    | N | ... |
| ${GH_USER}   | N | ... |
```

### Step 8: Present Summary

After writing the artifact, present a concise summary to the user highlighting:
1. The primary direction
2. Key risks or conflicts with NV QA bugs
3. What's stalled and may need attention

## Notes

- The NemoClaw repo is at `${NEMOCLAW_REPO}`
- Reports live at `${NEMOCLAW_WORKTREE_BASE}/arch-reports/` (not version controlled — local only; placed outside `.agent-local/` so agent sessions can reference them)
- Key contributors to watch: core maintainers
- Labels: `arch-improve` (architecture-related issues), `refactor`, `experimental`
- The `experimental` label means "has architectural implications, requires consensus from all maintainers"
- This report is consumed by the sprint-review skill's NV QA triage section
