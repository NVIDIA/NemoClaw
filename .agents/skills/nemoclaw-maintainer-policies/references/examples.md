<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer Examples

These examples show the expected shape of agent recommendations. They are examples, not extra taxonomy; use `workflow-policy.md`, `triage-instructions.md`, `label-taxonomy.md`, `project-workflow.md`, `daily-flow.md`, and `release-train.md` as the source of truth.

## Issue Triage Examples

### Bug Report With Missing Environment

Evidence:

- User reports `nemoclaw onboard` fails on macOS.
- The failure appears macOS-specific, not merely tested on macOS.
- Reproduction steps are present.
- Docker and NemoClaw versions are missing.

Dry run:

```json
{
  "item_number": 101,
  "item_kind": "issue",
  "issue_type_to_set": "Bug",
  "labels_to_add": ["area: onboarding", "platform: macos", "needs: info"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Priority": "Medium",
    "Status": "Backlog"
  },
  "recommended_action": "ask_for_info",
  "confidence": "high",
  "rationale": {
    "issue_type_to_set": "The report describes broken onboarding behavior.",
    "area: onboarding": "The failure occurs during `nemoclaw onboard`.",
    "platform: macos": "The report indicates the failure is specific to macOS.",
    "needs: info": "The report lacks NemoClaw and Docker versions."
  },
  "questions_for_author": [
    "Which NemoClaw version are you using?",
    "Which Docker version are you using?",
    "Can you share the full error output from `nemoclaw onboard`?"
  ],
  "human_review_required": false
}
```

Comment:

> Thanks for the report. Please share your NemoClaw version, Docker version, and the full error output from `nemoclaw onboard` so maintainers can reproduce this.

### Documentation Report

Evidence:

- User reports a broken quickstart link.

Dry run:

```json
{
  "item_number": 102,
  "item_kind": "issue",
  "issue_type_to_set": "Documentation",
  "labels_to_add": ["area: docs"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Status": "Backlog"
  },
  "recommended_action": "route_to_docs",
  "confidence": "high",
  "rationale": {
    "issue_type_to_set": "The report describes incorrect or broken documentation.",
    "area: docs": "The affected surface is documentation."
  },
  "questions_for_author": [],
  "human_review_required": false
}
```

Anti-examples:

- Do not add `documentation`; set native Issue Type `Documentation`.
- Do not add `status: triage` or `needs: triage` from normal triage output.

### Named Integration Issue

Evidence:

- The title is `[hermes] Missing hermes TUI`.
- The affected subject is the Hermes integration.

Dry run:

```json
{
  "item_number": 104,
  "item_kind": "issue",
  "issue_type_to_set": "Bug",
  "labels_to_add": ["integration: hermes", "area: ui"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Status": "Backlog"
  },
  "recommended_action": "triage",
  "confidence": "high",
  "rationale": {
    "issue_type_to_set": "The report describes missing expected UI behavior.",
    "integration: hermes": "The title names Hermes as the affected integration.",
    "area: ui": "The missing surface is the TUI."
  },
  "questions_for_author": [],
  "human_review_required": false
}
```

Anti-examples:

- Do not use only `area: integrations` when a listed integration such as Hermes is the affected subject.
- Do not add `needs: info` if the title and body already provide enough routing evidence.

### OpenClaw E2E Failure

Evidence:

- The title includes `openclaw-tui-chat-correlation-e2e`.
- The report is a nightly/e2e failure involving OpenClaw.

Dry run:

```json
{
  "item_number": 105,
  "item_kind": "issue",
  "issue_type_to_set": "Bug",
  "labels_to_add": ["area: e2e", "area: ci", "integration: openclaw"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Status": "Backlog"
  },
  "recommended_action": "triage",
  "confidence": "high",
  "rationale": {
    "issue_type_to_set": "The report describes a failing validation path.",
    "area: e2e": "The affected test is an e2e flow.",
    "area: ci": "The failure is from nightly validation infrastructure.",
    "integration: openclaw": "The test name identifies OpenClaw as the affected integration."
  },
  "questions_for_author": [],
  "human_review_required": false
}
```

### Windows ARM Install Failure In WSL

Evidence:

- The title includes `[Windows ARM][Install]`.
- The body says WSL2 has no Ubuntu distro.

Dry run:

```json
{
  "item_number": 106,
  "item_kind": "issue",
  "issue_type_to_set": "Bug",
  "labels_to_add": ["area: install", "platform: windows", "platform: arm64", "platform: wsl"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Status": "Backlog"
  },
  "recommended_action": "triage",
  "confidence": "high",
  "rationale": {
    "issue_type_to_set": "The report describes broken install behavior.",
    "area: install": "The failure occurs during installation.",
    "platform: windows": "The title identifies Windows as the host platform.",
    "platform: arm64": "The title identifies Windows ARM.",
    "platform: wsl": "The body identifies WSL2 as part of the failing setup."
  },
  "questions_for_author": [],
  "human_review_required": false
}
```

### Feature Request Needing Design

Evidence:

- User proposes adding a new local inference provider.
- The request affects provider architecture and user-facing capability.
- Design and compatibility expectations are incomplete.

Dry run:

```json
{
  "item_number": 103,
  "item_kind": "issue",
  "issue_type_to_set": "Enhancement",
  "labels_to_add": ["area: providers", "area: local-models", "needs: design"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Priority": "Low",
    "Status": "Backlog"
  },
  "recommended_action": "request_design_direction",
  "confidence": "medium",
  "rationale": {
    "issue_type_to_set": "The request proposes new user-visible capability.",
    "area: providers": "The proposal adds provider behavior.",
    "area: local-models": "The proposal concerns local inference.",
    "needs: design": "Provider behavior and compatibility expectations need maintainer direction."
  },
  "questions_for_author": [
    "Which local provider or runtime should this support?",
    "What user workflow should this enable?"
  ],
  "human_review_required": false
}
```

### Daily Issue Tracking

Evidence:

- QA reports a regression against the Last release tag.
- No PR exists yet.
- Maintainer wants the issue visible in the daily slate so a PR can be opened or assigned.
- Current daily label is `v0.0.8`.

Dry run:

```json
{
  "item_number": 104,
  "item_kind": "issue",
  "issue_type_to_set": "Bug",
  "labels_to_add": ["area: e2e", "v0.0.8"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Priority": "High",
    "Status": "Needs Review"
  },
  "recommended_action": "assign_or_open_pr_for_daily_release",
  "confidence": "high",
  "rationale": {
    "issue_type_to_set": "The item is a regression found against the Last release tag.",
    "area: e2e": "The evidence comes from end-to-end validation.",
    "v0.0.8": "The issue needs PR work or regression follow-up for the daily tag; this is not release inclusion."
  },
  "questions_for_author": [],
  "human_review_required": true
}
```

Anti-example:

- Do not treat an issue `v0.0.x` label as release inclusion. A PR must be merged with the relevant daily version label to enter the release.

## PR Examples

### Review-Ready Bug Fix

Evidence:

- PR fixes CLI argument parsing.
- Linked issue has native Issue Type `Bug`.
- PR is not draft, has no conflicts, and is awaiting maintainer review.

Dry run:

```json
{
  "item_number": 201,
  "item_kind": "pull_request",
  "issue_type_to_set": null,
  "labels_to_add": ["bug-fix", "area: cli"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Status": "Needs Review"
  },
  "recommended_action": "request_maintainer_review",
  "confidence": "high",
  "rationale": {
    "bug-fix": "The PR fixes broken CLI behavior.",
    "area: cli": "The affected surface is CLI argument parsing."
  },
  "questions_for_author": [],
  "human_review_required": false
}
```

### PR Needs Rebase After Related Work Landed

Evidence:

- PR adds provider routing behavior.
- A newer merged PR changed the same routing module and base API.
- This PR now has conflicts or a stale base that blocks meaningful review.
- The PR was previously reviewable.

Dry run:

```json
{
  "item_number": 202,
  "item_kind": "pull_request",
  "issue_type_to_set": null,
  "labels_to_add": ["feature", "area: providers", "area: routing", "needs: rebase"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Status": "Blocked"
  },
  "recommended_action": "request_rebase",
  "confidence": "high",
  "rationale": {
    "feature": "The PR adds provider routing capability.",
    "area: providers": "The PR affects provider behavior.",
    "area: routing": "The PR changes routing logic.",
    "needs: rebase": "A newer merged PR changed the same module, and this PR needs conflict or stale-base cleanup before review can continue."
  },
  "questions_for_author": [
    "Can you rebase this PR against the current default branch and resolve the routing changes from the related merged PR?"
  ],
  "human_review_required": false
}
```

Comment:

> Thanks for the work here. A related routing change has landed since this PR was opened; please rebase against the current default branch and resolve the routing updates so maintainers can continue review.

### Competing PRs For The Same Issue

Evidence:

- PR #241 and PR #244 both claim to fix issue #99.
- The diffs overlap and cannot both land as-is.
- It is not clear whether one PR should supersede the other or whether the work should be combined.

Dry run:

```json
{
  "item_number": 241,
  "item_kind": "pull_request",
  "issue_type_to_set": null,
  "labels_to_add": ["bug-fix", "area: cli", "needs: cleanup-review"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Status": "Blocked"
  },
  "recommended_action": "ask_contributors_to_converge",
  "confidence": "high",
  "rationale": {
    "bug-fix": "The PR claims to fix a linked bug.",
    "area: cli": "The overlapping changes affect CLI behavior.",
    "needs: cleanup-review": "Another open PR appears to solve the same issue, so maintainers need a convergence decision before normal review continues."
  },
  "questions_for_author": [
    "Can you compare this PR with PR #244 and confirm whether one PR should be used, one should be withdrawn, or the work should be combined?"
  ],
  "human_review_required": true
}
```

Comment:

> Thanks for the fix. This appears to overlap with PR #244 for the same issue; please compare approaches and let maintainers know whether one PR should be used, one should be withdrawn, or the work should be combined.

### Security-Sensitive PR

Evidence:

- PR modifies SSRF validation.
- Public labels should route review without confirming exploitability.

Dry run:

```json
{
  "item_number": 203,
  "item_kind": "pull_request",
  "issue_type_to_set": null,
  "labels_to_add": ["bug-fix", "area: security", "area: sandbox", "security"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {
    "Status": "Needs Review"
  },
  "recommended_action": "security_sensitive_review",
  "confidence": "high",
  "rationale": {
    "bug-fix": "The PR fixes unsafe validation behavior.",
    "area: security": "The PR changes a security-sensitive path.",
    "area: sandbox": "The PR affects sandbox boundary behavior.",
    "security": "The PR touches SSRF validation."
  },
  "questions_for_author": [],
  "human_review_required": true
}
```

### Daily Release Activation

Evidence:

- Maintainer selects PR #123 for the day queue.
- Current daily label is `v0.0.8`.

Dry run:

```json
{
  "item_number": 123,
  "item_kind": "pull_request",
  "issue_type_to_set": null,
  "labels_to_add": ["v0.0.8"],
  "labels_to_remove": [],
  "labels_to_create": [],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {},
  "recommended_action": "activate_for_daily_release_work",
  "confidence": "high",
  "rationale": {
    "v0.0.8": "The maintainer selected this open PR for today's work queue. This is not a readiness claim."
  },
  "questions_for_author": [],
  "human_review_required": false
}
```

Anti-examples:

- Do not treat `v0.0.8` as a readiness claim.
- Do not change the version label just because the day ended.
- Do not delete an old version label while an open PR still depends on it.

## Agent-Owned Label Examples

Allowed:

- `agt: duplicate-candidate`
- `agt: stale-audit`
- `agt: needs-human-check`

Dry run:

```json
{
  "item_number": 301,
  "item_kind": "issue",
  "issue_type_to_set": null,
  "labels_to_add": ["agt: duplicate-candidate"],
  "labels_to_remove": [],
  "labels_to_create": [
    {
      "name": "agt: duplicate-candidate",
      "reason": "Agent coordination label for a duplicate-candidate audit."
    }
  ],
  "labels_to_delete": [],
  "issue_fields_to_set": {},
  "project_fields_to_set": {},
  "recommended_action": "agent_coordination",
  "confidence": "high",
  "rationale": {
    "agt: duplicate-candidate": "The label is inside the agent-owned namespace and does not encode product type, priority, status, sprint, release version, or issue classification."
  },
  "questions_for_author": [],
  "human_review_required": false
}
```

Not allowed:

- `agt: bug`
- `agt: priority-high`
- `agt: in-progress`
- `agt: sprint-6`
- `agt: v0.0.8`
