---
name: nemoclaw-contributor-update-docs
description: Scan recent git commits for changes that affect user-facing behavior, then draft or update the corresponding documentation pages and refresh generated user skills for release prep. Use when docs have fallen behind code changes, after a batch of features lands, during daily release prep, or when preparing a release. Trigger keywords - update docs, draft docs, docs from commits, sync docs, catch up docs, doc debt, docs behind, docs drift, release prep docs, refresh user skills.
---

# Update Docs from Commits

Scan recent git history for commits that affect user-facing behavior and draft documentation updates for each.

## Prerequisites

- You must be in the NemoClaw git repository (`NemoClaw`).
- The `docs/` directory must exist with the current doc set.

## When to Use

- After a batch of features or fixes has landed and docs may be stale.
- Before a release, to catch any doc gaps.
- During daily release prep, before opening the docs refresh PR.
- When a contributor asks "what docs need updating?"

## Step 0: Load the Skip List

Before scanning commits, read `docs/.docs-skip` if it exists. This file lists features and commits that are merged but should not be documented yet (experimental, under review, etc.).

```bash
cat docs/.docs-skip
```

Parse these sections from the file:

- `skip-features:` — substring patterns matched against commit messages and changed file paths. Any commit whose message or file list contains a listed string is excluded.
- `skip-terms:` — terms that must never appear in generated documentation. Check all drafted content against this list before writing. If a drafted sentence contains a skip-term, remove that sentence or the entire section. This is a hard gate — no skip-term may appear in any doc output.

Ignore comment lines (starting with `#`) and inline comments (everything after ` # `).

Keep the loaded skip list in memory for use throughout the skill execution and the whole documentation process.

## Step 1: Identify Relevant Commits

Determine the commit range. The user may provide one explicitly (e.g., "since v0.1.0" or "last 30 commits"). If not, default to commits since the head of the main branch.

```bash
# Commits since a tag
git log v0.1.0..HEAD --oneline --no-merges

# Or last 50 commits
git log -50 --oneline --no-merges
```

Filter to commits that are likely to affect docs. Apply every rule below before proceeding. A commit excluded by any rule must not produce doc changes.

1. **Commit type**: `feat`, `fix`, `refactor`, `perf` commits often change behavior. `docs` commits are already doc changes. `chore`, `ci`, `test` commits rarely need doc updates.
2. **Files changed**: Changes to `nemoclaw/src/`, `nemoclaw-blueprint/`, `bin/`, `scripts/`, or policy-related code are high-signal.
3. **Ignore**: Changes limited to `test/`, `.github/`, or internal-only modules.
4. **Skip list**: Exclude any commit whose short hash appears in `skip-commits`, or whose commit message or changed file paths contain a `skip-features` substring. Report skipped commits in the final summary under a "Skipped (docs-skip)" heading.
5. **Agent support matrix**: Do not document agent support (e.g., Claude Code, OpenHands, Goose) unless the agent is listed in the tested agent support matrix in the quickstart or platform docs. Commits that add or modify agent integration code should only produce doc updates for agents already in the matrix. Report excluded agents under "Skipped (not in agent matrix)" in the summary.

```bash
# Show files changed per commit to assess impact
git log v0.1.0..HEAD --oneline --no-merges --name-only
```

## Step 2: Map Commits to Doc Pages

For each relevant commit, determine which doc page(s) it affects. Use this mapping as a starting point:

| Code area | Likely doc page(s) |
|---|---|
| `nemoclaw/src/commands/` (launch, connect, status, logs) | `docs/reference/commands.md` |
| `nemoclaw/src/commands/` (new command) | May need a new page or entry in `docs/reference/commands.md` |
| `nemoclaw/src/blueprint/` | `docs/about/architecture.md` |
| `nemoclaw/src/cli.ts` or `nemoclaw/src/index.ts` | `docs/reference/commands.md`, `docs/get-started/quickstart.md` |
| `nemoclaw-blueprint/orchestrator/` | `docs/about/architecture.md` |
| `nemoclaw-blueprint/policies/` | `docs/reference/network-policies.md` |
| `nemoclaw-blueprint/blueprint.yaml` | `docs/about/architecture.md`, `docs/reference/inference-profiles.md` |
| `scripts/` (setup, start) | `docs/get-started/quickstart.md` |
| `Dockerfile` | `docs/about/architecture.md` |
| Inference-related changes | `docs/reference/inference-profiles.md` |

If a commit does not map to any existing page but introduces a user-visible concept, flag it as needing a new page.

## Step 3: Read the Commit Details

For each commit that needs a doc update, read the full diff to understand the change:

```bash
git show <commit-hash> --stat
git show <commit-hash>
```

Extract:

- What changed (new flag, renamed command, changed default, new feature).
- Why it changed (from the commit message body, linked issue, or PR description).
- Any breaking changes or migration steps.

## Step 4: Read the Current Doc Page

Before editing, read the full target doc page to understand its current content and structure.

Identify where the new content should go. Follow the page's existing structure.

## Step 5: Draft the Update

Before writing, verify that the commit was not excluded in Step 1. Do not draft content for commits matched by the skip list or for agent integrations not in the tested agent support matrix. After drafting, scan the content for any `skip-terms` from `docs/.docs-skip`. Remove any sentence or section that contains a skip-term. If in doubt, skip the commit and report it.

Write the doc update following these conventions:

- **Active voice, present tense, second person.**
- **No unnecessary bold.** Reserve bold for UI labels and parameter names.
- **No em dashes** unless used sparingly. Prefer commas or separate sentences.
- **Start sections with an introductory sentence** that orients the reader.
- **No superlatives.** Say what the feature does, not how great it is.
- **Code examples use `console` language** with `$` prompt prefix.
- **Include the SPDX header** if creating a new page.
- **Match existing frontmatter format** if creating a new page.
- **Always write NVIDIA in all caps.** Wrong: Nvidia, nvidia.
- **Always capitalize NemoClaw correctly.** Wrong: nemoclaw (in prose), Nemoclaw.
- **Always capitalize OpenShell correctly.** Wrong: openshell (in prose), Openshell, openShell.
- **Do not number section titles.** Wrong: "Section 1: Configure Inference" or "Step 3: Verify." Use plain descriptive titles.
- **No colons in titles.** Wrong: "Inference: Cloud and Local." Write "Cloud and Local Inference" instead.
- **Use colons only to introduce a list.** Do not use colons as general-purpose punctuation between clauses.

When updating an existing page:

- Add content in the logical place within the existing structure.
- Do not reorganize sections unless the change requires it.
- Update any cross-references or "Next Steps" links if relevant.

When creating a new page:

- Follow the frontmatter template from existing pages in `docs/`.
- Add the page to the appropriate `toctree` in `docs/index.md`.

## Step 6: Present the Results

After drafting all updates, present a summary to the user:

```markdown
## Doc Updates from Commits

### Updated pages
- `docs/reference/commands.md`: Added `eject` command documentation (from commit abc1234).
- `docs/reference/network-policies.md`: Updated policy schema for new egress rule (from commit def5678).

### New pages needed
- None (or list any new pages created).

### Skipped (docs-skip)
- `feat(sandbox): add experimental-flag` (abc1234) — matched skip-features: "experimental-flag".

### Commits with no doc impact
- `chore(deps): bump typescript` (abc1234) — internal dependency, no user-facing change.
- `test: add launch command test` (def5678) — test-only change.
```

## Step 7: Apply Release Prep Updates

Skip this step when the user only asked for ordinary doc catch-up and no release prep is involved.

If the user invoked this skill for release prep, finish the release-specific doc work before verification:

1. Make any requested doc version bumps in `versions1.json` and `project.json` in the `docs/` directory.
2. Determine the release label from the release version. Release labels use `vX.Y.Z` format. For example, if `docs/project.json` has `"version": "0.0.37"`, the release label is `v0.0.37`. Use the version requested by the user if one was provided; otherwise use the version in `docs/project.json` after the bump.
3. Refresh the NemoClaw user skills:

   ```bash
   python3 scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw-user
   ```

## Step 9: Build and Verify

After making changes, build the docs locally:

```bash
make docs
```

Check for:

- Build warnings or errors.
- Broken cross-references.
- Correct rendering of new content.
- Generated skill changes that do not correspond to source doc changes.

## Step 10: Open the Docs PR

Commit changes and open a pull request with a concise summary of the doc updates and a source summary that links each identified merged PR to its matching doc page. Include the PR number, affected doc page, links, and description of the doc change in this shape:

```markdown
- #<doc-impacting-PR-number> -> `docs/path.md`: Description of the doc change reflecting the source code changes in the PR.
```

Apply the `documentation` label and the corresponding release label so reviewers can identify doc-only changes for the target release.
When creating the PR with `gh pr create`, pass both labels, for example `--label documentation --label v0.0.37`.
If the release label does not exist, report that instead of substituting another label.

## Tips

- When in doubt about whether a commit needs a doc update, check if the commit message references a CLI flag, config option, or user-visible behavior.
- Group related commits that touch the same doc page into a single update rather than making multiple small edits.
- If a commit is a breaking change, add a note at the top of the relevant section using a `:::{warning}` admonition.
- PRs that are purely internal refactors with no behavior change do not need doc updates, even if they touch high-signal directories.
- To suppress documentation for a merged feature that is not ready for public docs, add it to `docs/.docs-skip`. Remove the entry once the feature is ready to document.

## Summary of Steps

User says: "Catch up the docs for everything merged since v0.1.0."

1. Run `git log v0.1.0..HEAD --oneline --no-merges --name-only`.
2. Filter to `feat`, `fix`, `refactor`, `perf` commits touching user-facing code.
3. Map each to a doc page.
4. Read the commit diffs and current doc pages.
5. Draft doc updates reflecting the source code changes in the commits following the style guide.
6. **Release prep only:** Apply release-prep version bumps if the user requested release prep.
7. **Release prep only:** Run `python3 scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw-user`.
8. Present the summary.
9. Build with `make docs` to verify.
10. **Release prep only:** Commit changes and open a pull request with the `documentation` label and the corresponding `vX.Y.Z` release label. Include a concise summary of the doc updates and a source summary that links each identified merged PR to its matching doc page. Include the PR number, affected doc page, links, and description of the doc change in this shape:

   ```markdown
   - #<doc-impacting-PR-number> -> `docs/path.md`: Description of the doc change reflecting the source code changes in the PR.
   ```

   If the release label does not exist, report that the PR was created without the release label or that PR creation failed because the label was missing.
