---
name: nemoclaw-maintainer-policies
description: Provide read-only NemoClaw maintainer policy. Use for questions about Issue Type, labels, Project fields, release labels, triage, duplicates, blocked items, and maintainer decisions. Trigger keywords - maintainer policy, workflow policy, project workflow, issue type, labels, label taxonomy, needs labels, project status, blocked issue, duplicate issue, daily release label, release train, triage policy.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer Policies

This package contains policy references. This file is its manifest and index.

## References

- **Workflow overview:** Read [workflow-policy.md](references/workflow-policy.md), [project-workflow.md](references/project-workflow.md), and [daily-flow.md](references/daily-flow.md) in that order.
  Read [release-train.md](references/release-train.md) for questions about release labels or history.
- **Agent implementation:** Read [workflow-policy.md](references/workflow-policy.md), [triage-instructions.md](references/triage-instructions.md), [label-taxonomy.json](references/label-taxonomy.json), and [examples.md](references/examples.md) in that order.
- [references/workflow-policy.md](references/workflow-policy.md) — Source of truth, authorization, Issue Type, label boundaries, and agent-owned labels.
- [references/triage-instructions.md](references/triage-instructions.md) — Issue and PR evaluation, questions, `needs:*`, confidence, and suggestion payloads.
- [references/label-taxonomy.md](references/label-taxonomy.md) — Label meaning, selection, compatibility, unknown labels, `agt: *`, and release labels.
- [references/label-taxonomy.json](references/label-taxonomy.json) — Allowed machine values and write policy.
- [references/project-workflow.md](references/project-workflow.md) — Project Status, lifecycle, duplicates, blocked work, review, and QA.
- [references/daily-flow.md](references/daily-flow.md) — Daily priorities, standup, assignment, execution, and QA handoff.
- [references/release-train.md](references/release-train.md) — Release inclusion, cutoff, carry-forward, history, and label retirement.
- [references/examples.md](references/examples.md) — Examples for triage, review, release activation, competing PRs, and stale PRs.

## Answering Workflow Questions

Read the related reference before you answer or apply policy.
Use plain language for maintainers. Distinguish Issue Type, PR type labels, `needs:*` labels, Project fields, close reasons, and release labels.
Do not invent labels, statuses, fields, release labels, or workflow states.
Follow the [NemoClaw Writing Guide](../../../WRITING.md) for changed workflow guidance and maintainer-facing text.

For agent implementation, use `triage-instructions.md` as the payload contract.
Use `label-taxonomy.json` to validate allowed values.

Workflow answers must remain reference-backed. Do not encode alternate policy in this manifest.
