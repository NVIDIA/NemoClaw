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
REPOSITORY=NVIDIA/NemoClaw
PR_NUMBER=${PR_NUMBER:-$(gh pr view --repo "$REPOSITORY" --json number -q .number)}
gh pr checks "$PR_NUMBER" --repo "$REPOSITORY" --watch
```

When the checks stop, inspect their status:

```bash
gh pr view "$PR_NUMBER" --repo "$REPOSITORY" \
  --json url,headRefOid,statusCheckRollup,comments,reviews,reviewDecision
```

## Review Feedback

Collect review evidence through host capabilities that expose pagination, source commits, thread resolution, and check results. Bind every read to `NVIDIA/NemoClaw` and one PR number.

Capture the PR `headRefOid` before collecting evidence. Read comments, reviews, and threads until the host reports that no next page remains. Record each page count and terminal pagination signal. Collect the status, conclusion, and evaluated commit of every required check, including pending, cancelled, and skipped results. Capture `headRefOid` again after collection. Restart collection if the two SHAs differ.

Record this identity and completeness evidence with the collection:

- Repository and PR number.
- Initial and final PR `headRefOid`.
- Local candidate `HEAD`.
- Page counts and terminal pagination status for comments, reviews, and threads.
- Every required check and the commit it evaluates.

Report the collection as `blocked` if the host cannot establish every condition in this list. Do not edit, commit, or push from a blocked collection.

Re-evaluate findings from an earlier review against the local candidate `HEAD`. Record whether each finding remains in that commit. Apply reviewer or bot filters only after collection is complete.

Record whether the host retains collection evidence. If the host returns an artifact path or identifier, record it, remove that exact artifact after classification, and verify its absence. If the host retains no artifact, record `retained evidence: none`. Report the collection as `blocked` when the host retains evidence but cannot remove it or verify its absence.

## Collect One Complete Review Cycle

Before editing, collect and classify all review signals for the latest PR commit as follows. The initial and final `headRefOid` values must match:

1. Re-read `headRefOid`. Collect current required-check failures, issue comments, submitted reviews, inline threads with resolution state, advisor findings, and required independent-review findings. Record each source commit when GitHub provides it. Otherwise, record the latest PR commit SHA.
2. Re-evaluate findings created for an earlier PR commit against the latest PR commit. Exclude a finding only when the changed code is gone or evidence shows that the defect is resolved. Record the disposition before editing.
3. Group findings by root cause. Name the behavior contract and acceptance evidence for each group.
4. Decide which groups are valid, false positives, design-changing, or blocked.
5. Apply the shared [Root-Cause and Sensitive-Workflow State Checks](root-cause-and-state-checks.md), starting from the change set that the valid groups imply. Record the sibling paths checked, the operation and failure class each group belongs to, and the sensitive-workflow state outcomes.

Do not create a separate commit or push for each finding. Apply all findings in the same root-cause group as one coherent change set. Classify every finding collected for the unchanged latest PR commit before beginning that change set. If the user tells you to stop, remove retained collection evidence by its exact artifact path or identifier and verify its absence. If the host retained no artifact, record `retained evidence: none`. Then stop without further edits, commits, or pushes. The user may explicitly defer a non-blocking suggestion or allow work to proceed without an optional pending review. Record that decision before editing. Do not proceed without a required review. Deferral does not authorize a push with an unresolved blocking, correctness, security, data safety, supported-contract, required-review, or required-check finding.

## Handle results

- Follow the shared [Documentation Writing and Review](documentation-writing-review.md) contract
  for review comments, proposed rewrites, and any resulting code or documentation change.
- The writing guide routed by that contract defines which language findings can block and how to
  write a suggestion.
- Before you act on feedback, state the problem and the intended result.
- Do not add a helper, configuration switch, fallback, migration, or compatibility path only to satisfy reviewer wording.
- Treat feedback as a suggestion if you cannot connect it to one of these conditions:
  - A defect.
  - A demonstrated security or data-safety risk.
  - A supported contract.
  - Unnecessary complexity in changed code.
  - Ambiguity in changed text that can change behavior, security, data safety, test meaning, or release meaning.
- **CI failure:** Add the failure to the current review cycle. Apply the shared [Root-Cause and Sensitive-Workflow State Checks](root-cause-and-state-checks.md), starting from the failing paths. Correlate the same root cause across the other required checks, including pending, cancelled, and skipped results. Apply the complete fix group, then run the related local checks.
- **Valid CodeRabbit or PR Review Advisor finding:** Add the finding to its root-cause group. Apply the shared [Root-Cause and Sensitive-Workflow State Checks](root-cause-and-state-checks.md) before editing, including the correctness, security, and test paths adjacent to the finding. Apply the group as one change set.
- **Style comment or false positive:** Avoid unnecessary changes. Explain your decision in the final report. Comment on the PR when reviewers need the explanation.
- **Ambiguous, risky, broad, or design-changing feedback:** Stop and ask the user before you change code.

Run this ordered remediation sequence:

1. Start from a complete collection for the unchanged latest PR commit. Classify every finding and
   determine which unresolved findings require a change.
2. Set the repair scope before routing, editing, validating, or committing a required change. Include
   every finding group that step 1 says requires a change.
3. Repair only the finding groups in the repair scope as one coherent change set.
4. Run targeted validation.
5. Commit the candidate change set after validation passes.
6. Run one final complete collection for the latest PR commit. Restart the collection if
   `headRefOid` changes.
7. Classify every finding in that collection.
8. If any unresolved finding requires a change, return to step 1 without pushing.
9. After no unresolved finding requires a change, remove retained collection evidence by its exact
   artifact path or identifier and verify its absence.
10. Push once.
11. Monitor the latest PR commit for new findings that require a change. When a new finding requires
    a change, return to step 1.

Stop if the user tells you to stop.

If a push or GitHub query has an access error, follow [Git and GitHub Access Hard Stop](git-github-hard-stop.md).
Resolve merge conflicts and dirty-worktree problems in the PR workflow.
Ask the user when a resolution can change behavior or contributor intent.
