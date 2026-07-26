<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Salvage PR Workflow

Select a PR that needs a small fix. Make only the change needed to unblock it.

**Default to maintainer work.** Rebase, resolve conflicts, add missing tests, and push when the task permits these actions.
Do not wait for the contributor unless the diff does not show the intended behavior.

## Step 1: Gather Context

```bash
gh pr view <number> --repo NVIDIA/NemoClaw \
  --json number,title,url,body,baseRefName,headRefName,author,files,commits,comments,reviews,statusCheckRollup,mergeStateStatus,reviewDecision

gh pr diff <number> --repo NVIDIA/NemoClaw
```

Also read maintainer comments, CodeRabbit comments, linked issues, and recent `main` changes in affected files.
Understand the PR objective before you change code.

## Step 2: Assess Fit

**Maintainer does it now:** Rebase and resolve conflicts. Add missing tests for risky code.
Fix one or two failing checks or small correctness problems.

**Defer to the contributor when:** The fix requires a design decision that the diff does not answer.
Also defer when intent is unclear or the fix crosses multiple subsystems.

## Step 3: Check Out and Reproduce

```bash
gh pr checkout <number>
git fetch origin --prune
```

Reproduce the problem locally. Run the most focused applicable command first.

## Step 4: Review PR Scope Before Fixing

Review all changed files before you fix the blocker.
Identify configuration, refactor, or tool-setting changes that do not support the PR objective.
Restore those files from `main` when the PR does not need them.

## Step 5: Fix Narrowly

Make only the change needed to clear the blocker. Do not reformat unrelated code.

If the PR changes risky code, include missing tests in the fix.
See [RISKY-AREAS.md](RISKY-AREAS.md) and [TEST-GAPS.md](TEST-GAPS.md).

## Step 6: Conflicts

Resolve a conflict only when the resolution does not change behavior.
Stop and report a conflict that can change behavior.

## Step 7: Validate

```bash
npm test                          # root integration tests
cd nemoclaw && npm test           # plugin tests
npm run typecheck:cli             # CLI type check
npm run check                     # all repository checks
```

Use only commands matching the changed area.

## Step 8: Push

Push only if the fix is small, improves mergeability, passes validation, and you can push.
Never force-push.

If Git or GitHub access prevents the push, follow [Stop for Git and GitHub Access Errors](../_shared/git-github-hard-stop.md).
Resolve merge conflicts and dirty-worktree problems in this workflow.

Check the PR's head repository before you push:

```bash
gh pr view <number> --repo NVIDIA/NemoClaw --json headRepositoryOwner,headRepository,headRefName,maintainerCanModify
```

If `headRepository.nameWithOwner` is `NVIDIA/NemoClaw`, push to the PR branch on `origin`:

```bash
git push origin <local-branch>:<headRefName>
```

For a fork PR, push only when `maintainerCanModify` is true:

```bash
git push git@github.com:<owner>/<repo>.git <local-branch>:<headRefName>
```

For a fork PR, do not push to `origin`.
If `maintainerCanModify` is false, do not push.

## Step 9: Monitor After Push

After a maintainer push, follow [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md).
Fix valid correctness, security, and test-coverage findings within the PR scope.
Ask the user about ambiguous or design-changing feedback.

## Step 10: Route to Merge Gate

After CI and review finish, follow [MERGE-GATE.md](MERGE-GATE.md) if the PR is ready.

## Notes

- Reduce the backlog without accepting unresolved risk.
- Never hide unresolved reviewer concerns.
- Use full GitHub links.
