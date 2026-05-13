---
name: nemoclaw-pr-e2e-loop
description: Coverage-guard loop for a NemoClaw PR that fixes a bug but lacks E2E coverage. Selects a candidate PR-A, authors a failing-test PR-B in regression-e2e.yaml that demonstrates the bug on main-equivalent code and passes on PR-A's branch, merges PR-B to main without adding it to scheduled nightly, merges main into PR-A, and verifies the test flips to green. Use when user says "pr e2e loop", "coverage guard", "add failing test first", "close e2e gap", "catch regression before merge", or provides a PR number with "add coverage for this".
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---


<!-- markdownlint-disable MD022 MD026 MD031 MD032 MD036 MD040 MD058 -->

# NemoClaw PR E2E Loop

A multi-phase workflow that closes an E2E coverage gap using a **failing-test-first** pattern:

- **PR-A** = an open NemoClaw PR that fixes a bug but has no E2E test guarding the fix.
- **PR-B** = a new PR authored by this skill. Contains a test that fails on main (bug present) and passes on PR-A's branch (bug fixed).

PR-B merges to main first into a dedicated **regression E2E holding pen** (`regression-e2e.yaml`) rather than the scheduled nightly. The regression job is then run explicitly against PR-A and verified green. This gives the team durable proof that (a) the regression is catchable, (b) PR-A actually fixes it, and (c) the guard is available for later review/promotion into nightly without keeping the nightly badge red for in-flight fixes.

## When to Use

- User says "pr e2e loop", "coverage guard", "add failing test first for PR #NNNN"
- Reviewing an NV QA / UAT bug-fix PR that landed or is landing without an E2E test
- After `/skill:nemoclaw-pr-triage` recommends "E2E required" and you want to turn that recommendation into an actual PR

## Constants

```
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
REPO="NVIDIA/NemoClaw"
NIGHTLY_WORKFLOW=".github/workflows/nightly-e2e.yaml"
REGRESSION_WORKFLOW=".github/workflows/regression-e2e.yaml"
TESTS_DIR="test/e2e"
REPORTS_DIR="${NEMOCLAW_WORKTREE_BASE}/.agent-reports"
CHECKPOINT_DIR="$HOME/.nemoclaw/pr-e2e-loop"
```

## Inputs

One of:
- **A specific PR number** → treat as PR-A, skip candidate search (jump to Phase 1 in `pr-a-first` mode)
- **An issue number** → resolve in Phase 0:
  - if an open fix PR is linked → use it as PR-A (`pr-a-first` mode)
  - if no fix PR yet → **write PR-B first from the issue body as spec**, land it red on main, then delegate to `/skill:nemoclaw-issue-kickoff` for PR-A authoring (`issue-first` mode)
  - if the fix already merged → standalone regression anchor, new remediation, or abort
- **Nothing** → run candidate search and present options in Phase 0

Input disambiguation: the same number space is shared by issues and PRs on GitHub. Always probe both `gh pr view <N>` and `gh issue view <N>` to classify. If both succeed the input is a PR; if only `gh issue view` succeeds it's an issue; if neither succeeds, report and stop.

## Modes

The loop runs in one of two modes, set during Phase 0 and recorded in the checkpoint as `mode`:

| Mode | Trigger | Order of operations |
|---|---|---|
| `pr-a-first` | PR number input, or issue with an existing open fix PR | Triage PR-A → design PR-B in regression workflow → verify red on PR-B/main-equivalent → merge PR-B → merge main into PR-A → verify green |
| `issue-first` | Issue number input, no existing fix PR | **Design PR-B from issue body** in regression workflow → verify red on PR-B/main-equivalent → merge PR-B → delegate to `/skill:nemoclaw-issue-kickoff` for PR-A → wait for PR-A → verify green |

Key variable used throughout later phases:
- `FIX_REF` = `#<PR_A>` in `pr-a-first` mode, `#<ISSUE>` in `issue-first` mode. Commit messages, PR bodies, and comments substitute this consistently.

## Persistence: Checkpoint & Resume

The loop spans hours (nightly dispatch is ~30–45 min per run, twice). MUST survive session death.

Checkpoint file: `$CHECKPOINT_DIR/<PR_A>.json`

```json
{
  "input": {"kind": "issue", "number": 3111},
  "issue_number": 3111,
  "issue_kickoff_worktree": "${NEMOCLAW_WORKTREE_BASE}/issue-3111",
  "issue_kickoff_branch": "issue-3111-openshell-gateway-glibc",
  "pr_a": 3255,
  "pr_a_branch": "fix-model-router-503",
  "pr_a_worktree": "${NEMOCLAW_WORKTREE_BASE}/pr-3255",
  "pr_b": null,
  "pr_b_branch": "test/model-router-e2e-guard",
  "pr_b_worktree": "${NEMOCLAW_WORKTREE_BASE}/test-model-router-e2e-guard",
  "test_slug": "model-router-e2e",
  "test_job_name": "model-router-e2e",
  "workflow_file": ".github/workflows/regression-e2e.yaml",
  "test_file": "test/e2e/test-model-router-e2e.sh",
  "phase": "PHASE_3_VERIFY_RED",
  "started": "2026-05-11T17:00:00Z",
  "pr_a_was_current": false,
  "pr_a_needs_rebase": false,
  "pr_a_updated_at_phase_1": "2026-05-11T17:05:00Z",
  "dispatches": [
    {"phase": 3, "ref": "main", "run_id": 1234567, "expected": "fail", "result": "fail", "at": "..."},
    {"phase": 5, "ref": "pr-a-branch", "run_id": 1234890, "expected": "pass", "result": null, "at": "..."}
  ],
  "log": []
}
```

### On startup, always check for an existing checkpoint

Checkpoints are keyed by PR-A number once it exists. If the user passes an issue number and no PR-A has been created yet, the checkpoint is keyed by `issue-<N>` instead (e.g. `$CHECKPOINT_DIR/issue-3111.json`). On resume, rename the checkpoint to `<PR_A>.json` as soon as PR-A is known.

If a checkpoint exists, resume from `phase` field. Do NOT restart earlier phases.

---

## Phase 0 — Input Resolution & Candidate Selection

This phase resolves the user's input into a concrete PR-A. The exact path depends on what was provided.

### 0.0 — Classify input

```bash
INPUT=<user-supplied number or empty>

if [[ -z "$INPUT" ]]; then
  KIND="none"
else
  IS_PR=$(gh pr view "$INPUT" -R NVIDIA/NemoClaw --json number --jq .number 2>/dev/null || true)
  IS_ISSUE=$(gh issue view "$INPUT" -R NVIDIA/NemoClaw --json number --jq .number 2>/dev/null || true)
  if [[ -n "$IS_PR" ]]; then
    KIND="pr"
  elif [[ -n "$IS_ISSUE" ]]; then
    KIND="issue"
  else
    echo "Number $INPUT is neither an open PR nor an issue on NVIDIA/NemoClaw"; exit 1
  fi
fi
```

Branch on `KIND`:
- `pr` → record `pr_a = INPUT` in checkpoint, write `phase = "PHASE_1_TRIAGE"`, skip directly to **Phase 1**.
- `issue` → proceed to **0.1 (Resolve issue to PR-A)**.
- `none` → proceed to **0.2 (Candidate search)**.

### 0.1 — Resolve issue to PR-A

Only runs when the input is an issue.

#### 0.1.1 — Search for linked fix PRs

```bash
ISSUE=<issue_number>

# Capture issue context for later
gh issue view "$ISSUE" -R NVIDIA/NemoClaw \
  --json number,title,labels,body,url,state,assignees \
  > /tmp/issue-$ISSUE.json

# Cross-references via timeline (most reliable — catches 'closes #NNNN', manual linking, and PR→issue mentions)
gh api "repos/NVIDIA/NemoClaw/issues/$ISSUE/timeline" --paginate \
  --jq '[.[] | select(.event=="cross-referenced") | .source.issue | select(.pull_request) | {number, title, state, url: .html_url, merged_at: .pull_request.merged_at}]' \
  > /tmp/issue-$ISSUE-xrefs.json

# Also search PR bodies/titles for the issue number (catches cases where the link wasn't auto-detected)
gh pr list -R NVIDIA/NemoClaw --state all --search "$ISSUE in:body" --limit 10 \
  --json number,title,state,url,updatedAt \
  > /tmp/issue-$ISSUE-body-matches.json

# Merge, dedupe, keep only OPEN PRs as strongest candidates; MERGED also notable; CLOSED dropped
python3 <<PY
import json
xrefs = json.load(open("/tmp/issue-$ISSUE-xrefs.json"))
body  = json.load(open("/tmp/issue-$ISSUE-body-matches.json"))
by_num = {}
for p in xrefs + body:
    n = p["number"]
    if n in by_num: continue
    state = p.get("state", "").upper()
    if state == "CLOSED" and not p.get("merged_at"): continue
    by_num[n] = {"number": n, "title": p["title"], "state": state, "url": p.get("url")}
json.dump(sorted(by_num.values(), key=lambda x: (x["state"] != "OPEN", -x["number"])),
          open("/tmp/issue-$ISSUE-fix-prs.json", "w"), indent=2)
PY
cat /tmp/issue-$ISSUE-fix-prs.json
```

#### 0.1.2 — Branch on what was found

**Case A — One or more OPEN PRs reference this issue:**

Present them to the user (number, title, author, state, last-updated). Most of the time there's a single obvious candidate.

### 🛑 CHECKPOINT 0 — Confirm PR-A

Ask user: **"Use PR #<NNNN> as PR-A?"** (or pick from list if multiple).

On confirmation:
- Write checkpoint `issue_number = <N>`, `pr_a = <chosen>`, `phase = "PHASE_1_TRIAGE"`.
- Rename checkpoint file from `issue-<N>.json` to `<PR_A>.json`.
- Skip to **Phase 1**.

**Case B — Only MERGED PRs reference this issue (or only CLOSED/no-op):**

The fix has already landed without an E2E guard. This is a textbook coverage-guard scenario, but PR-A no longer exists as an open PR — the loop's "merge main into PR-A, watch it flip green" mechanic doesn't apply.

Options to present:
1. **Standalone failing-test PR (no PR-A)** — author PR-B that demonstrates the bug was present before the merged fix and passes against current main. This converts to a simple regression anchor rather than a coverage-guard loop. Skip to a reduced Phase 2/3/4 (no Phase 5 — there's no PR-A branch to verify green against; instead verify green on `main` at `HEAD` post-fix, and red on `main@<sha-before-merged-fix>`).
2. **Kick off a new remediation issue** via `/skill:nemoclaw-issue-kickoff` if the merged fix turned out incomplete.
3. **Abort** — the issue is effectively resolved and doesn't need E2E coverage.

Ask the user which path. Do not auto-select.

**Case C — No PRs reference this issue: enter `issue-first` mode.**

Instead of waiting for a fix PR, the loop writes the failing test first. The issue body becomes the spec for PR-B. Later, after PR-B lands red on main, we delegate to `/skill:nemoclaw-issue-kickoff` for PR-A — at which point the failing test is an executable acceptance criterion for the fix.

Write checkpoint:
```json
{
  "input": {"kind": "issue", "number": <N>},
  "mode": "issue-first",
  "issue_number": <N>,
  "pr_a": null,
  "pr_b": null,
  "phase": "PHASE_2_DESIGN_TEST",
  "started": "<iso>",
  "log": ["issue-first mode: writing failing test before PR-A exists"]
}
```

Save as `$CHECKPOINT_DIR/issue-<N>.json`. Skip Phase 1 entirely (there's no PR-A to triage) and **jump to Phase 2**.

Before jumping, synthesize a lightweight "spec from issue" block from the issue body to replace the Phase 1 hypothesis:

> "Issue #<N> describes bug X in module Y (per the 'Actual Result' and 'Steps to Reproduce' sections). An E2E test that reproduces those repro steps and asserts the 'Expected Result' would fail on current main. Proposed test lives at `test/e2e/test-<slug>.sh`."

Also draft a comment to post on the **issue** (not a PR — there is none) at the end of Phase 3:

> "Writing an E2E guard for this bug first so the fix has a green-flip acceptance criterion. Will link PR-B once open."

---

### 0.2 — Candidate search (no input provided)

Only runs when the user provided no number.

#### 0.2.1 — Query candidate PRs

```bash
cd ${NEMOCLAW_REPO}
gh pr list --state open --limit 100 \
  --search 'label:"NV QA","UAT","bug"' \
  --json number,title,author,labels,files,createdAt,updatedAt \
  > /tmp/pr-e2e-candidates-raw.json
```

#### 0.2.2 — Filter to gap candidates

A PR is a candidate if **ALL** of:
- `state == OPEN`
- At least one label in `{bug, NV QA, UAT}`
- **Diff adds zero new files under `test/e2e/`** (this is the gap signal)
- Last updated within 30 days (drop stale)

```bash
python3 <<'PY'
import json, sys
with open('/tmp/pr-e2e-candidates-raw.json') as f:
    prs = json.load(f)
candidates = []
for pr in prs:
    labels = {l['name'] for l in pr['labels']}
    if not (labels & {'bug', 'NV QA', 'UAT'}):
        continue
    files = [f['path'] for f in pr['files']]
    adds_e2e = any(p.startswith('test/e2e/') for p in files)
    if adds_e2e:
        continue
    candidates.append({
        'number': pr['number'],
        'title': pr['title'],
        'author': pr['author']['login'],
        'labels': sorted(labels),
        'updated': pr['updatedAt'][:10],
        'touches': sorted({p.split('/')[0] + '/' + (p.split('/')[1] if len(p.split('/'))>1 else '') for p in files})[:6],
    })
with open('/tmp/pr-e2e-candidates.json','w') as f:
    json.dump(candidates, f, indent=2)
print(f"{len(candidates)} candidates")
PY
```

#### 0.2.3 — Score and present top 5

Score (higher = better candidate):
- +3 if label `priority: high` or `priority: critical`
- +2 if label `security`
- +2 if label `UAT` (user-facing validation signal)
- +1 per touched `src/lib/` module that has zero existing E2E coverage (check via `grep -r "<module>" test/e2e/ | wc -l == 0`)
- −1 if the PR is pure docs or config (`files` entirely under `docs/`, `.github/`, or `*.md`)
- −2 if `files` size > 40 files (too large to frame a single test around)

Present top 5 with title, labels, author, touched modules, score, and one-line rationale.

### 🛑 CHECKPOINT 1 — Candidate selection

Ask user: **"Which PR is PR-A?"**

Do not proceed until user picks one (or supplies a number not in the list — which re-enters Phase 0.0 to classify it).

Write checkpoint file with `phase = "PHASE_1_TRIAGE"` and `pr_a` set.

---

## Phase 1 — Triage PR-A (reuse existing skill)

> **Skip this entire phase in `issue-first` mode** — there is no PR-A yet. Jump to Phase 2. The "spec from issue" block synthesized at the end of Phase 0.1 Case C substitutes for the hypothesis normally produced here.

Runs only in `pr-a-first` mode.

### 1.0 — Ensure PR-A is current with main

Before any review or test-design work, PR-A must be up to date with `origin/main`. A stale branch can produce a triage recommendation that is obsolete the moment PR-A rebases.

```bash
cd ${NEMOCLAW_REPO}
gh pr view <PR_A> --json headRefName,headRepositoryOwner,mergeable,mergeStateStatus,baseRefName \
  --jq '{branch:.headRefName, owner:.headRepositoryOwner.login, mergeable, mergeStateStatus, base:.baseRefName}'
```

Compute "behind main":

```bash
git fetch origin main <pr_a_branch>
BEHIND=$(git rev-list --count origin/<pr_a_branch>..origin/main)
echo "PR-A is $BEHIND commits behind main"
```

Branch on ownership:

**Case A — PR-A is authored from this fork (you can push):**

```bash
# If we don't already have a worktree for PR-A, create one
git worktree add "$WORKTREE_BASE/pr-<PR_A>" "<pr_a_branch>" 2>/dev/null || true
cd "$WORKTREE_BASE/pr-<PR_A>"
git fetch origin main
git merge origin/main -m "Merge main into PR-A before coverage-guard triage"
# Resolve conflicts if any; abort and escalate to user if non-trivial
git push
```

**Case B — PR-A is from a fork you cannot push to:**

- Do NOT push. Instead create a **local preview branch** so triage operates on a current view:
  ```bash
  git fetch origin main
  gh pr checkout <PR_A> --force  # creates local tracking branch
  git checkout -b pr-<PR_A>-main-preview
  git merge origin/main -m "Local preview: main merged for triage only"
  ```
- Post a comment on PR-A asking the author to rebase on main:
  > "Before we add an E2E coverage guard for this PR, please rebase on main so triage runs against the current tree. Happy to rebase for you if you enable 'Allow edits from maintainers'."
- Record `pr_a_needs_rebase: true` in the checkpoint. Phase 5 will re-check and block on actual rebase.

**Case C — PR-A is already up to date (`BEHIND == 0`):**

- Skip the merge. Note in checkpoint `pr_a_was_current: true`.

If merge conflicts arise in Case A and they're non-trivial (more than mechanical resolution), **stop and ask the user** — don't guess at conflict resolution. Record conflict files in the checkpoint.

### 1.1 — Invoke `nemoclaw-pr-triage`

Run the `/skill:nemoclaw-pr-triage` skill on PR-A. Capture its output.

The triage skill creates a worktree for PR-A under `$WORKTREE_BASE/pr-<N>/` and produces a test-depth recommendation. Record the worktree path in the checkpoint.

### 1.2 — Synthesize the coverage-gap hypothesis

Using the triage output plus the PR's files / description, form a concrete hypothesis:

> "PR-A fixes bug X in module Y. An E2E test that exercises code path Z would have failed before PR-A and passes after. Proposed test lives at `test/e2e/test-<slug>.sh` (or modifies `test/e2e/test-<existing>.sh`)."

### 1.3 — Draft a review comment for PR-A

A short comment (3–6 sentences) summarizing:
- The coverage gap
- What the failing-test PR-B will exercise
- The timeline (PR-B merges first; PR-A rebases; both land green)
- A link placeholder for PR-B once it exists

### 🛑 CHECKPOINT 2 — Approve hypothesis + comment

Show:
- The triage skill's recommendation
- The coverage-gap hypothesis
- The draft review comment

Ask user: **"Proceed with this framing? Post the comment on PR-A now, or wait until PR-B exists?"**

If user approves the comment for immediate posting:
```bash
gh pr comment <PR_A> --body "$(cat /tmp/pr-a-comment.md)"
```

Otherwise hold the comment text in the checkpoint for posting at end of Phase 5.

Write checkpoint `phase = "PHASE_2_DESIGN_TEST"`.

---

## Phase 2 — Design PR-B (the failing test) — full-auto

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

> PR-B #<PR_B> is merged; nightly `<slug>-e2e` is red on main. `/skill:nemoclaw-issue-kickoff <ISSUE>` produced worktree `<path>` on branch `<branch>` with a dev plan. Implement the fix, open it as a PR, then re-invoke `/skill:nemoclaw-pr-e2e-loop <PR_A>` — the loop will resume at Phase 5 and verify the test flips green.

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

## Failure modes and recovery

| Symptom | Recovery |
|---|---|
| Input is neither PR nor issue | Report to user and stop. Likely typo or wrong repo. |
| Input is an issue with no fix PR | Enter `issue-first` mode: skip Phase 1, write PR-B from issue body as spec (Phase 0.1 Case C → Phase 2). Delegate to `/skill:nemoclaw-issue-kickoff` after PR-B merges (Phase 4.5). |
| Resume with PR-A number after `issue-first` handoff | Startup logic detects prior `issue-<N>.json` via PR-A’s issue references, migrates checkpoint, jumps to Phase 5. |
| Input is an issue whose fix already merged | Present options: standalone regression-anchor PR-B (no Phase 5), new remediation issue, or abort (Phase 0.1 Case B). |
| Input is an issue with multiple open fix PRs | Present all open PRs; user picks which is PR-A (Phase 0.1 Case A). |
| Phase 1.0 merge conflicts on PR-A | Stop and ask user. Do not auto-resolve non-trivial conflicts. |
| Phase 1.0 PR-A from fork you can't push to | Use local preview branch + comment asking author to rebase. Proceed with triage on preview. |
| Phase 3 test passes instead of failing | Redesign test (back to Phase 2). The assertion isn't tight enough or targets wrong code path. |
| Phase 4 non-E2E checks red | Fix lint/typecheck/unit issues on PR-B branch. Don't merge until green. |
| Phase 5 still red after merge-from-main | PR-A's fix is incomplete. If you own PR-A, iterate. If not, post on PR-A and pause. |
| Regression dispatch errored with "workflow not found" | The `jobs` input slug is wrong or the workflow is not yet on the dispatched ref. Verify with `gh workflow view regression-e2e.yaml --ref <ref> --yaml \| grep <slug>`. |
| Session died mid-dispatch-wait | Resume via checkpoint: read `dispatches[-1].run_id`, `gh run view` to get current status, continue. |
| PR-A author rejects the framing | Post findings, archive the checkpoint, stop. PR-B can still land as a standalone test on main. |

## Notes

- Regression dispatch takes **~30–45 min per run** for Brev-backed jobs. Budget accordingly.
- Regression guards do not run on the scheduled nightly until explicitly promoted. They are a holding pen for failing-test-first coverage and periodic review.
- Each candidate should produce exactly one PR-B. If the gap needs multiple tests, split into multiple loop invocations.
- When PR-A is authored by someone else, this skill authors PR-B, comments on PR-A, and leaves merge timing to the PR-A author.
