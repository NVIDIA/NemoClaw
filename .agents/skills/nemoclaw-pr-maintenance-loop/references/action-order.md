# Step 5: Action Order for Selected PR

<!-- markdownlint-disable MD001 MD012 MD022 MD031 MD032 MD040 MD058 -->

Do exactly one coherent action per pass, then update state and exit.

### A. Integrate Base / Resolve Merge Conflicts

Handle GitHub `mergeable=CONFLICTING`, `mergeStateStatus=DIRTY`, or a branch behind `origin/main` before treating the PR as idle. Prefer rebase to preserve a linear branch, unless the PR already uses merge commits.

Preflight:

```bash
git fetch origin main "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
if [ -n "$(git status --porcelain)" ]; then
  if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    git rebase --abort || true
    git reset --hard "origin/$BRANCH"
  elif [ -f .git/MERGE_HEAD ]; then
    git merge --abort || true
    git reset --hard "origin/$BRANCH"
  else
    echo "blocked: unrelated dirty worktree"
    exit 0
  fi
fi
BEHIND=$(git rev-list --count HEAD..origin/main)
```

If `BEHIND > 0` or GitHub reports conflict/dirty, run:

```bash
if ! git rebase origin/main; then
  git status --short
  git diff --name-only --diff-filter=U
  # inspect and resolve conflicts, or abort if semantic/unsafe
fi
```

Conflict-resolution policy:

Safe to resolve automatically when the correct result is local, mechanical, and testable:

- Formatting-only or adjacent-line conflicts where both sides can be preserved.
- Test expectation/timeouts where main and PR changes are independent.
- File moves/renames where the PR change clearly belongs in the new main location.
- YAML list/matrix additions where preserving both entries is unambiguous and schema-valid.
- Deleted-vs-modified where the file was moved/split and the PR change has an obvious new home.

Stop and ask when the conflict is semantic or policy-affecting:

- Workflow behavior changes that decide which jobs run, schedule, permissions, secrets, runners, or required gates.
- Security boundaries, credential handling, sandbox isolation, or network exposure.
- Public CLI behavior or UX where two branches intentionally changed the same behavior.
- Large refactors where the PR intent must be reinterpreted against main.
- Any conflict where preserving both sides may duplicate jobs, weaken coverage, or alter release flow.

For rebase conflicts remember: during `git rebase`, `ours` is `origin/main` and `theirs` is the PR commit being replayed. Inspect all three stages before choosing:

```bash
git show :1:path/to/file   # merge base
git show :2:path/to/file   # ours: origin/main during rebase
git show :3:path/to/file   # theirs: PR commit during rebase
git show REBASE_HEAD:path/to/file || true
```

After resolving safe conflicts:

```bash
git add <resolved-files>
git rebase --continue
# repeat until complete
```

Validate at the narrowest useful level before pushing:

- For workflow YAML: run YAML parser/checker and any repo workflow lint/convention scripts.
- For TypeScript/test conflicts: run targeted tests or typecheck if dependencies are available.
- For shell conflicts: run `bash -n` and `shellcheck` when available.

Then push:

```bash
git push --force-with-lease origin HEAD:"$BRANCH" --no-verify
```

State outcomes:

- `rebased`: clean rebase with no conflicts.
- `fixed_merge_conflict`: conflict resolved, validated, and pushed.
- `blocked_semantic_conflict`: conflict inspected but unsafe to resolve automatically; abort rebase before exit.
- `blocked_dirty_worktree`: unrelated local dirty state prevented action.

If blocked, always clean up before exit unless the user explicitly asked to leave the worktree mid-conflict:

```bash
git rebase --abort || git merge --abort || true
git reset --hard "origin/$BRANCH"
```

### B. Fix Failing CI/CD

Preferred auto-fix categories:

| Failure | Action |
|---|---|
| biome/lint/format | Run the formatter/linter fix command used by the repo. |
| shellcheck | Apply targeted shell fix. |
| TypeScript compile error | Fix type mismatch if local and obvious. |
| Unit test failure | Fix only after understanding expected behavior. |
| DCO/signoff | Amend/sign off if safe. |
| Infra/flaky failure | Re-run once or report as likely infra. |

After fix:

```bash
git add <changed-files>
git commit -m "fix: address PR CI failure"
git push --no-verify
```

Then exit so the next loop pass can observe new CI.

### C. Address Human Review Feedback

For unresolved human comments:

1. Read the referenced code and full thread.
2. If the fix is local, obvious, and preserves intent, implement it.
3. If it changes architecture, product semantics, security posture, public UX, or contributor intent, stop and ask the user.
4. Commit with a clear message:

```bash
git commit -m "fix: address reviewer feedback"
git push --no-verify
```

Optionally reply to the thread summarizing the fix. Resolve the thread only when the fix clearly addresses it.

### D. Address CodeRabbit Feedback

Apply safe CodeRabbit suggestions automatically when they are:

- Formatting/style/readability only.
- Local null/undefined guard.
- Minor test robustness improvement.
- Small shell safety improvement.

Stop and ask for user confirmation if the suggestion changes architecture, behavior, security boundaries, or E2E assumptions.

Batch multiple safe CodeRabbit fixes in one commit for the same PR:

```bash
git add <changed-files>
git commit -m "fix: address CodeRabbit feedback"
git push --no-verify
```

### E. Trigger Missing E2E Advisor Recommendations

Only trigger E2E after normal PR CI is green or only pending on non-blocking checks.

Rules:

1. Use E2E Advisor and CodeRabbit recommendations first.
2. If recommendations are missing or ambiguous, inspect `.coderabbit.yaml` and current workflow definitions as a fallback.
3. Check current HEAD SHA for prior passing runs.
4. Record triggered jobs/run IDs in state cooldowns.
5. Do not trigger if the same job is already queued/in-progress for the same HEAD SHA.

Example:

```bash
BRANCH=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefName --jq '.headRefName')
JOBS="cloud-e2e,sandbox-operations-e2e"
gh workflow run nightly-e2e.yaml --repo "$REPO" --ref "$BRANCH" -f jobs="$JOBS"
```

After triggering, exit and let a later pass inspect results.

### F. Report Merge-Ready PRs

If a PR is approved, mergeable, current, and all checks/E2E are green, report it as merge-ready but do **not** merge without explicit user approval.
