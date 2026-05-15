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

See [references/input-and-triage.md](references/input-and-triage.md) for input resolution, candidate selection, and PR-A triage details.
## Phase 2 — Design PR-B (the failing test) — full-auto

See [references/test-pr-flow.md](references/test-pr-flow.md) for PR-B design, creation, red verification, and merge flow.
## Phase 4.5 — Delegate to issue-kickoff for PR-A (`issue-first` mode only)

See [references/green-verification-and-closeout.md](references/green-verification-and-closeout.md) for PR-A handoff, green verification, and closeout flow.
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
