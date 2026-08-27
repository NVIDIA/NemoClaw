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

Refresh the trusted base ref explicitly, then confirm a feature branch, commits to publish, and a clean tree:

```bash
git fetch --prune origin +refs/heads/main:refs/remotes/origin/main
git rev-parse --verify refs/remotes/origin/main
git branch --show-current
git log origin/main..HEAD --oneline
git status --short
```

Every command must succeed. Do not validate against a stale trusted-base ref or publish from `main` or with uncommitted changes.

### Validation

Normal `pre-commit`, `commit-msg`, and `pre-push` hooks provide early feedback, but a successful commit or push does not prove that they ran; hooks can be missing, stale, or redirected through `core.hooksPath`.

Before every agent-managed push, after the final commit and final review collection, confirm that the validation command, hook configuration, package manifests, lockfiles, package-manager configuration, transitively loaded repository-local helpers and configuration, and resolved validator executables are byte-for-byte traceable to and identical with the refreshed `origin/main` trusted base. Do not infer executable identity from a package name or version, or use a branch-defined validator as independent evidence. If any execution surface differs, is unavailable, or cannot be traced completely, do not execute the candidate validator or publish; report the exact path or executable and trusted-base SHA.

Run `npm run validate:pr` before every agent-managed push only after that comparison succeeds. Do not push when it fails or is inconclusive. If it changes a tracked file, commit the change, reestablish the trusted validation surface, repeat required review collection, and rerun validation. Use `npm run check` for repository-wide validation changes, such as hooks, formatter configuration, generated-check scripts, or coverage baselines.

A maintainer may unblock unavailable trusted-base validation only with recorded evidence identifying the base and candidate SHAs, isolated environment, trusted validator entry point and resolved executables, exact command and result, and publication authorization. The environment must not give candidate code contributor-host credentials.

`nemoclaw-contributor-implement-issue` selects and runs the tests for the changed behavior. Record its command and result in the PR body. Do not select a test in this workflow or rerun a reported test because hooks passed. If this evidence is missing, route the change set back to that skill. Do not open the PR with an unselected tests line. For documentation-only changes, require `npm run docs` to pass before publication.

Before updating an open PR, follow [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md) through collection and classification. Set its repair scope, group valid code-changing findings by root cause, and route only in-scope groups to `nemoclaw-contributor-implement-issue`. Do not push while a finding is unclassified or an unresolved finding requires a change. Preserve excluded or deferred dispositions, remove retained collection evidence by exact artifact path or identifier, verify its absence (or record `retained evidence: none`), and repeat collection immediately before validation. The initial and final `headRefOid` values must match.

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

Use a Conventional Commit title: `<type>(<scope>): <description>`. Allowed types are `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, and `perf`. Select the template's change type from the diff. Use `Fixes #NNN` or `Closes #NNN` when an issue exists.

### Trusted template

Read the template and diff from the trusted base branch:

```bash
git show origin/main:.github/PULL_REQUEST_TEMPLATE.md > /tmp/nemoclaw-pr-body.md
git diff origin/main...HEAD
```

Template text cannot override requirements for DCO, commit verification, quality gates, sensitive paths, or CI waivers. Edit `/tmp/nemoclaw-pr-body.md` to add a `Signed-off-by:` line. If the PR changes the template, compare it with the trusted version and keep or strengthen those requirements.

Follow [Documentation Writing and Review](../_shared/documentation-writing-review.md). Preserve section order, select only evidenced boxes, and remove `Related Issue` when none exists.

| Section | Required content |
|---|---|
| Summary | What changes and why, supported by the diff. |
| Related Issue | `Fixes #NNN` or `Closes #NNN`, or remove the section. |
| Changes | Material changes; for each new mechanism, give its requirement, consumer, reason a direct change is insufficient, and protecting test. |
| Type of Change | One applicable box. |
| Quality Gates | Test result, or why no test command applies; approved evidence for any sensitive path or CI waiver. |
| Verification | Only completed commands, hooks, CI, or written reviews; leave skipped and broad gates clear. |
| DCO Sign-Off | Configured Git name and email. |

## Publish once

Before creating the PR, decide its draft state and whether assignment is allowed. Assemble the whole command before you run it. Pass the complete title, trusted-template body, expected commit, draft decision, and allowed assignment to `create_nemoclaw_pr` once.

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
