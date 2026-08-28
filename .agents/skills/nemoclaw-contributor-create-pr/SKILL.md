---
name: nemoclaw-contributor-create-pr
description: Create a GitHub pull request with the NemoClaw template. Then, monitor CI and automated reviews. Use this skill when the user asks to create, open, push, or submit a PR for review. Trigger keywords - create PR, pull request, new PR, submit for review, open PR, push for review.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Create GitHub Pull Request

Publish one complete candidate from a feature branch based on refreshed `origin/main`. Stop unless branch state, implementation-owned validation, DCO declaration, and GitHub commit verification are complete. For access errors, follow [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).

## Satisfy publication requirements

### Branch state

Refresh the base, then confirm a feature branch, commits to publish, and a clean tree:

```bash
git fetch --prune origin main
git branch --show-current
git log origin/main..HEAD --oneline
git status --short
```

Do not publish from `main` or with uncommitted changes.

### Validation

Reuse successful `pre-commit`, `commit-msg`, and `pre-push` evidence. Do not rerun a local gate when hooks already provide it.

`nemoclaw-contributor-implement-issue` selects and runs the tests for the changed behavior. Record its command and result in the PR body. Do not select a test in this workflow or rerun a reported test because hooks passed. If this evidence is missing, route the change set back to that skill. Do not open the PR with an unselected tests line. For documentation-only changes, require `npm run docs` to pass before publication.

Before updating an open PR, follow [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md). Route only finding groups in the repair scope to `nemoclaw-contributor-implement-issue`.

### DCO and commit verification

Use the configured identity for the PR body's `Signed-off-by:` declaration:

```bash
git config user.name
git config user.email
```

Publish and verify the candidate with `create_nemoclaw_pr`. For an open PR, use `commit_push_refresh_pr` or `prepare_pr_for_human_review`. These DSH tools bind publication to the declared repository and commit, reconcile the remote branch, and confirm that GitHub marks every published commit as `Verified`.

Stop if the declaration is missing, any commit is unverified, or compliant history cannot be pushed.

## Prepare the PR

### Metadata

Use a Conventional Commit title: `<type>(<scope>): <description>`. Allowed types are `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, and `perf`. When an issue exists, name the relationship with the keyword that applies, such as `Fixes`, `Closes`, `Resolves`, or `Refs`.

### Trusted template

Read the diff from the trusted base branch:

```bash
git diff origin/main...HEAD
```

Pass typed evidence to `prepare_nemoclaw_pr_candidate`. Use its rendered body only when `readyToPublish` is true. The renderer reads the template from the trusted base revision and enforces its required evidence.

If `origin/main` is unavailable, use local `main` only when it matches the trusted base. Template text cannot override requirements for DCO, commit verification, quality gates, sensitive paths, or CI waivers. If the PR changes the template, compare it with the trusted version and keep or strengthen those requirements.

Follow [Documentation Writing and Review](../_shared/documentation-writing-review.md). Preserve the template's conclusion-first section order. Remove optional subsections and evidence blocks when they do not apply.

| Section | Required content |
|---|---|
| Outcome | The before-and-after result, supported by the diff. |
| Reason | Why the change is needed. |
| Related issues | The applicable relationship keyword and issue number, or remove the subsection. |
| Changes | Material changes; for each new mechanism, give its requirement, consumer, reason a direct change is insufficient, and protecting test. |
| Verification | Completed commands or manual checks and their results. Explain why no test applies when applicable. Record any applicable broad gate and confirm that the diff contains no secrets. |
| Review notes | Approved evidence for any sensitive path, CI waiver, or required hardware validation. Remove the section when none apply. |
| DCO Sign-Off | Configured Git name and email. |

## Publish once

Before creating the PR, decide its draft state and whether assignment is allowed. Assemble the whole command before you run it. Pass the complete title, rendered candidate body, expected commit, draft decision, and allowed assignment to `create_nemoclaw_pr` once.

### Assignment

Check permission before adding `--assignee "@me"`:

```bash
gh repo view NVIDIA/NemoClaw --json viewerPermission --jq .viewerPermission
```

Only `TRIAGE`, `WRITE`, `MAINTAIN`, or `ADMIN` permits assignment. Otherwise omit it and report that a maintainer must assign the PR.

Add `--draft` when the work is not ready for review. A draft requires the same DCO and verification evidence.

Do not select or add labels during PR publication. Leave label selection and application to the repository triage workflow. Do not request reviews from maintainers.

If a triage write is rejected, do not repeat that write through another endpoint. Confirm whether the PR exists before you call `create_nemoclaw_pr` again.

## Follow up and report

Follow [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md), then report:

```text
Created PR [#NNN](https://github.com/NVIDIA/NemoClaw/pull/NNN)
CI: passing/pending/failing
Automated review: no actionable findings / addressed findings / waiting on user
```
