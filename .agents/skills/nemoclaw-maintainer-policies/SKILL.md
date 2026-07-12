---
name: nemoclaw-maintainer-policies
description: Read-only maintainer policy reference for NemoClaw agents, engineers, and maintainers. Use when answering NemoClaw project-management workflow questions, including GitHub Issue Type, labels, Project fields, daily release labels, triage, duplicates, blocked items, and maintainer workflow decisions. Trigger keywords - maintainer policy, workflow policy, project workflow, issue type, labels, label taxonomy, needs labels, project status, blocked issue, duplicate issue, daily release label, release train, triage policy.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer Policies

This is a policy-only skill package. `SKILL.md` is only the manifest and index.

## References

- **Broad overview:** When a new engineer asks how NemoClaw uses GitHub or how the maintainer workflow works, load [references/workflow-policy.md](references/workflow-policy.md), then [references/project-workflow.md](references/project-workflow.md), then [references/daily-flow.md](references/daily-flow.md). Use [references/release-train.md](references/release-train.md) only when release labels, cutoff, carry-forward, release history, or label pruning are involved.
- **Agent implementation:** When building or updating an agent or app that applies or recommends workflow metadata, load [references/workflow-policy.md](references/workflow-policy.md), [references/triage-instructions.md](references/triage-instructions.md), [references/label-taxonomy.json](references/label-taxonomy.json), and [references/examples.md](references/examples.md), in that order.
- **Load [references/workflow-policy.md](references/workflow-policy.md)** when answering source-of-truth, authorization, Issue Type, label boundary, or agent-owned label questions.
- **Load [references/triage-instructions.md](references/triage-instructions.md)** when answering how to evaluate issues or PRs, when to ask for information, how to use `needs:*`, how to set confidence, or what suggestion payload shape to emit.
- **Load [references/label-taxonomy.md](references/label-taxonomy.md)** when answering human-facing label meaning, label selection, label compatibility, unknown-label, `agt: *`, or release-label taxonomy questions.
- **Load [references/label-taxonomy.json](references/label-taxonomy.json)** when validating machine-readable Issue Type, Project field, label, signal, compatibility, or write-policy values.
- **Load [references/project-workflow.md](references/project-workflow.md)** when answering Project Status, Project fields, duplicate, blocked, backlog, review, QA, issue-template, or lifecycle workflow questions.
- **Load [references/daily-flow.md](references/daily-flow.md)** when answering daily slate, priority lane, standup, assignment, execution, QA handoff, or daily operating-loop questions.
- **Load [references/release-train.md](references/release-train.md)** when answering daily version-label, release inclusion, carry-forward, cutoff, release history, or label-pruning questions.
- **Load [references/examples.md](references/examples.md)** when examples or anti-examples are needed for triage, PR review, daily release activation, competing PRs, stale/rebase cases, or agent-owned labels.

## Answering Workflow Questions

Before answering or applying policy, read the most relevant reference file. Answer in plain maintainer-facing language and distinguish native GitHub Issue Type, PR type labels, `needs:*` action labels, Project fields, GitHub close reasons, and daily version labels. Do not invent labels, statuses, fields, release labels, or workflow states.

For agent implementation questions, treat `triage-instructions.md` as the recommendation payload contract and `label-taxonomy.json` as the allowed-value and validation source.

Workflow answers must remain reference-backed. Do not encode alternate policy in this manifest.
