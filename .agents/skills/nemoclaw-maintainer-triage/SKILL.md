---
name: nemoclaw-maintainer-triage
description: AI-assisted label triage for NVIDIA/NemoClaw issues and PRs. Reads triage-instructions.md at runtime for consistent label guidance. Supports single-item mode (give it a number) and batch mode (fetches up to 50 unlabeled open items). On approval, applies labels and an optional triage comment via gh CLI, then logs the session to the daily-rhythm activity folder. Trigger keywords - triage, label issues, suggest labels, batch triage, triage issue, triage PR, label this, what labels.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer — Triage

AI-assisted label suggestion for issues and PRs. Reads live triage instructions, suggests labels and a triage comment, applies on approval, and logs the session.

---

## Step 1: Read Triage Instructions

Before suggesting any labels, read the live instructions:

```bash
cat docs/triage-instructions.md
```

Do not triage from memory. The instructions contain the label guide, tone rules, skip list, and output format. They may have been updated since your last session.

---

## Step 2: Determine Mode

**Single-item mode** — user provides a specific issue or PR number:

```bash
# For an issue:
gh issue view <number> --repo NVIDIA/NemoClaw --json number,title,body,labels,url,author

# For a PR:
gh pr view <number> --repo NVIDIA/NemoClaw --json number,title,body,labels,url,author
```

**Batch mode** — user says "batch", "all unlabeled", or provides no number:

```bash
# Fetch unlabeled open issues (no labels applied yet):
gh issue list --repo NVIDIA/NemoClaw --limit 50 --json number,title,body,labels,url,author \
  | jq '[.[] | select(.labels | length == 0)]'

# Fetch unlabeled open PRs:
gh pr list --repo NVIDIA/NemoClaw --limit 50 --json number,title,body,labels,url,author \
  | jq '[.[] | select(.labels | length == 0)]'
```

In batch mode, work through items one at a time — present each suggestion and wait for approval before moving to the next.

---

## Step 3: Suggest Labels and Comment

For each item, apply the rules from `triage-instructions.md` and present:

**Action:** `label` · **Suggested labels:** `bug`, `Platform: MacOS`
**Reason:** One sentence from the instructions.
**Triage comment (optional):**
> Comment text here.

Ask: "Apply these labels? (yes / skip / edit labels / no comment)"

Options:

- **yes** — apply as shown
- **skip** — move to next item without applying
- **edit labels** — user specifies different labels, then apply
- **no comment** — apply labels only, skip posting the comment

---

## Step 4: Apply on Approval

Apply labels:

```bash
# Issue:
gh issue edit <number> --repo NVIDIA/NemoClaw --add-label "bug,Platform: MacOS"

# PR:
gh pr edit <number> --repo NVIDIA/NemoClaw --add-label "enhancement: inference"
```

Post comment (if approved):

```bash
gh issue comment <number> --repo NVIDIA/NemoClaw --body "Comment text here."
# or for PRs:
gh pr comment <number> --repo NVIDIA/NemoClaw --body "Comment text here."
```

---

## Step 5: Log to Activity

After each approved item, append to `~/development/daily-rhythm/activity/nemoclaw-triage-log.md`.

Use the absolute path — this file lives in the daily-rhythm activity folder so it persists to GitLab over time.

```markdown
### [ISSUE|PR] NVIDIA/NemoClaw#<number> — <title>
**Date:** YYYY-MM-DD
**Labels applied:** bug, Platform: MacOS
**Comment posted:** yes | no

---
```

Create the file if it doesn't exist, with this header:

```markdown
# NemoClaw — Triage Log

A running record of label triage actions on NVIDIA/NemoClaw issues and PRs.
Persisted via daily-rhythm to GitLab.

---
```

At the end of a batch session, append a session summary before the individual entries:

```markdown
## YYYY-MM-DD — Triage Session
**Items triaged:** N
**Labels applied:** N labels across N items

---
```

Never stage or commit this file to the NemoClaw repo.

---

## Response Time Note

When triaging in batch mode, prioritize items in this order:

1. Items with outage, data loss, or critical breakage signals in title or body (candidate for `priority: high`)
2. Items opened by company-affiliated or known community contributors
3. Issues open > 5 business days with no label (first-response window at risk)
4. Everything else by recency
