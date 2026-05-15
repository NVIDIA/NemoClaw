## Phase 4.5 — Delegate to issue-kickoff for PR-A (`issue-first` mode only)

Skipped in `pr-a-first` mode.

### 4.5.1 — Invoke issue-kickoff

Invoke `/skill:nemoclaw-issue-kickoff <ISSUE>`. That skill will:
- create/reuse `$WORKTREE_BASE/issue-<N>/`
- create a feature branch `issue-<N>-<slug>`
- produce a phased development plan with test-depth classification

Capture from its output: the worktree path, the branch name, and the test-depth verdict.

### 4.5.2 — Enrich the kickoff output with the PR-B acceptance criterion

Before handing back to the user, append a "Definition of done" block to the kickoff's development plan, either as a comment on the issue or as a `ACCEPTANCE.md` file in the worktree root:

```markdown
## Definition of done (auto-added by pr-e2e-loop)

Regression job `<slug>-e2e` (added by coverage-guard PR #<PR_B> in `regression-e2e.yaml`) must flip from
red on unfixed code to green on the fix branch. Dispatch with:

    gh workflow run regression-e2e.yaml --repo NVIDIA/NemoClaw -f jobs=<slug>-e2e --ref <branch>

Expected failing assertion on main:
    <one-line fragment from Phase 3 log>
```

Update the checkpoint:
```json
{
  "issue_kickoff_worktree": "<path>",
  "issue_kickoff_branch": "<branch>",
  "phase": "AWAITING_PR_A"
}
```

### 🛑 CHECKPOINT 4.5 — Handoff

Halt with a message to the user:

> PR-B #<PR_B> is merged; regression-e2e `<slug>-e2e` is red on main. `/skill:nemoclaw-issue-kickoff <ISSUE>` produced worktree `<path>` on branch `<branch>` with a dev plan. Implement the fix, open it as a PR, then re-invoke `/skill:nemoclaw-pr-e2e-loop <PR_A>` — the loop will resume at Phase 5 and verify the test flips green.

**On resume with a PR-A number**, startup checkpoint logic must:
1. Check if the new PR-A's body references `#<ISSUE>` (via `gh pr view <PR_A> --json body,closingIssuesReferences`).
2. If yes and `$CHECKPOINT_DIR/issue-<ISSUE>.json` exists with `phase == "AWAITING_PR_A"`, migrate it: rename to `<PR_A>.json`, set `pr_a = <PR_A>`, set `mode = "issue-first"` (preserve), set `phase = "PHASE_5_VERIFY_GREEN"`, and **skip Phases 1–4** — jump directly to Phase 5.
3. If no prior checkpoint matches, start fresh in `pr-a-first` mode.

---

## Phase 5 — Pull main into PR-A and verify GREEN

### 5.1 — Merge main into PR-A's branch

Work inside PR-A's existing worktree (recorded during Phase 1):

```bash
cd "$PR_A_WORKTREE"
git fetch origin main
git merge origin/main -m "Merge main to pick up <slug>-e2e coverage guard"
# Resolve conflicts if any — most likely none unless PR-A touched regression-e2e.yaml or the same harness files
git push
```

If PR-A's author is not you and the branch is not in your fork, post a comment asking the author to rebase, and pause the skill:

> "Please rebase on main to pick up #<PR_B>. Once rebased, comment `/retest` or ping me and I'll run the targeted dispatch."

### 5.2 — Dispatch targeted test against PR-A's branch

```bash
gh workflow run regression-e2e.yaml --repo NVIDIA/NemoClaw -f jobs=<slug>-e2e --ref <pr_a_branch>
sleep 10
RUN_ID=$(gh run list --repo NVIDIA/NemoClaw --workflow=regression-e2e.yaml --branch <pr_a_branch> --limit 1 --json databaseId --jq '.[0].databaseId')
```

### 5.3 — Poll (30–45 min)

```bash
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --json conclusion,jobs
```

Expected conclusion: `success`.

### 5.4 — Interpret

- ✅ Green → proceed to Phase 6.
- ❌ Still red → PR-A's fix is incomplete OR the test is wrong. Escalate:
  - If PR-A's author is not you, post findings on PR-A and pause.
  - If PR-A's author is you, loop back to PR-A and iterate the fix. Stay in Phase 5.

### 🛑 CHECKPOINT 5 — Green on PR-A confirmed

Show:
- Run ID + URL
- Job passed + relevant success lines from the log
- Before/after summary: red against main, green against PR-A

Ask user: **"Post the closing comment on PR-A and write the report artifact?"**

On approval, proceed to Phase 6.

---

## Phase 6 — Close out

### 6.1 — Closing comment on PR-A

```markdown
## ✅ Coverage guard verified

`<slug>-e2e` (added in #<PR_B>) is:
- 🔴 Failing on `main` — [run <RED_RUN_ID>](URL)
- 🟢 Passing on this branch — [run <GREEN_RUN_ID>](URL)

This PR now has a regression test proving the fix. The regression guard will stay available for explicit dispatch and later nightly-promotion review.
```

```bash
gh pr comment <PR_A> --body "$(cat /tmp/pr-a-closing.md)"
```

### 6.2 — Report artifact

Write to `$REPORTS_DIR/pr-e2e-loop-<PR_A>-<PR_B>-<YYYYMMDD>.md`:

```markdown
# PR E2E Loop Report — PR-A #<PR_A> / PR-B #<PR_B>

**Date:** YYYY-MM-DD
**Author:** ${GH_USER}
**Duration:** <start>→<end> (<total hours>)

## Coverage gap
<one paragraph hypothesis>

## Test added
- File: `test/e2e/test-<slug>.sh`
- Job: `<slug>-e2e` in `regression-e2e.yaml`
- Asserts: <1-2 bullet points>

## Evidence
| Ref | Run | Conclusion |
|---|---|---|
| main | <RED_RUN_ID> | failure (expected) |
| PR-A branch | <GREEN_RUN_ID> | success |

## Regression guard window
<PR_B merge time> → <PR_A merge time or "still open"> (job lives in `regression-e2e.yaml`, not scheduled nightly)

## Follow-ups
- [ ] Merge PR-A
- [ ] Close this loop checkpoint
```

### 6.3 — Clean up checkpoint

Move `$CHECKPOINT_DIR/<PR_A>.json` to `$CHECKPOINT_DIR/archive/` with a timestamp suffix. Leave the worktrees in place — user cleans up via `/skill:nemoclaw-worktree-cleanup`.

---

