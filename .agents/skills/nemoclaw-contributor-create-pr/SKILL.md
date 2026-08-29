---
name: nemoclaw-contributor-create-pr
description: Create a GitHub pull request with the NemoClaw template. Then, monitor CI and automated reviews. Use this skill when the user asks to create, open, push, or submit a PR for review. Trigger keywords - create PR, pull request, new PR, submit for review, open PR, push for review.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Create GitHub Pull Request

Publish one complete candidate from a feature branch based on the refreshed canonical comparison ref. Stop unless branch state, implementation-owned validation, DCO declaration, and GitHub commit verification are complete. For access errors, follow [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).

## Satisfy publication requirements

### Branch state

Read the canonical base SHA from GitHub. Fetch the canonical branch into the comparison ref. Confirm that both sources resolve to the same SHA. Then confirm a feature branch, commits to publish, and a clean tree:

```bash
nemoclaw_trusted_base_sha="$(gh api --method GET repos/NVIDIA/NemoClaw/git/ref/heads/main --jq '.object.sha')"
test -n "$nemoclaw_trusted_base_sha"
git fetch --no-tags https://github.com/NVIDIA/NemoClaw.git +refs/heads/main:refs/remotes/origin/main
nemoclaw_fetched_base_sha="$(git rev-parse --verify refs/remotes/origin/main)"
test "$nemoclaw_fetched_base_sha" = "$nemoclaw_trusted_base_sha"
git branch --show-current
git log origin/main..HEAD --oneline
git status --short
```

Every command must succeed. The `origin/main` name is a local comparison ref; it does not prove remote identity. Do not replace the canonical API endpoint or fetch URL with a checkout remote. Stop if the sources differ. Do not validate against a stale ref. Do not publish from `main` or with uncommitted changes.

### Validation

Normal `pre-commit`, `commit-msg`, and `pre-push` hooks provide early feedback, but a successful commit or push does not prove that they ran; hooks can be missing, stale, or redirected through `core.hooksPath`.

Select review evidence for the publication state before every agent-managed push:

- For an initial publication, use the implementation handoff's self-review and any other available pre-publication review evidence. Do not query PR state or follow the open-PR workflow because the PR does not exist.
- Before updating an open PR, follow [Collect](../_shared/pr-follow-up.md#collect) and [Decide](../_shared/pr-follow-up.md#decide). Set the repair scope, group valid code-changing findings by root cause, and route only in-scope groups to `nemoclaw-contributor-implement-issue`. Do not push while a finding is unclassified or an unresolved finding requires a change. Preserve excluded or deferred dispositions. Repeat collection as the final review step before the canonical base refresh. The initial and final `headRefOid` values must match.

After the applicable review step, repeat every canonical base read, fetch, and comparison command in Branch state immediately before each validation attempt.

Confirm that the complete validation execution surface is byte-for-byte identical with the canonical comparison ref:

- validation command and hook configuration;
- package manifests, lockfiles, and package-manager configuration;
- transitively loaded repository-local helpers and configuration;
- resolved validator executables.

Do not infer executable identity from a package name or version. Do not use a branch-defined validator as independent evidence. If any surface differs, is unavailable, or cannot be traced, do not execute the candidate validator or publish. Report the path or executable and canonical base SHA.

Run `npm run validate:pr` before every agent-managed push only after that comparison succeeds. Do not push when it fails or is inconclusive. If it changes a tracked file, commit the change, repeat the applicable review step, refresh and resolve the trusted base, reestablish the trusted validation surface, and rerun validation. Use `npm run check` for repository-wide validation changes, such as hooks, formatter configuration, generated-check scripts, or coverage baselines.

A maintainer may unblock unavailable trusted-base validation only with recorded evidence identifying the base and candidate SHAs, isolated environment, trusted validator entry point and resolved executables, exact command and result, and publication authorization. The environment must not give candidate code contributor-host credentials.

`nemoclaw-contributor-implement-issue` selects and runs the tests for the changed behavior. Record its command and result in the PR body. Do not select a test in this workflow or rerun a reported test because hooks passed. If this evidence is missing, route the change set back to that skill. Do not open the PR with an unselected tests line. For documentation-only changes, require `npm run docs` to pass before publication.

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

Read the diff from the canonical comparison ref:

```bash
git diff origin/main...HEAD
```

Pass typed evidence to `prepare_nemoclaw_pr_candidate`. Use its rendered body only when `readyToPublish` is true. The renderer reads the template from the trusted base revision and enforces its required evidence.

Do not use local `main` when the canonical comparison ref is unavailable. Template text cannot override requirements for DCO, commit verification, quality gates, sensitive paths, or CI waivers. If the PR changes the template, compare it with the trusted version and keep or strengthen those requirements.

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

Follow [Collect](../_shared/pr-follow-up.md#collect) and [Decide](../_shared/pr-follow-up.md#decide). Route accepted repair groups to `nemoclaw-contributor-implement-issue`. Then apply this skill's validation and publication gates. Repeat until required CI and automated reviews settle, then report:

```text
Created PR [#NNN](https://github.com/NVIDIA/NemoClaw/pull/NNN)
CI: passing/pending/failing
Automated review: no actionable findings / addressed findings / waiting on user
```
