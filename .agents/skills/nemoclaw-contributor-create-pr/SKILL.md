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

### Review-Driven Repair Closure

When this workflow pushes an update to an open PR, first follow [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md) through its complete review-cycle collection step, then classify every finding in that collection.

This workflow owns the push gate. Before routing a repair, enter the ordered remediation sequence
in the [Handle results](../_shared/pr-follow-up.md#handle-results) section and set the repair scope.

Group valid code-changing findings in the repair scope by root cause. Route only finding groups in
the repair scope to `nemoclaw-contributor-implement-issue`. Do not route a finding group that the
shared workflow excludes from the repair scope. Preserve its unresolved or deferred disposition.
That workflow owns the repair, its validation, and its evidence. Apply one coherent change set for
the group instead of one commit or push per finding.

After the routed repair returns and its validation passes, resume the shared sequence at the commit
step. If validation fails or is inconclusive, return to the repair and validation steps. Do not commit
or push until validation passes. Complete the final collection and evidence-removal steps before
pushing. Push after no unresolved finding requires a change.

Immediately before pushing, repeat the complete collection. Confirm that its initial and final `headRefOid` values match.

Apply these push conditions:

- Do not push while any finding is unclassified.
- Do not push while any unresolved finding requires a change.
- After classification, remove retained collection evidence by its exact artifact path or identifier.
- Verify that the artifact is absent.
- If the host retained no artifact, record `retained evidence: none`.
- If the user tells you to stop, stop without pushing.
- The user may defer only a non-blocking suggestion. Record that disposition before pushing.

### Hook Evidence

If the commits and push used the installed hooks, use the hook results as verification:

- `pre-commit` runs cheap structural and file-local checks, including fixers, formatters, linters, and skill frontmatter validation.
- `commit-msg` runs commitlint.
- `pre-push` runs path-scoped incremental type checks for affected CLI and plugin surfaces plus checked-JavaScript checks.

Run the fallback command if the hooks were skipped, missing, failed, or uncertain.
The command runs the `pre-commit`, `commit-msg`, and `pre-push` checks for the diff:

```bash
npm run validate:pr
```

The fallback compares the branch with the refreshed `origin/main` ref from Step 1.
Use `npm run check` for changes to repository-wide validation.
Examples include hook configuration, formatter configuration, generated-check scripts, and coverage baselines.

### Validation Evidence

`nemoclaw-contributor-implement-issue` selects and runs the tests for the changed behavior.
Record the command and result that it reported in the PR body.
Do not select a test in this workflow. Do not rerun a reported test because hooks passed.

If the change set arrives without that evidence, stop and route the change set to
`nemoclaw-contributor-implement-issue` for test selection and validation.
Do not open the PR with an unselected tests line.

For doc-only changes, run the docs build before opening the PR:

```bash
npm run docs
```

Fix each required check before you create the PR.
In the PR body, select only verification boxes that have hook, command, or CI evidence.

## Step 3: Push the Branch

Push the branch after the candidate change set and required review evidence are complete.

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
Follow the shared [Documentation Writing and Review](../_shared/documentation-writing-review.md)
contract for the PR body and other changed explanatory text.

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
- **Quality Gates:** Select the lines that apply. Explain why tests are not necessary when no test
  command applies. Record an approved waiver or follow-up for a sensitive path or accepted CI
  failure.
- **Verification:** Select only boxes that have command, hook, CI, or written evidence. For a direct
  documentation PR, record the applicable documentation validation here.
  Do not select a box for a skipped step.
  Select the DCO and commit-verification box after Step 4 passes.
  Leave the broad-gate box clear unless you ran that gate.
- **DCO Sign-Off:** Replace `{name}` and `{email}` with values from `git config user.name` and `git config user.email`.

## Step 7: Create the PR

Run this command only after Step 4 passes.
Assemble the whole command before you run it. Decide each optional flag in the sections below first.
Do not add a flag that the authenticated `gh` account cannot use.

Run exactly one `gh pr create` command. Every contributor can run this base command:

```bash
gh pr create \
  --title "<type>(<scope>): <description>" \
  --body-file /tmp/nemoclaw-pr-body.md
```

For work that is not ready for review, complete Step 4 and add `--draft` to whichever `gh pr create` command you run.
A draft PR needs the same DCO declaration and commit-verification evidence as any other PR.

### Assignment

Assignment is a triage write.
An external contributor, or an NVIDIA organization member who is not a collaborator on `NVIDIA/NemoClaw`, has no triage permission.

Run this command before deciding whether to add `--assignee`:

```bash
gh repo view NVIDIA/NemoClaw --json viewerPermission --jq .viewerPermission
```

Only when it reports `TRIAGE`, `WRITE`, `MAINTAIN`, or `ADMIN`, run this command instead of the base command:

```bash
gh pr create \
  --title "<type>(<scope>): <description>" \
  --body-file /tmp/nemoclaw-pr-body.md \
  --assignee "@me"
```

Otherwise create the PR without `--assignee`.
Report that the PR needs a maintainer to assign it.
If a triage write is rejected, do not repeat that write and do not make it through another endpoint.
Confirm whether the PR exists before you run `gh pr create` again.

### Labels

Do not select or add labels during PR publication.
Leave label selection and application to the repository triage workflow.

### Reviewers

Before you use a reviewer-request write, confirm that one of these conditions is true:

- The current user names the exact reviewer.
- You loaded a NemoClaw workflow definition from the PR base SHA in `NVIDIA/NemoClaw`, and it requires the exact reviewer-request write.

Otherwise, do not add `--reviewer` or make a separate reviewer-request write.
Reviewer routing belongs to repository-owned sources and the shared PR follow-up workflow.

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
- Assign the PR to its creator with `--assignee @me` when the creator has triage permission.
- Route only review finding groups in the repair scope to `nemoclaw-contributor-implement-issue`.
- Report decisions, changes, and verification evidence. Do not report the analysis process.
- Follow CI and automated reviews after you create the PR.
