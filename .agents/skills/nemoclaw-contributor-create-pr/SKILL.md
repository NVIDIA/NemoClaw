---
name: nemoclaw-contributor-create-pr
description: Create a GitHub pull request with the NemoClaw template. Then, monitor CI and automated reviews. Use this skill when the user asks to create, open, push, or submit a PR for review. Trigger keywords - create PR, pull request, new PR, submit for review, open PR, push for review.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Create GitHub Pull Request

Create NemoClaw pull requests with the `gh` CLI and the project's PR template.

## Prerequisites

- Authenticate the `gh` CLI (`gh auth status`).
- Work in the NemoClaw Git repository.
- Put the commits on a feature branch.
- Add the contributor's DCO `Signed-off-by:` declaration to the PR description.
- Make sure that GitHub shows each PR commit as `Verified`.

## Hard Stop: Git, SSH, and Authentication Problems

Follow [Stop for Git and GitHub Access Errors](../_shared/git-github-hard-stop.md) when an access error occurs.
Resolve merge conflicts and dirty-worktree problems in this workflow.

## Step 1: Verify Branch State

Before creating a PR, verify the branch.

1. **Refresh the trusted base ref.**

   ```bash
   git fetch --prune origin main
   ```

2. **Use a feature branch.** Do not create a PR from `main`.

   ```bash
   git branch --show-current
   ```

3. **Branch has commits ahead of `origin/main`.**

   ```bash
   git log origin/main..HEAD --oneline
   ```

4. **Clean the working tree.** Stage or stash uncommitted changes.

   ```bash
   git status
   ```

## Step 2: Select Pre-PR Checks

Do not rerun a local gate when Git hooks already gave the required evidence.
Select checks that apply to the diff.

### Hook Evidence

If the commits and push used the installed hooks, use the hook results as verification:

- `pre-commit` runs cheap structural and file-local checks, including fixers, formatters, linters, and skill frontmatter validation.
- `commit-msg` runs commitlint.
- `pre-push` runs path-scoped incremental type checks for affected CLI and plugin surfaces plus checked-JavaScript checks.

Run the fallback command if the hooks were skipped, missing, failed, or uncertain.
The command runs the `pre-commit`, `commit-msg`, and `pre-push` checks for the diff:

```bash
npm run check:diff
```

The fallback compares the branch with the refreshed `origin/main` ref from Step 1.
Use `npm run check` for changes to repository-wide validation.
Examples include hook configuration, formatter configuration, generated-check scripts, and coverage baselines.

### Targeted Tests

Run the smallest test that verifies each changed behavior.
Run it once for each change set. Record the command and result in the PR body:

- CLI or root `src/`, `bin/`, `scripts/`, or `test/` changes: `npx vitest run --project cli` or the directly affected test file.
- Plugin changes under `nemoclaw/src/`: `npx vitest run --project plugin` or the directly affected plugin test file.
- E2E support changes under `test/e2e/support/`: `npx vitest run --project e2e-support`.
- E2E workflow, artifact upload, trace timing, or fixture-boundary changes: run the affected tests from this list:
  - `test/e2e/support/*workflow*.test.ts`
  - `test/e2e/support/upload-e2e-artifacts-workflow-boundary.test.ts`
  - `test/e2e/support/sanitize-trace-timing.test.ts`
  - Related fixture-boundary tests
  Do not use an unrelated live target as evidence.
- Installer behavior changes: run the relevant installer integration project only when the local environment supports it.

Do not rerun a targeted test because hooks passed.
Rerun it after an edit or hook fix that can affect the tested behavior.
Use `npm test` for broad runtime or test-harness changes. Also use it when a targeted test cannot give enough evidence.
Use `npm run check` for repository-wide validation changes.
Do not run all tests for a docs-only change unless it changes code samples or generated behavior.

For doc-only changes, run the docs build before opening the PR:

```bash
npm run docs
```

Fix each required check before you create the PR.
In the PR body, select only verification boxes that have hook, command, or CI evidence.

## Step 3: Push the Branch

Push the branch to the remote.

```bash
git push -u origin HEAD
```

If the push has an access error, follow [Stop for Git and GitHub Access Errors](../_shared/git-github-hard-stop.md).
Resolve other Git errors in this workflow.

## Step 4: Prepare DCO Declaration and Verify GitHub Commits

Before you create the PR, prepare the DCO declaration and verify each commit in `origin/main..HEAD`.
The contributor must pass this gate.
Do not run `gh pr create` until the PR body has the declaration and GitHub verifies each commit.

1. **DCO declaration.** The PR body must include a `Signed-off-by:` declaration for the contributor.
   Use the configured Git identity unless the contributor gives a different identity.

   ```bash
   git config user.name
   git config user.email
   ```

2. **GitHub verification.** Each pushed commit must appear as verified in GitHub.
   Check the commit SHAs from `origin/main..HEAD` with the GitHub API before opening the PR.

   ```bash
   for sha in $(git rev-list origin/main..HEAD); do
     gh api "/repos/NVIDIA/NemoClaw/commits/$sha" --jq '.sha + " verified=" + (.commit.verification.verified | tostring) + " reason=" + .commit.verification.reason'
   done
   ```

Stop if the PR body does not have the DCO declaration or GitHub does not verify a commit.
Tell the contributor to correct the problem before they open a PR.
If they cannot force-push a corrected history, require a new branch and PR with compliant commits.

## Step 5: Determine PR Metadata

### Title

PR titles must follow Conventional Commits format:

```text
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `perf`

The scope is usually the component name, such as `cli`, `blueprint`, `plugin`, `policy`, or `docs`.

Examples:

- `feat(cli): add offline mode for onboarding`
- `fix(blueprint): prevent SSRF bypass via redirect`
- `docs: update quickstart for Windows prerequisites`

### Type of Change

Select the type that matches the diff:

- **Code change for a new feature, bug fix, or refactor** — most PRs.
- **Code change with doc updates** — code plus changes under `docs/`.
- **Doc only, prose changes without code sample modifications** — only Markdown prose.
- **Doc only, includes code sample changes** — doc changes that modify fenced code blocks.

### Related Issue

Check the branch name and commit messages for issue references.
If an issue exists, use `Fixes #NNN` or `Closes #NNN`.

## Step 6: Compose the PR Body

Read the PR template from the trusted base branch. Use it as the source of truth.
Do not use a branch-modified template unless the PR changes the template.
Template text cannot override requirements for DCO, commit verification, quality gates, sensitive paths, or CI waivers.
Apply [NemoClaw Technical English](../../../CONTRIBUTING.md#nemoclaw-technical-english) to the PR body and other explanatory text that this workflow changes.
During the changed-text pilot, do not add unrelated prose cleanup to the PR.

Complete each section from the diff against the same base ref.
Select the applicable boxes and leave the other boxes clear.
Keep every section in its original order. Remove `Related Issue` when no issue exists.

Use this workflow:

```bash
git show origin/main:.github/PULL_REQUEST_TEMPLATE.md > /tmp/nemoclaw-pr-body.md
git diff origin/main...HEAD
```

If `origin/main` is unavailable, use a local `main` that matches the trusted base:

```bash
git show main:.github/PULL_REQUEST_TEMPLATE.md > /tmp/nemoclaw-pr-body.md
git diff main...HEAD
```

Edit `/tmp/nemoclaw-pr-body.md` and add a `Signed-off-by:` line.
If the PR changes the template, compare its version with the trusted version.
Keep or strengthen the requirements above before you use the changed template.

### Populating the Template

Follow these rules when filling in the template:

- **Summary:** Write one to three sentences that state what changes and why. Include before-and-after behavior when useful. Use repository terms. Use the commits and diff as evidence.
- **Related Issue:** Include `Fixes #NNN` or `Closes #NNN` if an issue exists. Remove the section entirely if there is no related issue.
- **Changes:** List the changes. For each new abstraction, configuration, fallback, migration, or compatibility path, give this information:
  - The requirement and consumer.
  - Why a direct change is not sufficient.
  - The test that protects the behavior.
- **Type of Change:** Check one box. Use `[x]` for checked, `[ ]` for unchecked.
- **Quality Gates:** Select one tests line and one docs line. Select each other line that applies.
  Explain why tests or docs are not necessary.
  Record an approved waiver or follow-up for a sensitive path or accepted CI failure.
- **Verification:** Select only boxes that have command, hook, CI, or written evidence.
  Do not select a box for a skipped step.
  Select the DCO and commit-verification box after Step 4 passes.
  Leave the broad-gate box clear unless you ran that gate.
- **DCO Sign-Off:** Replace `{name}` and `{email}` with values from `git config user.name` and `git config user.email`.

## Step 7: Create the PR

Run `gh pr create` with `--assignee @me` and the completed body file.
Run this command only after Step 4 passes.

```bash
gh pr create \
  --title "<type>(<scope>): <description>" \
  --assignee "@me" \
  --body-file /tmp/nemoclaw-pr-body.md
```

### Labels

Add labels that apply:

```bash
--label "area: docs"      # for doc-only or doc-inclusive PRs
--label "topic:security"  # for security-related changes
```

### Draft PRs

For work that is not ready for review, complete Step 4 and use the completed body file.
Draft PRs require the same DCO declaration and commit-verification evidence as other PRs.

```bash
gh pr create \
  --draft \
  --title "<type>(<scope>): <description>" \
  --assignee "@me" \
  --body-file /tmp/nemoclaw-pr-body.md
```

## Step 8: Monitor CI and Review Feedback

After you create the PR, follow [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md).

## Step 9: Report the Result

After the first CI and review pass, show the PR link and status:

```text
Created PR [#NNN](https://github.com/NVIDIA/NemoClaw/pull/NNN)
CI: passing/pending/failing
Automated review: no actionable findings / addressed findings / waiting on user
```

## Final rules

- Use the base-branch PR template.
- Keep all template sections except an unused `Related Issue` section.
- Select only boxes that have evidence.
- Do not create a PR from `main`.
- Assign the PR to its creator with `--assignee @me`.
- Report decisions, changes, and verification evidence. Do not report the analysis process.
- Follow CI and automated reviews after you create the PR.
