<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate and Publish

Adapted from main's PR creation skill at `8c72b552cc92fe7082908f3a13db7dc94f2f6685`; see the [entrypoint](../SKILL.md) for the adaptation scope.

## Prepare the candidate

Confirm the intended repository, source branch, base, and existing PR before writing. Use `v1` unless the task specifies another base; dependent PRs target their parent's branch. Fetch the selected base and inspect the full candidate diff, status, and untracked files. Preserve unrelated work and publish only the intended change from a feature branch.

Use [local validation](../../../../docs/contributing/testing.md#choose-local-validation) to select checks. Record actual commands and outcomes, including the behavioral RED/GREEN evidence when required. Run `cargo ci` when that policy or the user requires it; do not substitute `cargo test` for bundle/lifecycle checks. Repeat affected validation after repairs or base integration. No image publication or deployment is implied by opening a PR.

## Prepare the description

Read `.github/PULL_REQUEST_TEMPLATE.md` from the fetched base. If this change introduces or changes the template, review its diff and use the proposed report contract without silently dropping existing requirements.

Use a Conventional Commits title and explain the failure, decision, and validation. Reference real related issues with the relationship that applies; V1 PRs do not close issues automatically. Keep validation results separate from the [session report](session-report.md). Keep the report in a separate collapsed opening comment using `session-report-template.md`. Preserve its cutoff on later edits; do not imply it includes future work.

Compile and run the metadata validator against the exact saved report comment file:

```sh
rustc --edition=2024 tools/ci/pr-session-report.rs -o /tmp/nemoclaw-pr-session-report
/tmp/nemoclaw-pr-session-report /path/to/report-comment.md
```

The validator checks presence, fields, and statuses. Review the evidence and privacy limits yourself. An unavailable report is valid. Human authors and publication-only sessions must also post the report, with reasons for unavailable fields.

## Publish once and follow up

Use the configured GitHub access method and repository authorization rules. Before an initial push, confirm the task branch is not someone else's branch and no open PR already uses it. Before updating a PR branch, confirm the PR is still open and the remote has no unexpected changes. Commit the intended files with normal hooks, then push without force.

Before creating a PR, verify the remote branch contains the intended commit and check again for an existing PR. Create one PR with the explicit repository, base, head, title, and saved body (`gh pr create --body-file` when using `gh`). Open code-changing PRs as drafts and honor an explicit request to stay draft. After an ambiguous response, inspect remote state before retrying; reuse the matching PR instead of creating a duplicate. Verify its base, head, body, and draft state after creation.

After creation, post the prepared collapsed opening report with `gh pr comment --body-file`, within the user’s publication authority. Check existing comments first; after an ambiguous write, read back current comments before retrying. Verify exactly one opening report comment and its saved contents. When migrating an existing report, post and verify the comment before removing the body report. Preserve its evidence and cutoff. Until the default branch has the comment refresh workflow, edit the description or rerun metadata after posting or changing the report.

Watch required checks and automated reviews for the latest commit. Fix actionable findings within scope, validate, push, and watch again. Do not mark pending or failing checks complete, request reviewers, merge, or change repository rulesets as part of publication. Report external failures distinctly from candidate defects. Keep a user-requested draft in that state after checks pass.
