<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR CI and Automated Review Follow-Up

Use this workflow after creating a PR and after every push to an open PR.

## Watch checks

```bash
PR_NUMBER=${PR_NUMBER:-$(gh pr view --json number -q .number)}
gh pr checks "$PR_NUMBER" --watch
```

Then inspect the settled check state:

```bash
gh pr view "$PR_NUMBER" --json url,statusCheckRollup,comments,reviews,reviewDecision
```

## Inspect automated feedback

Check sticky PR comments and inline review comments from CodeRabbit and the PR Review Advisor:

```bash
gh api "repos/NVIDIA/NemoClaw/issues/${PR_NUMBER}/comments" --paginate \
  --jq '.[] | select((.body // "") | test("CodeRabbit|coderabbit|PR Review Advisor|nemoclaw-pr-review-advisor"; "i")) | {author: .user.login, updated_at, body}'

gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}/comments" --paginate \
  --jq '.[] | select((.body // "") | test("CodeRabbit|coderabbit|PR Review Advisor|nemoclaw-pr-review-advisor"; "i")) | {author: .user.login, path, line, updated_at, body}'
```

## Triage

- **CI failure:** inspect the failing job logs, fix the root cause, rerun relevant local checks, commit, push, and monitor again.
- **CodeRabbit or PR Review Advisor correctness/security/test-coverage finding:** address it when valid, rerun relevant checks, commit, push, and monitor again.
- **Style nits or false positives:** avoid unnecessary churn. Note the rationale in your final report or comment on the PR when reviewer-visible context is useful.
- **Ambiguous, risky, broad, or design-changing feedback:** stop and consult the user before changing code.

Repeat until required CI is green and there are no unresolved actionable CodeRabbit or PR Review Advisor findings, or until the user tells you to stop.

If any follow-up push or `gh`/GitHub query hits SSH, authentication, remote access, authorization, or permission problems, follow [Git and GitHub Access Hard Stop](git-github-hard-stop.md). Do not stop for ordinary merge conflicts or dirty-worktree state; resolve mechanical conflicts in the relevant workflow and ask the user only when resolution would change behavior or contributor intent.
