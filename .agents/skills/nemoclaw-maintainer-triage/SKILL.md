---
name: nemoclaw-maintainer-triage
description: AI-assisted triage for NVIDIA/NemoClaw issues and PRs using native Issue Type, Project fields, and the canonical label taxonomy. Supports single-item and batch modes, presents a dry run, and applies only the accepted write set. Trigger keywords - triage, label issues, suggest labels, batch triage, triage issue, triage PR, label this, what labels.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer — Triage

Triage issues and PRs through the canonical NemoClaw workflow. Native Issue Type owns issue classification, Project fields own priority and lifecycle, and labels own routing and immediate action queues.

## Step 1: Load Canonical Policy

Before evaluating an item, read these files in order:

1. [workflow-policy.md](../nemoclaw-maintainer-policies/references/workflow-policy.md)
2. [triage-instructions.md](../nemoclaw-maintainer-policies/references/triage-instructions.md)
3. [label-taxonomy.json](../nemoclaw-maintainer-policies/references/label-taxonomy.json)
4. [examples.md](../nemoclaw-maintainer-policies/references/examples.md)

Do not use a skill-local label guide. The policy package is the only source of truth for Issue Type, Project fields, labels, confidence, authorization, and output shape.

## Step 2: Determine Mode

**Single-item mode** — the user provides an issue or PR number:

```bash
gh issue view <number> --repo NVIDIA/NemoClaw --json number,title,body,labels,url,author,projectItems
gh pr view <number> --repo NVIDIA/NemoClaw --json number,title,body,labels,url,author,files,isDraft,mergeStateStatus,projectItems,statusCheckRollup
```

Use the command matching the item kind. For issues, also read the native Issue Type through the GitHub GraphQL API. For Project Priority and Status, use live Project 199 data rather than inferring state from labels.

**Batch mode** — collect both normal inbox items and unlabeled items:

```bash
gh issue list --repo NVIDIA/NemoClaw --state open --label "needs: triage" --limit 50 --json number,title,body,labels,url,author
gh issue list --repo NVIDIA/NemoClaw --state open --limit 50 --json number,title,body,labels,url,author
gh pr list --repo NVIDIA/NemoClaw --state open --label "needs: triage" --limit 50 --json number,title,body,labels,url,author,isDraft,mergeStateStatus
gh pr list --repo NVIDIA/NemoClaw --state open --limit 50 --json number,title,body,labels,url,author,isDraft,mergeStateStatus
```

From the unfiltered results, retain items with no labels, merge them with the `needs: triage` results, and deduplicate by item kind and number. Work through the resulting set one item at a time.

## Step 3: Present the Dry Run

Use the JSON-compatible payload defined by canonical `triage-instructions.md`. Include:

- native Issue Type for issues;
- Project Priority and Status recommendations;
- only canonical labels from `label-taxonomy.json`;
- labels to remove, including a completed `needs: triage` inbox marker;
- confidence, rationale, questions, and `human_review_required`;
- the exact proposed public comment, when one is useful.

Prefer no label over a guessed label. Never substitute labels for Issue Type, Priority, Status, or resolution. Never propose an unknown label, and never propose `PRR` during normal triage.

In batch mode, present each dry run and wait for an explicit `apply`, `skip`, or edited write set before moving to the next item.

## Step 4: Apply Only the Accepted Write Set

An accepted dry run authorizes only the exact fields, labels, and comment the maintainer accepted. Resolve live Issue Type IDs, Project field IDs, and Project option IDs immediately before writing; do not hardcode mutable IDs in this skill.

Apply writes in this order:

1. Set native Issue Type and accepted Project fields.
2. Add and remove canonical labels.
3. Remove `needs: triage` when the inbox action is complete.
4. Post the exact accepted comment, if any.

If the accepted plan contains a low-confidence inference, an unknown label, or a write outside the current authorization context, stop and return a corrected dry run instead of writing.

## Step 5: Report

For every applied item, report:

- Issue Type before and after, when applicable;
- Project Priority and Status before and after;
- labels added and removed;
- whether a comment was posted;
- any proposed write that was skipped and why.

Do not write an external activity log unless the invoking maintainer explicitly asks for one.

## Batch Ordering

Prioritize candidates using policy evidence, not labels that duplicate Project Priority:

1. Security-sensitive or outage/data-loss reports that may warrant Project Priority `Urgent` or `High`.
2. Action-blocked items requiring a precise author or maintainer response.
3. Items waiting longest for an initial actionable triage decision.
4. Remaining items by recency.
