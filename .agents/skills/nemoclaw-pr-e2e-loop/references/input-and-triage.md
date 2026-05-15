# Phase 0 — Input Resolution & Candidate Selection

<!-- markdownlint-disable MD022 MD031 MD032 MD040 MD058 -->


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
