<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Project Workflow

This workflow explains how GitHub Project fields support NemoClaw's daily operating flow. The timeboxed daily cadence, priority lanes, and release handoff live in `daily-flow.md`.

## Fields

| Concept | Source Of Truth |
|---|---|
| Issue classification | Native GitHub Issue Type |
| PR classification | PR type labels |
| Priority | GitHub Project Priority field |
| Effort | GitHub Project Effort field |
| Start date | GitHub Project Start date field |
| Target date | GitHub Project Target date field |
| Lifecycle | GitHub Project Status field |
| Resolution | GitHub close reason, linked issue/PR, maintainer comment, and logs |
| Release activation | Daily `v0.0.x` labels on PRs |
| Release tracking | Daily `v0.0.x` labels on issues when used as attention or "needs PR" signals |

## Project Status

Use the Project Status field for durable workflow state:

| Status | Meaning |
|---|---|
| `No Status` | Item is not yet placed in the project workflow. |
| `Backlog` | Accepted or tracked work that is not currently active. |
| `In Progress` | Work has an owner and active implementation, investigation, or coordination is happening. |
| `Blocked` | Work cannot proceed until a dependency, decision, access issue, or external input is resolved. |
| `Needs Review` | Work needs maintainer review, PR review, or assignment review before it can move forward. |
| `NV QA` | Work is ready for, under, or awaiting NVIDIA QA validation. |
| `Done` | Work is complete for the project workflow. |
| `Won't Fix` | Maintainer decision is not to pursue the work. |
| `Duplicate` | Item is represented by another canonical issue or PR. |

Status is not a label. `needs:*` labels may create action queues, but the Project Status field owns lifecycle state.

## Daily Slate Workflow

The daily slate starts from the priority lanes in `daily-flow.md`:

1. QA TEST Blockers.
2. QA regressions or new bugs from the Last release tag.
3. High-impact accepted sprint work.
4. Ready PRs.
5. Existing WIP.

For each recommended daily item, agents should report:

- Item number and kind.
- Priority lane.
- Current Project Status.
- Suggested owner or owner gap.
- Next action.
- End-of-day exit signal.
- Whether a PR exists, is needed, or is already merged.
- Whether a daily `v0.0.x` label is present on the PR, issue, or both.

Standup converts the recommendation into assignments. Every recommended item should leave standup either assigned with a next action and exit signal, or explicitly deferred with rationale.

## Release Labels In Project Context

Daily `v0.0.x` labels have different meanings by item kind:

- On PRs, the label activates the PR for daily release work. Merged PRs carrying the daily label are candidates for the daily release cutoff.
- On issues, the label is an attention, regression-tracking, or "needs PR for this daily release" signal. It does not include the issue in the release by itself.

Open labeled PRs carry forward until the label is removed. Open issues may keep or lose daily labels according to maintainer judgment and the current daily slate.

## Issue Templates

Issue forms must set native `type`.

- Bug forms set `type: Bug`.
- Feature request forms set `type: Enhancement`.
- Documentation issue forms set `type: Documentation`.
- Internal maintainer work should use `type: Task`.

New issue forms should default `labels: ["needs: triage"]` so maintainers can review project workflow assignment, labeling, ownership, and next action.

Issue forms must not default deprecated labels such as `bug`, `enhancement`, `documentation`, or `status: triage`.

## Labels

Labels are for routing, reproduction surfaces, immediate action queues, community contribution signals, PR type, PR release activation, and issue release tracking.

Do not use labels for:

- Issue type.
- Priority.
- Effort.
- Dates.
- Lifecycle.
- Resolution.
- Sprint.

## Agent Writes

Agents should emit a dry-run plan containing labels, field changes, comments, and rationale unless they are already operating inside an explicit authorization context for the proposed write class.

When writes are authorized:

1. Apply field updates first.
2. Add canonical labels.
3. Post comments only when the authorization context covers the exact comment text or intent.
