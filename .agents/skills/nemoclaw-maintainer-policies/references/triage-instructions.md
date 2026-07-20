<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Triage Instructions

Use these instructions to evaluate NemoClaw issues and PRs.
They apply to Issue Type, labels, Project fields, comments, and questions.

## Core Rules

- Read `label-taxonomy.md` and `label-taxonomy.json` before suggesting labels.
- Use evidence from the title, body, linked issue, changed files, CI state, and maintainer comments.
- Prefer no label over a guessed label.
- Do not use labels for native issue type, priority, effort, lifecycle status, sprint, or resolution. Daily version labels on issues are tracking and coordination signals only.
- Show a dry run before a write unless the request authorizes that write.
- Add only labels or fields that change routing, action, or reporting.
- Project Status is a Project field, not a label. Valid values include `No Status`, `Backlog`, `In Progress`, `Blocked`, `Needs Review`, `NV QA`, `Done`, `Won't Fix`, and `Duplicate`.
- Set `human_review_required: true` when the write lacks authorization, adds risk, or needs maintainer judgment.
- Do not add `needs: triage` during triage.
  Use `questions_for_author` without a `needs:*` label when the item can still progress.
- Do not recommend `PRR` during triage. Maintainers and PRR workflows reserve this label for Product Readiness Reviews.

## Issue Flow

1. Classify the issue using native GitHub Issue Type: `Bug`, `Enhancement`, `Task`, `Documentation`, `Epic`, or `Initiative`.
2. Add area labels only when the affected surface is clear.
3. Require evidence for platform, provider, and integration labels.
   If a listed integration is the affected subject, add its `integration:*` label.
   Do not use only `area: integrations`.
   Map LangChain Deep Code, Deep Code, `langchain-deepagents-code`, and `dcode` to `integration: dcode`.
4. Add `needs:*` only when an immediate blocking action queue is needed. Do not add `needs: triage` during normal triage.
5. Recommend Project Priority from impact evidence, not user urgency language.
6. Recommend Project Status separately from labels.
7. Ask for missing information when the report is not actionable.
8. Recommend a daily `v0.0.x` label for an issue only when it is useful for daily tracking, regression attention, or "needs PR" coordination.

## PR Flow

1. Identify whether the PR is draft, conflicted, stale, blocked, or review-ready.
2. Apply one PR type label when evidence supports it: `bug-fix`, `feature`, `refactor`, or `chore`.
   Treat commit prefixes as evidence, not proof.
   Map `fix` to `bug-fix`, `feat` to `feature`, and `refactor` to `refactor`.
   Map `chore`, docs-only, CI-only, skill, dependency, packaging, and generated-policy maintenance to `chore`.
3. Add `security` when the PR touches credentials, permissions, SSRF, sandbox escape risk, policy enforcement, or trusted installer paths.
4. Add area/platform/provider/integration labels based on files changed and PR intent when useful for review routing.
5. Recommend Project Status `Needs Review` for non-draft, conflict-free PRs that are awaiting maintainer review.
6. Add `needs: rebase` when conflicts or rebase state blocks review.
7. Add `needs: info` only when contributor action blocks review.
   If the existing content supports routing, ask optional questions without this label.
8. Daily `v0.0.x` labels activate PRs for daily release work. A label does not state that the PR is ready.

## Minimal Labeling

Use the smallest label set that makes the item actionable.

For issues, include these fields when they apply:

- Native Issue Type.
- Zero to two area labels.
- Optional platform/provider/integration labels when directly evidenced.
- Optional blocking `needs:*`. Do not add `needs: triage` in normal triage output.
- Project Priority and Status recommendations.
- Optional daily release label only when the issue needs daily tracking, regression attention, or "needs PR" coordination.

For PRs, include these fields when they apply:

- One PR type label.
- Area labels for review routing.
- Optional `security`.
- Optional blocking `needs:*`. Do not add `needs: triage` in normal triage output.
- Project Status recommendation.
- Optional daily release label only when the maintainer workflow activates the PR.

## Confidence Thresholds

Use `confidence` in dry-run output:

| Confidence | Meaning | Write Guidance |
|---|---|---|
| `high` | 80% or more confidence. Direct evidence supports the recommendation. | Eligible inside an authorization context. |
| `medium` | 70–79% confidence. Evidence is plausible but incomplete. | Eligible inside an authorization context with rationale. |
| `low` | Below 70% confidence. Evidence is weak or inferred. | Do not write. Ask for information or leave the item unlabeled. |

Never apply a label from a low-confidence inference.

## When To Ask For Info

Add `needs: info` only when the author must give information before work can continue:

- A bug report lacks the specific reproduction steps, expected behavior, actual behavior, version, environment, or logs needed to route or investigate it.
- A platform-specific claim lacks platform details.
- A provider or integration issue lacks provider/integration configuration.
- A PR does not explain intent, scope, or linked issue and the diff could be interpreted multiple ways.
- A security report lacks enough detail to route safely.

Name the missing fields. Do not ask for "more details" when you know which details are missing.

## When To Use Needs Labels

- `needs: triage`: Inbox label for items that have not been processed.
  Do not add it when you produce Type, label, and Project-field recommendations.
- `needs: info`: Author action is required before work can proceed. Optional questions are not enough.
- `needs: design`: Product or architecture decision is required and implementation cannot proceed from the current report.
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

Without authorization for label writes, keep `labels_to_add` and `labels_to_remove` as dry-run output and do not change labels.
An authorized agent-owned workflow may add or remove only `agt: *` labels.
Create or delete labels only when the workflow authorizes that operation, with the same `agt: *` limit for agent-owned workflows.
An accepted maintainer write set can authorize canonical non-agent label changes.

## Comment Guidance

- Keep comments to one or two sentences.
- State the required action or missing information.
- Thank contributors and assume good intent.
- Address the author by GitHub login when useful. Name the behavior, PR, or report.
- Use direct and specific language. Do not use filler, sarcasm, or frustration.
- Link to existing docs or prior issues when they answer the question better than repeating guidance inline.
- For `needs: info`, ask for the missing details.
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
- Do not add `status: triage` or `needs: triage` from normal triage output.
- Do not add `priority: high`. Recommend Project Priority instead.
- Do not treat an issue `v0.0.x` label as release inclusion. PR labels control daily release activation.
- Do not add `needs: review`. Use Project Status `Needs Review` for review-ready PRs.
- Do not add `PRR`. This label is reserved, and triage must not suggest it.
