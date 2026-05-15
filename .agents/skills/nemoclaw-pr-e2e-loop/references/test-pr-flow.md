# Phase 2 — Design PR-B (the failing test) — full-auto

<!-- markdownlint-disable MD001 MD012 MD022 MD031 MD032 MD040 MD058 -->

Author the test end to end. No checkpoint until Phase 2.4.

### 2.1 — Pick test shape

Decide which shape fits:

| Shape | When | Pattern |
|---|---|---|
| New `test/e2e/test-<slug>.sh` | The gap is a new assertion (new feature, new endpoint, new config path) | Model after the existing `test-<closest>.sh` in `TESTS_DIR` |
| Modify existing `test-<X>.sh` | The gap is an unchecked branch inside a test that already exists | Add a new `section` + `pass/fail` block alongside existing ones |
| New Brev-only test (`it.runIf(TEST_SUITE === "...")` block in `brev-e2e.test.ts`) | The gap is Brev-platform-specific (UFW, dashboard binding, launchable) | Follow `test/e2e/brev-e2e.test.ts` patterns |

For Brev-only tests, the job in `regression-e2e.yaml` becomes an `e2e-branch-validation` dispatch wrapper; note this in the checkpoint so Phase 3 and Phase 5 dispatch against the right workflow.

### 2.2 — Author the test file

Use the shell conventions from `test-full-e2e.sh`:
- `set -uo pipefail`
- `pass "..."` / `fail "..."` / `section "..."` helpers copied verbatim
- `parse_chat_content()` if inference is involved
- Real services preferred; hermetic mocks only for messaging/compat endpoint patterns that precedent establishes

Write the test. Make it **actually fail on current main** (confirm locally if possible, else document expected failure mode).

### 2.3 — Wire into `regression-e2e.yaml` (not scheduled nightly)

Do **not** add new failing-test-first guards directly to `nightly-e2e.yaml`. Add or update `.github/workflows/regression-e2e.yaml`, the regression holding-pen workflow. Jobs in this workflow are manually dispatchable and available for periodic review/promotion into nightly after they are stable.

Add a new job block following the existing conditional pattern:

```yaml
  <slug>-e2e:
    if: >-
      github.repository == 'NVIDIA/NemoClaw' &&
      (github.event_name != 'workflow_dispatch' ||
       inputs.jobs == '' ||
       contains(format(',{0},', inputs.jobs), ',<slug>-e2e,'))
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v6
      - name: Run <slug> E2E
        env:
          NVIDIA_API_KEY: ${{ secrets.NVIDIA_API_KEY }}
          NEMOCLAW_NON_INTERACTIVE: "1"
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1"
        run: bash test/e2e/test-<slug>.sh
```

Also add `<slug>-e2e` to the `inputs.jobs` description at the top of `regression-e2e.yaml`. If the guard reuses a Brev harness suite, add the suite to `.github/workflows/e2e-branch-validation.yaml` and `test/e2e/brev-e2e.test.ts` as needed. Do not add the job to `nightly-e2e.yaml` unless explicitly asked to promote it.

### 2.4 — Build the PR-B content summary

Prepare the summary for Checkpoint 3:

- New file path(s) + LOC
- Which existing test was the model
- Job name added to `regression-e2e.yaml`
- Expected failure mode on main (specific assertion that will fail, expected output fragment)
- Expected pass mode on PR-A (why the fix flips it)
- PR-B body draft explaining the failing-test-first pattern and that the job lives in the regression holding pen (not scheduled nightly) until reviewed/promoted

### 🛑 CHECKPOINT 3 — Approve test design

Present the summary from 2.4 plus the full test file diff and `regression-e2e.yaml` / harness diff.

Ask user: **"Ship this test as PR-B?"**

On approval, write checkpoint `phase = "PHASE_3_VERIFY_RED"`.

---

## Phase 3 — Create PR-B and verify RED on main

### 3.1 — Create worktree, branch, commit, push

Use `FIX_REF` = `#<PR_A>` (pr-a-first mode) or `#<ISSUE>` (issue-first mode).

```bash
BRANCH="test/<slug>-e2e-guard"
cd ${NEMOCLAW_REPO}
git fetch origin main
git worktree add "$WORKTREE_BASE/test-<slug>-e2e-guard" -b "$BRANCH" origin/main

cd "$WORKTREE_BASE/test-<slug>-e2e-guard"
# drop the new test file + the regression-e2e.yaml/harness edits
git add test/e2e/test-<slug>.sh .github/workflows/regression-e2e.yaml .github/workflows/e2e-branch-validation.yaml test/e2e/brev-e2e.test.ts
git commit -m "test(e2e): add <slug> coverage guard

Adds a failing E2E test that demonstrates the bug tracked by $FIX_REF.

Until the fix lands, the regression-e2e `<slug>-e2e` job will fail. This is
intentional — the failing test is the proof of coverage and the
executable acceptance criterion for $FIX_REF.

Related: $FIX_REF"
git push -u origin "$BRANCH"
```

### 3.2 — Open PR-B

```bash
gh pr create --title "test(e2e): add <slug> coverage guard for $FIX_REF" \
  --body "$(cat /tmp/pr-b-body.md)" \
  --base main --head "$BRANCH"
```

PR-B body MUST include:
- Link to `$FIX_REF` (PR-A in pr-a-first mode, the issue in issue-first mode)
- Explicit "this test will fail on main until the fix lands" warning
- The expected failure output fragment
- A note that the job is in `regression-e2e.yaml`, not scheduled nightly, and should be reviewed later for promotion to nightly
- **In `issue-first` mode only:** a sentence — "Once this merges, `/skill:nemoclaw-issue-kickoff $FIX_REF` will be invoked to produce the fix PR against this acceptance criterion."

Record `pr_b` number in the checkpoint.

### 3.3 — Dispatch the targeted regression test against PR-B/main-equivalent

Because the new regression job does not exist on `main` until PR-B merges, dispatch `regression-e2e.yaml` against the PR-B branch (whose code should otherwise be based on `origin/main`). This verifies the guard is red against main-equivalent unfixed code without touching scheduled nightly.

```bash
gh workflow run regression-e2e.yaml --repo NVIDIA/NemoClaw -f jobs=<slug>-e2e --ref <pr_b_branch>
# Capture the run ID
sleep 10
RUN_ID=$(gh run list --repo NVIDIA/NemoClaw --workflow=regression-e2e.yaml --branch <pr_b_branch> --limit 1 --json databaseId --jq '.[0].databaseId')
```

Record in checkpoint `dispatches[]`.

### 3.4 — Poll for completion (30–45 min)

```bash
gh run watch "$RUN_ID" --exit-status || true  # expected to fail
gh run view "$RUN_ID" --json conclusion,jobs --jq '{conclusion, failed_jobs: [.jobs[] | select(.conclusion=="failure") | .name]}'
```

Expected conclusion: `failure`. Expected failed job: `<slug>-e2e`.

### 3.5 — Interpret the result

- ✅ Job `<slug>-e2e` failed on the expected assertion → proceed.
- ❌ Job passed → the test isn't actually catching the bug. Return to Phase 2, redesign.
- ⚠️ Job errored before reaching assertion → infra/wiring issue. Fix and re-dispatch.

### 🛑 CHECKPOINT 4 — Red on main confirmed

Show:
- PR-B link
- Run ID + URL
- Failed job name + failing assertion line from the log
- PR-B check status (non-E2E checks should be green)

Ask user: **"Merge PR-B to main? This will add a red-on-unfixed-code regression guard to `regression-e2e.yaml` (not scheduled nightly) until #<PR_A> lands."**

On approval, proceed to Phase 4. Otherwise stop and update checkpoint.

---

## Phase 4 — Merge PR-B → main

### 4.1 — Verify non-E2E checks are green

```bash
gh pr checks <PR_B> --json name,conclusion --jq '[.[] | select(.name | test("e2e"; "i") | not) | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != null)]'
```

If non-empty, fix before merging.

### 4.2 — Merge

```bash
gh pr merge <PR_B> --squash --delete-branch
```

### 4.3 — Announce the red

**`pr-a-first` mode:** Post a comment on PR-A linking PR-B:

> "Coverage guard PR-B #<PR_B> has landed on main. Nightly `<slug>-e2e` is now red by design. When this PR rebases on main, the test will flip green — that's the acceptance criterion."

Write checkpoint `phase = "PHASE_5_VERIFY_GREEN"`.

**`issue-first` mode:** Post a comment on the **issue** linking PR-B:

> "Coverage guard #<PR_B> landed on main. Nightly `<slug>-e2e` is now red by design. Kicking off `/skill:nemoclaw-issue-kickoff <ISSUE>` next — the failing test is the acceptance criterion for any fix PR."

Write checkpoint `phase = "PHASE_4_5_KICKOFF_PR_A"` and proceed to **Phase 4.5**.

---
