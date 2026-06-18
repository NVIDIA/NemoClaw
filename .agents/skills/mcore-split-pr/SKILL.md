---
name: mcore-split-pr
description: Split a PR into multiple PRs to reduce the number of required CODEOWNERS reviewer groups.
license: Apache-2.0
when_to_use: User asks to split a PR, reduce reviewer groups, or break up a large PR; 'too many CODEOWNERS', 'split this PR', 'break up PR', 'reduce reviewers needed'.
user_invocable: true
argument: "PR URL or number"
metadata:
  author: Philip Petrakian <ppetrakian@nvidia.com>
---

# Split PR by CODEOWNERS Groups

Split a large pull request into multiple smaller PRs, where each PR touches
the fewest possible CODEOWNERS reviewer groups. The goal is to reduce review
burden: a PR that only touches `megatron/core/` needs only the core reviewers,
while a PR that also touches `examples/`, `tools/`, and `megatron/training/`
pulls in many additional groups.

## Answer-First Constraints

For split-planning questions, lead with these constraints before the full
workflow:

- Minimize CODEOWNERS reviewer groups per PR, but each resulting PR must still
  be independently mergeable and reviewable.
- Tests travel with the production code they validate; do not split tests into a
  separate PR just to reduce reviewer groups.
- If PR B depends on symbols renamed in PR A, call out the dependency and put
  backward-compatible aliases, re-exports, or shims in PR A when needed.
- Wait for user approval before execution.
- Execution creates draft PRs from the right base, applies file-scoped diffs
  with `git diff upstream/main..<source-branch> -- <paths> | git apply`, pushes
  to the user's fork, and never pushes directly to upstream.

## Workflow

### 1. Analyze the PR

1. Fetch the PR details: `gh pr view <number> --repo NVIDIA/Megatron-LM --json title,body,headRefName,author` and `gh pr diff <number> --repo NVIDIA/Megatron-LM --stat`. Also determine the current GitHub user with `gh api user --jq .login`.
2. Parse `.github/CODEOWNERS` to build a mapping from file path patterns to owner groups.
3. For each changed file in the PR, determine which CODEOWNERS groups would be required to review it.
4. Build a summary table grouped by CODEOWNERS group, showing which files pull in which groups.
5. Count the total number of distinct reviewer groups the PR currently requires.

### 2. Propose a split that minimizes reviewer groups per PR

The primary optimization goal: **minimize the number of CODEOWNERS reviewer groups required for each resulting PR**.

Strategy:
1. Cluster files by their CODEOWNERS groups. Files owned by the same set of groups naturally belong together.
2. Identify the largest cluster — this becomes the first (and usually largest) PR.
3. Remaining files form one or more additional PRs, each ideally requiring only one or two reviewer groups.
4. If a split creates a dependency (e.g., PR B uses symbols renamed in PR A), the dependent PR must be merged after the first. Note this explicitly.
5. Each PR must be independently mergeable to main — no broken imports, no missing symbols. Backward-compatible aliases and re-export stubs in the first PR can make this possible.

Present the proposed split as a table:
- PR name/description
- Files included
- CODEOWNERS groups required
- Dependencies on other PRs (if any)

Wait for user approval before proceeding.

### 3. Execute the split (after user approval)

For each new PR:
1. Create a new branch from the appropriate base (`main`, or a dependency PR's branch).
2. Extract the relevant changes: `git diff upstream/main..<source-branch> -- <file paths> | git apply`.
3. Stage, commit with a clear message, and push to the user's fork.
4. Create the PR as a **draft** (per repo contributing guidelines).
5. If the original PR needs to be narrowed in scope, confirm with the user before force-pushing.
6. Report all PR URLs when done.

## Important guidelines

- Always create PRs as **drafts** and push to the user's fork, never directly to upstream.
- Backward-compatible changes (aliases, re-exports, deprecation shims) should go in the first PR so subsequent PRs can depend on them.
- Test files should go with the production code they test, not in a separate PR.
- Prefer a single clean commit per split PR over replaying the original commit history.
- If a file is hard to categorize (e.g., it touches two groups), ask the user which PR it should go in.
- If the current GitHub user is not the author of the original PR, each new PR's description must explicitly credit the original author (e.g., "Original changes by @<author> in #<number>").
