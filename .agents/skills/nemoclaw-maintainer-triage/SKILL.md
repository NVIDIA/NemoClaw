---
name: nemoclaw-maintainer-triage
description: Triage NemoClaw issues and PRs with Issue Type, Project fields, and allowed labels. Support one item or a batch. Show proposed changes and apply only changes the maintainer accepts. Trigger keywords - triage, label issues, suggest labels, batch triage, triage issue, triage PR, label this, what labels.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer — Triage

Use Issue Type for issue classification. Use Project fields for priority and lifecycle.
Use labels for routing and action queues.

## Step 1: Load Canonical Policy

Before evaluating an item, read these files in order:

1. [workflow-policy.md](../nemoclaw-maintainer-policies/references/workflow-policy.md)
2. [triage-instructions.md](../nemoclaw-maintainer-policies/references/triage-instructions.md)
3. [label-taxonomy.json](../nemoclaw-maintainer-policies/references/label-taxonomy.json)
4. [examples.md](../nemoclaw-maintainer-policies/references/examples.md)

Do not use another label guide.
The policy package is the source of truth for Issue Type, Project fields, labels, confidence, authorization, and output shape.

## Step 2: Determine Mode

**Single-item mode** — the user provides an issue or PR number:

```bash
gh issue view <number> --repo NVIDIA/NemoClaw --json number,title,body,labels,url,author,projectItems
gh pr view <number> --repo NVIDIA/NemoClaw --json number,title,body,labels,url,author,files,isDraft,mergeStateStatus,projectItems,statusCheckRollup
```

Use the command for the item type.
For issues, read Issue Type through the GitHub GraphQL API.
Read Project Priority and Status from Project 199. Do not infer them from labels.

**Batch mode** — collect both normal inbox items and unlabeled items:

```bash
gh issue list --repo NVIDIA/NemoClaw --state open --label "needs: triage" --limit 50 --json number,title,body,labels,url,author
gh issue list --repo NVIDIA/NemoClaw --state open --limit 50 --json number,title,body,labels,url,author
gh pr list --repo NVIDIA/NemoClaw --state open --label "needs: triage" --limit 50 --json number,title,body,labels,url,author,isDraft,mergeStateStatus
gh pr list --repo NVIDIA/NemoClaw --state open --limit 50 --json number,title,body,labels,url,author,isDraft,mergeStateStatus
```

Keep unlabeled items from the unfiltered results.
Combine them with the `needs: triage` results. Remove duplicates by item type and number.
Process one item at a time.

## Step 3: Present the Dry Run

Use the JSON-compatible payload defined by canonical `triage-instructions.md`. Include:

- native Issue Type for issues
- Project Priority and Status recommendations
- only labels from `label-taxonomy.json`
- labels to remove, including a completed `needs: triage` inbox marker
- confidence, rationale, questions, and `human_review_required`
- the proposed public comment, when one is useful.

Prefer no label over a guessed label.
Do not use labels for Issue Type, Priority, Status, or resolution.
Do not propose an unknown label. Do not propose `PRR` during triage.

In batch mode, present each dry run and wait for an explicit `apply`, `skip`, or edited write set before moving to the next item.

## Step 4: Apply Only the Accepted Write Set

Acceptance authorizes only the fields, labels, and comment in the proposal.
Before each write, re-read Issue Type, Project fields, and labels, then resolve all live IDs.
Do not store mutable IDs in this skill.
If the state differs from the accepted proposal's base state, stop and present an updated proposal for acceptance.
Resume writes only after the user accepts the updated proposal.

Apply writes in this order:

1. Set native Issue Type and accepted Project fields.
2. Add and remove canonical labels.
3. Remove `needs: triage` when the inbox action is complete.
4. Post the accepted comment, if any.

Do not write if the accepted plan contains a low-confidence inference, an unknown label, or an unauthorized field.
Return a corrected proposal.

## Step 5: Report

For every applied item, report:

- Issue Type before and after, when applicable
- Project Priority and Status before and after
- labels added and removed
- whether a comment was posted
- any proposed write that was skipped and why.

Do not write an external activity log unless the invoking maintainer explicitly asks for one.

## Batch Ordering

Prioritize candidates using policy evidence, not labels that duplicate Project Priority:

1. Security, outage, or data-loss reports that might need Project Priority `Urgent` or `High`.
2. Items that need a response from an author or maintainer.
3. Items waiting longest for triage.
4. Remaining items by recency.
