<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Salvage a Pull Request

Repair one narrow blocker when the PR shows the intended behavior. Defer the repair when intent or design is not clear. Stop when the repair exceeds accepted scope.

Before editing, complete [PR follow-up](../_shared/pr-follow-up.md) for one unchanged latest PR
commit. Repair the complete accepted root-cause group. Do not push a reaction to one early review
result while other automated evidence is pending.

## Decide

| Condition | Action |
|---|---|
| Mechanical conflict, missing test, failed check, or narrow correctness defect | Repair it now when the task permits local changes and a push. |
| Intent is not clear, or the repair needs a design decision | Ask the contributor or user. |
| The repair crosses accepted scope or multiple systems | Stop and report the required owner or decision. |

## Verify scope and write authority

Read the complete diff, review feedback, linked issues, and relevant changes on `main`. Confirm the PR objective before you edit.

```bash
gh pr view <number> --repo NVIDIA/NemoClaw \
  --json number,title,url,body,baseRefName,headRefName,author,files,commits,comments,reviews,statusCheckRollup,mergeStateStatus,reviewDecision,headRepositoryOwner,headRepository,maintainerCanModify
gh pr diff <number> --repo NVIDIA/NemoClaw
```

Follow [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md) for access errors. Resolve only mechanical conflicts here. Ask the user when resolution can change behavior or contributor intent.

Check out the PR or create an isolated worktree. Bind it to the recorded source repository, branch, and latest PR commit. Fetch the remote state, then reproduce the blocker before editing.

## Repair and validate

Apply the implementation and validation rules in `nemoclaw-contributor-implement-issue` to the accepted repair scope. Keep maintainer write authority and PR publication in this workflow.

Remove unrelated changes only when the PR objective does not require them. Do not reformat unrelated code.

## Push the permitted branch

Push only after validation passes. Never force-push.

- For a PR branch in `NVIDIA/NemoClaw`, push the local branch to its recorded `headRefName` on `origin`.
- For a fork PR, push to the fork only when `maintainerCanModify` is true.
- Do not push a fork PR to `origin`.

Immediately before the push, verify the worktree commit, source repository, and PR branch again. Stop if an identity changed.
Read the remote branch SHA again. Stop if it differs from the recorded latest PR commit. Do not
publish a competing revision. Push all accepted repairs once.

## Follow up

After the push, follow [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md). When its cycle completes, apply [Merge Gate](MERGE-GATE.md) for the approval decision.

Report the PR URL, repaired blocker, validation evidence, push result, and remaining gate.
