---
name: nemoclaw-contributor-create-pr
description: "Publish or update a NemoClaw pull request and follow its CI and automated reviews to completion."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Create or Update a Pull Request

Publish the requested NemoClaw change and follow required CI and scheduled automated reviews until
one unchanged latest PR commit has a complete disposition. A successful push alone is not completion.
Preserve the user's scope and any explicit instruction to stop at a draft or withhold approval.

## Select the stage

- **Initial publication:** read [Validation](references/validation.md), then
  [Publication](references/publication.md). Use the implementation evidence already collected.
- **Update an open PR:** first complete the [PR follow-up contract](../_shared/pr-follow-up.md).
  Repair valid in-scope findings through `nemoclaw-contributor-implement-issue`, then apply the
  validation and publication references. These are stages of the same authorized task.
- **Inspect CI or review feedback:** use the shared follow-up contract. Load publication procedures
  only if an authorized branch or PR write is needed.
- **Mark a draft ready:** use the ready-state requirements in
  [Publication](references/publication.md#assignment) after the latest commit completes follow-up.

## Publication requirements

Use the canonical NVIDIA/NemoClaw base, template, sensitive-path policy, and trusted validation
surface described in the references. Publish from a clean feature branch. Every published commit
must be GitHub `Verified`; the PR body must contain the configured identity's DCO declaration.

Bind branch writes to the declared repository, branch, local commit, and expected remote state.
Preserve the atomic prior-state guard, fast-forward ancestry check, and readback requirements.
Reconcile inconclusive writes before any permitted bounded retry. Never infer success from a write
response alone or weaken the reference's concurrency and recovery rules.

Open code-changing or sensitive-path PRs as drafts. Record available review context without claiming
unobserved approval. Do not select labels or request maintainer reviews in this workflow.
Follow [GitHub access](../_shared/git-github-hard-stop.md) for access errors and
[Writing and review](../_shared/documentation-writing-review.md) for PR text.

## Completion

Carry the original objective, accepted scope, deferred scope, tested commit, and validation evidence
through repairs and publication. Continue authorized work without asking the user to restate the PR
request. Ask only for a decision outside that scope or a required authorization that is still missing.

Report the PR URL, current commit, CI and automated-review results, and any remaining human decision
or external blocker. Distinguish pending evidence from completed evaluation. This skill does not
grant merge authority.
