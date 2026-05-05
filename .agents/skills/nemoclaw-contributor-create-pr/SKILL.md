---
name: nemoclaw-contributor-create-pr
description: Create GitHub pull requests that follow the NemoClaw PR template. Use when the user wants to create a new PR, submit code for review, open a pull request, or push changes for review. Trigger keywords - create PR, pull request, new PR, submit for review, open PR, push for review.
---

# Create GitHub Pull Request

Create pull requests on the NemoClaw GitHub repository using the `gh` CLI. This skill ensures every PR follows the project's PR template exactly.

## Prerequisites

- The `gh` CLI must be authenticated (`gh auth status`).
- You must be in the NemoClaw git repository.
- You must have commits on a branch that is pushed to the remote.

## Step 1: Verify Branch State

Before creating a PR, verify the branch.

1. **Not on main.** Never create PRs from main.

   ```bash
   git branch --show-current
   ```

2. **Branch has commits ahead of main.**

   ```bash
   git log main..HEAD --oneline
   ```

3. **Working tree is clean.** Stage or stash any uncommitted changes first.

   ```bash
   git status
   ```

## Step 2: Run Pre-PR Checks

Run both checks and confirm they pass before proceeding. Do not skip this step.

```bash
npx prek run --all-files
npm test
```

If either fails, fix the issues before creating the PR.

## Step 3: Push the Branch

Ensure the branch is pushed to the remote.

```bash
git push -u origin HEAD
```

## Step 4: Determine PR Metadata

### Title

PR titles must follow Conventional Commits format:

```text
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `perf`

Scope is typically the component name (e.g., `cli`, `blueprint`, `plugin`, `policy`, `docs`).

Examples:

- `feat(cli): add offline mode for onboarding`
- `fix(blueprint): prevent SSRF bypass via redirect`
- `docs: update quickstart for Windows prerequisites`

### Type of Change

Determine which type applies based on the diff:

- **Code change for a new feature, bug fix, or refactor** — most PRs.
- **Code change with doc updates** — code plus changes under `docs/`.
- **Doc only, prose changes without code sample modifications** — only Markdown prose.
- **Doc only, includes code sample changes** — doc changes that modify fenced code blocks.

### Related Issue

Check the branch name and commit messages for issue references. If an issue exists, use `Fixes #NNN` or `Closes #NNN`.

### DCO Sign-Off

The PR body must include a DCO sign-off line. Determine the user's name and email from git config:

```bash
git config user.name
git config user.email
```

## Step 5: Compose the PR Body

Use the exact template structure below. Fill in each section based on the diff (`git diff main...HEAD`). Check the applicable boxes and leave others unchecked. Do not add, remove, or reorganize sections.

```markdown
## Summary
<!-- 1-3 sentences: what this PR does and why. -->

## Related Issue
<!-- Fixes #NNN or Closes #NNN. Remove this section if none. -->

## Changes
<!-- Bullet list of key changes. -->

## Type of Change
- [ ] Code change (feature, bug fix, or refactor)
- [ ] Code change with doc updates
- [ ] Doc only (prose changes, no code sample modifications)
- [ ] Doc only (includes code sample changes)

## Verification
<!-- Check each item you ran and confirmed. Leave unchecked items you skipped. -->
- [ ] `npx prek run --all-files` passes
- [ ] `npm test` passes
- [ ] Tests added or updated for new or changed behavior
- [ ] No secrets, API keys, or credentials committed
- [ ] Docs updated for user-facing behavior changes
- [ ] `make docs` builds without warnings (doc changes only)
- [ ] Doc pages follow the [style guide](https://github.com/NVIDIA/NemoClaw/blob/main/docs/CONTRIBUTING.md) (doc changes only)
- [ ] New doc pages include SPDX header and frontmatter (new pages only)

---
<!-- DCO sign-off required by CI. Run: git config user.name && git config user.email -->
Signed-off-by: {name} <{email}>
```

### Populating the Template

Follow these rules when filling in the template:

- **Summary:** Write 1-3 sentences describing what the PR does and why. Derive this from the commit messages and diff, not from generic descriptions.
- **Related Issue:** Include `Fixes #NNN` or `Closes #NNN` if an issue exists. Remove the section entirely if there is no related issue.
- **Changes:** Bullet list of key changes. Be specific — reference file names, commands, or behaviors that changed.
- **Type of Change:** Check exactly one box. Use `[x]` for checked, `[ ]` for unchecked.
- **Verification:** Check only the boxes for steps you actually ran and confirmed passing. Do not check boxes for steps you skipped or did not verify.
- **DCO Sign-Off:** Replace `{name}` and `{email}` with values from `git config user.name` and `git config user.email`.

## Step 6: Create the PR

Use `gh pr create` with the `--assignee @me` flag and a HEREDOC for the body to preserve formatting.

```bash
gh pr create \
  --title "<type>(<scope>): <description>" \
  --assignee "@me" \
  --body "$(cat <<'EOF'
<full PR body from Step 5>
EOF
)"
```

### Labels

Add labels when applicable:

```bash
--label "documentation"   # for doc-only or doc-inclusive PRs
--label "topic:security"  # for security-related changes
```

### Draft PRs

For work-in-progress that is not ready for review:

```bash
gh pr create --draft --title "..." --assignee "@me" --body "..."
```

## Step 7: Report the Result

After the PR is created, display the PR URL as a clickable markdown link:

```text
Created PR [#NNN](https://github.com/NVIDIA/NemoClaw/pull/NNN)
```

## Common Mistakes to Avoid

- **Do not invent your own PR body format.** Use the template from Step 5 exactly.
- **Do not omit sections.** Even if a section is not applicable, keep it with the "Skip if..." comment.
- **Do not check boxes for steps you did not run.** If you did not run `make docs`, leave that box unchecked.
- **Do not forget the DCO sign-off.** CI will reject the PR without it.
- **Do not forget `--assignee @me`.** Every PR must be assigned to its creator.
- **Do not create PRs from main.** Always use a feature branch.
