<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Daily Maintainer Flow

This file defines NemoClaw's daily operating runbook. It tells maintainers, TPMs, and agents how to turn QA results, GitHub issues, PRs, Project fields, and daily release labels into a daily slate of assigned work and a release handoff. It does not define label taxonomy or durable Project field meanings; those live in the companion reference files.

Daily labels are coordination signals, not readiness claims. PR labels own release inclusion. Issue labels may be used for daily attention, regression tracking, or "needs PR for this daily release" signals.

## Morning Inputs

Agents preparing a daily recommendation should synthesize:

- QA evidence for the Last release tag: blockers, regressions, release risks, and known issue or bug mappings.
- Sprint and GitHub evidence: accepted scope, open PRs, open issues, linked work, current WIP, and Project fields.
- Capacity signals: owner availability, recent throughput, readiness, risk, blockers, and review load.

## Daily Flow

The daily flow is an outline, not a rigid ceremony.

| Step | Phase | Purpose |
|---:|---|---|
| 1 | QA Evidence | Capture validation results from the Last release tag and identify blockers, regressions, risks, and unmapped findings. |
| 2 | Intake | Reconcile QA, GitHub, sprint, release-label, and WIP evidence into a candidate inventory. |
| 3 | Capacity | Estimate what can realistically move today based on readiness, ownership, review load, and risk. |
| 4 | Recommend | Publish a daily standup slate grouped by priority lane with suggested owners, next actions, and decision gaps. |
| 5 | Assign | Maintainers convert the recommendation into assignments, deferrals, or follow-up questions. |
| 6 | Execute | Engineers drive the assigned slate toward merge, fix, unblock, PR creation, or explicit deferral. |
| 7 | Release | The daily release is cut from merged PRs carrying the daily version label. |
| 8 | Handoff | Summarize what shipped, what slipped, what QA should focus on, and what should seed the next cycle. |

## Priority Order

Highest applicable lane wins. A ready PR that fixes a QA TEST Blocker belongs in Lane 1, not Lane 4.

| Rank | Lane | Meaning |
|---:|---|---|
| 1 | QA TEST Blockers | Items blocking QA from completing validation. |
| 2 | QA bugs | Regressions or new bugs found against the Last release tag. |
| 3 | Sprint impact | Accepted sprint work tied to current exit criteria or high-impact goals. |
| 4 | Ready PRs | Low-risk PRs close to merge-ready that should not linger. |
| 5 | Existing WIP | Active owned work that affects capacity or assignment planning. |

## Daily Recommendation

A daily recommendation should make the next decision easy. Include:

- Item number and kind.
- Priority lane.
- Current Project Status.
- Suggested owner or owner gap.
- Next action.
- End-of-day exit signal.
- PR state: missing, open, blocked, reviewable, merge-ready, or merged.
- Issue state when the PR is linked to an issue or an issue needs a PR.
- Daily label state on the PR, issue, or both.
- Decision gaps or questions for maintainers.

## Write Boundary

Daily-flow reports are read-only by default.

Agents may recommend labels, assignments, Project field changes, comments, merges, releases, and follow-up questions. They may perform writes only inside an explicit authorization context for that write class, such as accepted triage suggestions, maintainer-directed work, or named release automation.

## Release Boundary

- A PR daily version label activates daily release work; it is not a readiness claim.
- Release inclusion requires a PR to be both merged and carrying the relevant daily version label at release cutoff.
- Issue daily version labels are tracking or coordination signals only.
- Open PRs with daily version labels carry forward until the label is removed.
- Durable release history belongs in releases, release notes, or manifests, not in long-lived labels.
