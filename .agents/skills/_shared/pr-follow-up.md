<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Follow Up on PR CI and Reviews

Use this workflow after you create a PR or push to an open PR.

## Preserve repository-owned review routing

Treat reviewer selection as repository configuration, not an agent decision.

Reviewer selection can come from these repository-owned sources:

- `CODEOWNERS` loaded from the PR base SHA in `NVIDIA/NemoClaw`.
- Rulesets configured for `NVIDIA/NemoClaw`.
- NemoClaw workflow definitions loaded from the PR base SHA in `NVIDIA/NemoClaw`.
- NemoClaw skills loaded from the PR base SHA in `NVIDIA/NemoClaw`.

Before you use a reviewer-request write, confirm that one of these conditions is true:

- The current user names the exact reviewer.
- You loaded a NemoClaw workflow definition from the PR base SHA in `NVIDIA/NemoClaw`, and it requires the exact reviewer-request write.

Otherwise, do not use any of these reviewer-request writes:

- `gh pr edit --add-reviewer` or `--remove-reviewer`.
- The requested-reviewers REST endpoint.
- A GraphQL review-request mutation.
- An equivalent reviewer-request write.

Under the same authorization rules, do not manually request or re-request a third-party reviewer.
This restriction includes Copilot and CodeRabbit.
The following review conditions do not authorize a reviewer-request write:

- The repository produced no review.
- The review covers an earlier PR SHA.
- A reviewer quota prevents the review.
- The review failed.

Observe only review signals that the repository produces.
Triage each signal according to this workflow.

If a repository-owned workflow dispatch performs no reviewer-request write, do not treat the dispatch as reviewer selection.
A documented PR Review Advisor refresh is one such dispatch.
Follow the exact NemoClaw skill instructions for the dispatch.

GitHub can create an automatic review-request event when a contributor or agent pushes.
GitHub can attribute the event to the pushing account.
If the command trace contains no reviewer-request write, report the event as an automatic review-request event.

## Monitor checks

```bash
PR_NUMBER=${PR_NUMBER:-$(gh pr view --json number -q .number)}
gh pr checks "$PR_NUMBER" --watch
```

When the checks stop, inspect their status:

```bash
gh pr view "$PR_NUMBER" --json url,statusCheckRollup,comments,reviews,reviewDecision
```

## Review feedback

Check PR comments and inline review comments from CodeRabbit and the PR Review Advisor:

```bash
gh api "repos/NVIDIA/NemoClaw/issues/${PR_NUMBER}/comments" --paginate \
  --jq '.[] | select((.body // "") | test("CodeRabbit|coderabbit|PR Review Advisor|nemoclaw-pr-review-advisor"; "i")) | {author: .user.login, updated_at, body}'

gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}/comments" --paginate \
  --jq '.[] | select((.body // "") | test("CodeRabbit|coderabbit|PR Review Advisor|nemoclaw-pr-review-advisor"; "i")) | {author: .user.login, path, line, updated_at, body}'
```

## Handle results

- Follow the [NemoClaw Writing Guide](../../../WRITING.md) for review comments and proposed rewrites.
- The guide defines which language findings can block and how to write a suggestion.
- Before you act on feedback, state the problem and the intended result.
- Do not add a helper, configuration switch, fallback, migration, or compatibility path only to satisfy reviewer wording.
- Treat feedback as a suggestion if you cannot connect it to one of these conditions:
  - A defect.
  - A demonstrated security or data-safety risk.
  - A supported contract.
  - Unnecessary complexity in changed code.
  - Ambiguity in changed text that can change behavior, security, data safety, test meaning, or release meaning.
- **CI failure:** Inspect the job logs and fix the cause. Run the related local checks. Commit, push, and monitor the PR again.
- **Valid CodeRabbit or PR Review Advisor finding:** Fix correctness, security, or test-coverage problems. Run the related checks. Commit, push, and monitor the PR again.
- **Style comment or false positive:** Avoid unnecessary changes. Explain your decision in the final report. Comment on the PR when reviewers need the explanation.
- **Ambiguous, risky, broad, or design-changing feedback:** Stop and ask the user before you change code.

Repeat this workflow until required CI passes and no actionable automated-review findings remain. Stop if the user tells you to stop.

If a push or GitHub query has an access error, follow [Git and GitHub Access Hard Stop](git-github-hard-stop.md).
Resolve merge conflicts and dirty-worktree problems in the PR workflow.
Ask the user when a resolution can change behavior or contributor intent.
