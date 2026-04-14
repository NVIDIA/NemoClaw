# Salvage PR Workflow

Take one near-mergeable PR and make the smallest safe change to unblock it.

**Default to maintainer salvage.** When a maintainer picks an item from the queue, the assumption is they're doing the work now — rebase, fix conflicts, add missing tests, push. Do not default to "ask the contributor and wait" because that blocks the daily cadence. Only defer to the contributor when the fix requires understanding intent that isn't clear from the diff.

## Step 1: Gather Context

```bash
gh pr view <number> --repo NVIDIA/NemoClaw \
  --json number,title,url,body,baseRefName,headRefName,author,files,commits,comments,reviews,statusCheckRollup,mergeStateStatus,reviewDecision

gh pr diff <number> --repo NVIDIA/NemoClaw
```

Also read: maintainer and CodeRabbit comments, linked issues, recent `main` changes in touched files. Understand the PR's purpose before coding.

## Step 2: Assess Fit

**Maintainer does it now:** rebase and resolve conflicts, add missing tests for risky code, fix one or two failing checks, apply small correctness fixes from review, narrow gate cleanup.

**Defer to contributor only when:** the fix requires a design change the maintainer can't judge from the diff, contributor intent is ambiguous and the wrong guess would change semantics, or the PR spans multiple subsystems the maintainer isn't familiar with.

## Step 3: Check Out and Reproduce

```bash
gh pr checkout <number>
git fetch origin --prune
```

Reproduce locally. Run narrowest relevant commands first.

## Step 4: Review PR Scope Before Fixing

Before fixing, review **all** changed files in the PR — not just the ones causing failures. Flag any files that expand the PR's scope unnecessarily (config changes, unrelated refactors, tool settings). Revert those to `main` if they aren't needed for the feature to work.

## Step 5: Fix Narrowly

Smallest change that clears the blocker. No opportunistic reformatting.

If risky code is touched (see [RISKY-AREAS.md](RISKY-AREAS.md)), treat missing tests as part of the fix — follow [TEST-GAPS.md](TEST-GAPS.md) when needed.

## Step 6: Conflicts

Resolve only mechanical conflicts (import ordering, adjacent additions, branch drift). Stop and summarize if the conflict changes behavior.

## Step 7: Validate

```bash
npm test                          # root integration tests
cd nemoclaw && npm test           # plugin tests
npm run typecheck:cli             # CLI type check
make check                        # all linters
```

Use only commands matching the changed area.

## Step 8: Push

Push when: fix is small, improves mergeability, validation passed, you have push permission. Never force-push. If you cannot push, prepare a comment describing the fix.

**Fork PRs:** Most PRs come from contributor forks. Check where to push:

```bash
gh pr view <number> --repo NVIDIA/NemoClaw --json headRepositoryOwner,headRepository,headRefName,maintainerCanModify
```

If `maintainerCanModify` is true, push directly to the fork:

```bash
git push git@github.com:<owner>/<repo>.git <local-branch>:<headRefName>
```

Do **not** push to `origin` — that creates a separate branch on NVIDIA/NemoClaw that won't appear in the PR.

## Step 9: Route to Merge Gate

If PR looks ready, follow [MERGE-GATE.md](MERGE-GATE.md).

## Notes

- Goal is safe backlog reduction, not finishing the PR at any cost.
- Never hide unresolved reviewer concerns.
- Use full GitHub links.
