<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Triage Instructions

These instructions are for agents and skills that evaluate NemoClaw issues and PRs before recommending Type, labels, project fields, comments, or follow-up questions.

## Core Rules

- Read `label-taxonomy.md` and `label-taxonomy.json` before suggesting labels.
- Triage from evidence in the item title, body, linked issue, files changed, CI state, and maintainer comments.
- Prefer no label over a guessed label.
- Do not use labels for native issue type, priority, effort, lifecycle status, sprint, or resolution. Daily version labels on issues are tracking and coordination signals only.
- Present dry-run recommendations first unless the agent is already operating inside an explicit authorization context for the proposed write class.
- Keep changes minimal: only add labels or fields that change routing, actionability, or reporting.
- Project Status is a Project field, not a label. Valid values include `No Status`, `Backlog`, `In Progress`, `Blocked`, `Needs Review`, `NV QA`, `Done`, `Won't Fix`, and `Duplicate`.
- Set `human_review_required: true` when the proposed write is outside the current authorization context, has elevated risk, or needs maintainer judgment before execution.

## Issue Flow

1. Classify the issue using native GitHub Issue Type: `Bug`, `Enhancement`, `Task`, `Documentation`, `Epic`, or `Initiative`.
2. Add area labels only when the affected surface is clear.
3. Add platform, provider, or integration labels only with explicit evidence.
4. Add `needs:*` only when an immediate action queue is needed.
5. Recommend Project Priority from impact evidence, not user urgency language.
6. Recommend Project Status separately from labels.
7. Ask for missing information when the report is not actionable.
8. Recommend a daily `v0.0.x` label for an issue only when it is useful for daily tracking, regression attention, or "needs PR" coordination.

## PR Flow

1. Identify whether the PR is draft, conflicted, stale, blocked, or review-ready.
2. Apply exactly one PR type label only when enough evidence exists: `bug-fix`, `feature`, `refactor`, or `chore`.
3. Add `security` when the PR touches credentials, permissions, SSRF, sandbox escape risk, policy enforcement, or trusted installer paths.
4. Add area/platform/provider/integration labels based on files changed and PR intent when useful for review routing.
5. Recommend Project Status `Needs Review` for non-draft, conflict-free PRs that are awaiting maintainer review.
6. Add `needs: rebase` when conflicts or rebase state blocks review.
7. Add `needs: info` when contributor intent or required context is missing.
8. Daily `v0.0.x` labels activate PRs for daily release work; adding one is not a readiness claim.

## Minimal Labeling

Use the smallest label set that makes the item actionable.

For issues, a high-quality dry run often includes:

- Native Issue Type.
- Zero to two area labels.
- Optional platform/provider/integration labels when directly evidenced.
- Optional `needs:*`.
- Project Priority and Status recommendations.
- Optional daily release label only when the issue needs daily tracking, regression attention, or "needs PR" coordination.

For PRs, a high-quality dry run often includes:

- One PR type label.
- Area labels for review routing.
- Optional `security`.
- Optional `needs:*`.
- Project Status recommendation.
- Optional daily release label only when the maintainer workflow activates the PR.

## Confidence Thresholds

Use `confidence` in dry-run output:

| Confidence | Meaning | Write Guidance |
|---|---|---|
| `high` | 80%+ confidence; direct evidence supports the recommendation. | Eligible inside an authorization context. |
| `medium` | 70-79% confidence; evidence is plausible but incomplete. | Eligible inside an authorization context with rationale. |
| `low` | Below 70% confidence; evidence is weak or inferred. | Do not write; ask for info or leave unlabeled. |

Never apply a label from a low-confidence inference.

## When To Ask For Info

Use `needs: info` and ask targeted questions when:

- A bug report lacks reproduction steps, expected behavior, actual behavior, version, environment, or logs.
- A platform-specific claim lacks platform details.
- A provider or integration issue lacks provider/integration configuration.
- A PR does not explain intent, scope, or linked issue and the diff could be interpreted multiple ways.
- A security report lacks enough detail to route safely.

Ask for exact missing fields. Do not ask broad questions like "Can you provide more details?" when specific missing data is known.

## When To Use Needs Labels

- `needs: triage`: Newly created issue or PR needs maintainer review for project workflow assignment, labeling, ownership, or next action.
- `needs: info`: Author action is required before work can proceed.
- `needs: design`: Product or architecture decision is required.
- `needs: rebase`: PR cannot proceed because of conflicts or stale base.
- `needs: unblock`: Blocked item needs a decision or dependency resolved.
- `needs: cleanup-review`: Stale, superseded, competing, convergence-needed, or closure-candidate item needs maintainer judgment.

`needs:*` labels are not lifecycle status. Remove them after the requested action is complete.

## Security Handling

- Add `security` when credentials, permissions, authentication, sandbox escape, SSRF, policy bypass, trusted installers, or vulnerability language is present.
- Mark human review required.
- Use neutral language. Do not confirm exploitability in public comments.
- Recommend private disclosure routing when the item appears to describe an undisclosed vulnerability.

## Dry-Run Output

Use this JSON-compatible shape:

```json
{
  "item_number": 123,
  "item_kind": "issue",
  "issue_type_to_set": "Bug",
  "labels_to_add": ["area: install", "platform: macos", "needs: info"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Priority": "Medium",
    "Status": "Backlog"
  },
  "recommended_action": "ask_for_info",
  "confidence": "medium",
  "human_review_required": true,
  "rationale": {
    "issue_type_to_set": "The report describes broken install behavior.",
    "area: install": "The failure occurs during setup.",
    "platform: macos": "The failure appears macOS-specific.",
    "needs: info": "The report lacks NemoClaw and Docker versions."
  },
  "questions_for_author": [
    "Which NemoClaw version are you using?",
    "Which Docker version are you using?",
    "Can you share the full command and error output?"
  ]
}
```

`labels_to_create` and `labels_to_delete` are only for authorized `agt: *` label operations unless a non-agent label operation is explicitly authorized by the current workflow.

## Comment Guidance

- Keep comments to one or two sentences.
- Explain the immediate action or missing information.
- Thank contributors and assume good intent.
- When useful, address the author by GitHub login and reference the specific behavior, PR, or report.
- Be friendly, specific, and direct; do not use generic filler, sarcasm, or frustration.
- Link to existing docs or prior issues when they answer the question better than repeating guidance inline.
- For `needs: info`, ask for exact missing details.
- For security, avoid exploit confirmation.
- For duplicate recommendations, include the canonical item and recommend Project Status or close reason `Duplicate`.
- For superseded or competing-work recommendations, include the canonical or related item if known.
- Use response-specific maintainer guidance for longer community replies, stale handling, closure decisions, or reusable templates.

## Examples

### Bug With Missing Environment

Recommendation:

- Native Issue Type: `Bug`
- Labels: `area: install`, `platform: macos`, `needs: info`
- Priority: `Medium`
- Status: `Backlog`

Comment:

> Thanks for the report. Please share the NemoClaw version, Docker version, macOS version, and the full install error so maintainers can reproduce it.

### Docs Issue

Recommendation:

- Native Issue Type: `Documentation`
- Labels: `area: docs`
- No `documentation` label

### Review-Ready PR

Recommendation:

- Labels: `bug-fix`, `area: cli`
- Project Status: `Needs Review`
- Do not add a daily version label unless the maintainer day workflow activates it.

### Anti-Examples

- Do not add `bug` to a new issue. Set native Issue Type `Bug`.
- Do not add `status: triage`; use `needs: triage` only if an action queue is still needed.
- Do not add `priority: high`; recommend Project Priority instead.
- Do not treat an issue `v0.0.x` label as release inclusion; PR labels own daily release activation.
- Do not add `needs: review`; use Project Status `Needs Review` for review-ready PRs.
