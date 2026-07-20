<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Sweep Workflow

Review a security-sensitive item before normal PR processing.

## Step 1: Identify the Security Item

Start with the item selected by the maintainer-day loop.
For a separate review, check the triage queue for PRs that touch [risky areas](RISKY-AREAS.md).

## Step 2: Gather Context

Read the PR or issue, comments, automated-review findings, linked items, changed files, and diff.
Read the check results and related `main` commits.

## Step 3: Classify Risk

Classify the risk:

- **escape or policy bypass**
- **credential or secret exposure**
- **installer or release integrity**
- **workflow or governance bypass**
- **input validation or SSRF weakness**
- **test gap in risky code**

If no risk class applies, return to action selection.

## Step 4: Review security

Load `nemoclaw-maintainer-security-code-review` when the item changes behavior in a security-sensitive area.
Run all nine categories, including for a small diff.

## Step 5: Decide Action

### Salvage-now

Use salvage when all these conditions are true:

- The risk is understood.
- The fix is small and local.
- The required tests are known.
- No design question remains.

Follow [SALVAGE-PR.md](SALVAGE-PR.md) and [TEST-GAPS.md](TEST-GAPS.md).

### Blocked

Block approval when one of these conditions is true:

- The fix changes a trust assumption.
- The review finds a vulnerability that needs redesign.
- The PR adds risk without tests.
- Reviewers disagree about the security effect.

Report the blocker. Do not approve.

## Notes

- A security concern takes priority over backlog reduction.
- Do not approve a security-sensitive change until the security review and tests pass.
- Use GitHub links.
