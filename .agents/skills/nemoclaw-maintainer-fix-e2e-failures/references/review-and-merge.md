<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Review and Merge

## Contents

- [Run the Write Policy Evaluator](#run-the-write-policy-evaluator)
- [Reconcile Every GitHub Write](#reconcile-every-github-write)
- [Separate Roles](#separate-roles)
- [Review the Commit Under Review](#review-the-commit-under-review)
- [Unblock “Approve and run workflows”](#unblock-approve-and-run-workflows)
- [Decide Whether to Refresh the Branch](#decide-whether-to-refresh-the-branch)
- [Final Merge Gate](#final-merge-gate)
- [Merge Without Bypass](#merge-without-bypass)

## Run the Write Policy Evaluator

The evaluator and every local file that it imports control whether GitHub writes are permitted.
Refresh `origin/main` before running the evaluator. The evaluator currently has no local imports.
If it gains one, add that file and all of its local imports to `policy_surface`.

Before a retry, fork-workflow approval, review approval, merge, or rollback PR write, capture the
GitHub object identifiers. Create a temporary worktree at refreshed `origin/main`. Compare each file
in `policy_surface` with its counterpart in the PR worktree. Include staged, unstaged, and untracked
changes in that comparison. Run the evaluator only from the temporary worktree:

```bash
set -euo pipefail
git fetch origin main
trusted_policy_tmp=$(mktemp -d)
trusted_policy_root="$trusted_policy_tmp/main"
cleanup_trusted_policy_root() {
  git worktree remove --force "$trusted_policy_root" >/dev/null 2>&1 || true
  rmdir "$trusted_policy_tmp" >/dev/null 2>&1 || true
}
trap cleanup_trusted_policy_root EXIT INT TERM
git worktree add --detach "$trusted_policy_root" origin/main
policy_path=.agents/skills/nemoclaw-maintainer-fix-e2e-failures/scripts/evaluate-policy.mts
policy_surface=("$policy_path")
for policy_file in "${policy_surface[@]}"; do
  test -f "$trusted_policy_root/$policy_file"
  test -f "$policy_file"
  cmp -s "$trusted_policy_root/$policy_file" "$policy_file"
done
test -z "$(git status --porcelain -- "${policy_surface[@]}")"
node --experimental-strip-types \
  "$trusted_policy_root/$policy_path" \
  < <policy-state.json>
cleanup_trusted_policy_root
trap - EXIT INT TERM
```

If a listed file is absent, a comparison fails, or the local import list is incomplete, do not run
the evaluator. Obtain explicit approval for the named changed files or use a separately reviewed copy
from an `origin/main` worktree. Remove the temporary worktree after the decision, including after an
interrupted or denied run.

Use one supported `kind`: `ambiguous-write`, `fork-workflow-approval`, `review`, `merge`, or
`post-merge-e2e`. The executable scenarios in `test/automation/pull-requests/maintainer-fix-e2e-policy.test.ts` define each
required state field.

Perform only the entry returned in `allowedWrites`. An empty list denies the requested write.
Do not treat `reason` as permission. Re-read GitHub immediately before the write. Run the evaluator
again when an object identifier or merge requirement changes.

## Reconcile Every GitHub Write

Treat a nonzero exit, timeout, interrupted response, or malformed response from a GitHub write as ambiguous. Do not assume that the write failed, and do not retry immediately.

Re-read the remote run, PR, review, latest branch commit SHA, or merge state by its stable identifier. If GitHub contains the intended write, continue from the observed state. Otherwise, confirm that every captured identifier is unchanged before one retry. If the result remains uncertain, record the blocker and continue with another queue item.

Apply this rule to workflow approval, draft creation, push, branch update, review submission, merge, and PR closure. Never use a different write or bypass to resolve transport ambiguity.

If ownership transfers or the operator cancels while a write remains ambiguous, perform one read-only reconciliation. The outgoing agent does not retry the write after transfer or cancellation starts. Record the observed remote state, captured identifiers, owner, and next actor in the continuity handoff.

## Separate Roles

The fix owner handles diagnosis, code, tests, CI follow-up, and scope. A different maintainer must approve the PR. The reviewer may have a separate waiting fix, but must review this PR independently.

Do not approve when the reviewer is the PR opener, a commit author, or a co-author. Another agent's approval of your PR does not justify approving that agent's PR. Bind the review to the commit under review. After that independent approval, either the author or another maintainer may perform the final merge.

Use available agent coordination before starting a review. Treat `Reviewing <commit-sha>` in the coordination channel or on the PR as a review claim. If another reviewer already owns that commit SHA, review another PR or resume the failure queue.

A review claim applies only to the named commit SHA. If the latest PR commit changes, release the prior claim. Then rescan, claim, and review the latest PR commit before approval. A `waiting-ci` PR may be reviewed, but approval must wait until required CI passes for the commit under review.

## Review the Commit Under Review

1. Capture the PR number, latest PR commit SHA, base SHA, author, commits, files, draft state, merge state, reviews, review threads, and required checks.
2. Follow [Follow Up on PR CI and Reviews](../../_shared/pr-follow-up.md) to collect complete data for one unchanged latest PR commit.
3. Confirm that the diff fixes one root cause. Require a diagnostic or regression test that would detect the failure.
4. Run `nemoclaw-maintainer-security-code-review` when the change touches credentials, remote execution, workflows, containers, policies, dependencies, or another security-sensitive boundary.
5. Resolve every correctness, security, data-safety, supported-contract, and required-test finding. Do not block on style-only suggestions.
6. Submit approval only after branch refresh and final CI for the commit under review.

## Unblock “Approve and run workflows”

Do not leave an eligible first-time contributor run with an `action_required` conclusion or state without a decision.

1. Resolve the PR from the workflow run and capture the latest PR commit SHA and base SHA.
2. Require the run to belong to the expected `pull_request` workflow, repository, PR, and latest PR commit.
3. Review the complete PR diff, including workflow and dependency changes. Confirm that the run is the ordinary untrusted-fork CI path and does not expose repository secrets or privileged credentials to PR code.
4. Re-read the run immediately before approval. If its conclusion or state is still `action_required` and its run identifier and commit SHA are unchanged, approve it:

   ```bash
   gh api --method POST \
     "repos/NVIDIA/NemoClaw/actions/runs/<run-id>/approve"
   ```

5. Re-read the run after the write. Record the approving maintainer and run URL only when GitHub reports the intended transition, then monitor the resulting checks.

If the trust boundary is unclear, sensitive workflow code changed, the run is stale, or authorization is missing, record the exact blocker and take another queue item. Do not use another workflow, rerun, or privileged dispatch as a workaround.

An environment deployment approval is not this operation. Follow the owning workflow skill for an environment gate, especially for credentialed or hardware E2E.

## Decide Whether to Refresh the Branch

Do not refresh a draft or active fix merely because `origin/main` has a later commit. Do not merge `main` repeatedly while CI or review is still finding defects.

Evaluate branch currency after every other gate passes:

| Observed state | Action |
|---|---|
| PR has conflicts | Resolve mechanically through the salvage workflow. Stop if resolution changes behavior. |
| Existing gate checker reports `BEHIND` or a stale base | Refresh once before approval, then wait for checks on the new commit. |
| GitHub rules explicitly require an up-to-date branch | Refresh once before approval. |
| A required check or an E2E result for the PR diff names an older base | Refresh once before approval. |
| PR is current, or only optional/advisory output mentions `main` | Do not refresh. Diagnose the actual gate. |
| CI is pending or failing for the latest PR commit | Do not refresh to manufacture another attempt. Wait or fix the root cause. |

For an eligible PR, use GitHub's `update-branch` API. Bind it to the captured latest PR commit:

```bash
gh api --method PUT \
  "repos/NVIDIA/NemoClaw/pulls/<pr-number>/update-branch" \
  -f expected_head_sha='<captured-commit-sha>'
```

Re-read the PR after the write. Require the latest PR commit SHA to change before recording a successful refresh. Do not use `--admin`, force-push, or update after approval. A refresh creates a new commit, invalidates prior CI evidence, and can dismiss approval. Return the PR to `waiting-ci`, then require a review of the latest PR commit.

## Final Merge Gate

The gate checker and every local file that it imports determine whether the PR can be approved. Refresh `origin/main`. Do not run the checker from the PR worktree. Compare each checker file with its counterpart in `origin/main`, including staged, unstaged, and untracked changes. If a file differs, obtain explicit user approval for the named changed files or use a separately reviewed copy from an `origin/main` worktree.

Immediately before approval, create a new temporary worktree at `origin/main`. Run only that
worktree's gate checker for the preliminary result. `check-gates.ts` currently imports `shared.ts`.
Both files must match their counterparts in the PR worktree before the checker runs:

```bash
set -euo pipefail
git fetch origin main
trusted_gate_tmp=$(mktemp -d)
trusted_gate_root="$trusted_gate_tmp/main"
cleanup_trusted_gate_root() {
  git worktree remove --force "$trusted_gate_root" >/dev/null 2>&1 || true
  rmdir "$trusted_gate_tmp" >/dev/null 2>&1 || true
}
trap cleanup_trusted_gate_root EXIT INT TERM
git worktree add --detach "$trusted_gate_root" origin/main
gate_path=.agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts
gate_shared_path=.agents/skills/nemoclaw-maintainer-day/scripts/shared.ts
gate_surface=("$gate_path" "$gate_shared_path")
for gate_file in "${gate_surface[@]}"; do
  test -f "$trusted_gate_root/$gate_file"
  test -f "$gate_file"
  cmp -s "$trusted_gate_root/$gate_file" "$gate_file"
done
test -z "$(git status --porcelain -- "${gate_surface[@]}")"
node --experimental-strip-types --no-warnings \
  "$trusted_gate_root/$gate_path" <pr-number>
cleanup_trusted_gate_root
trap - EXIT INT TERM
```

If either file differs, is missing, has PR worktree changes, or gains an unlisted local import, stop
before running the checker. Do not run the checker from the PR worktree. Update `gate_surface` only
after reviewing every new local import.

Also read the effective rules for `main` as part of the preliminary merge check. Treat every active required-status and pull-request-review rule as authoritative even when it changed during the loop:

```bash
gh api --paginate "repos/NVIDIA/NemoClaw/rules/branches/main"
```

Before approval, require every preliminary merge condition except the independent approval to pass for the captured latest PR commit and base SHA. The reviewer then submits the approval.

After the approval write, re-read the PR, latest PR commit SHA, base SHA, review decision, required checks, and merge state. Run the `origin/main` gate checker and read the effective rules again. Require the checker to return `allPass: true`. Require every effective rule to pass for the same latest PR commit and base SHA. If an identifier, rule, check, review, or merge state changed, restart the final gate.

Require all of these conditions:

- product scope is already accepted;
- PR body includes the contributor's DCO declaration;
- every PR commit appears `Verified` in GitHub;
- `check-gates.ts` returns `allPass: true` for the captured latest PR commit and base SHA;
- every check required by the effective GitHub rules is completed successfully for the latest PR commit;
- every pull-request-review rule is satisfied, including at least one independent approval of the latest PR commit;
- no unresolved actionable feedback remains;
- required tests and applicable security review pass;
- an approval of the latest PR commit exists from a maintainer who is not a contributor to the PR;
- the PR remains open, non-draft, mergeable, and current with `main`;
- the fix is not obsolete.

## Merge Without Bypass

When the request grants merge authorization and every final condition remains true, use an allowed repository merge method. Bind the write to the commit under review:

```bash
gh api --method PUT \
  "repos/NVIDIA/NemoClaw/pulls/<pr-number>/merge" \
  -f sha='<commit-under-review-sha>' \
  -f merge_method='<allowed-method>'
```

If the commit SHA precondition fails, re-read the PR and restart the final gate. Do not retry through another merge method. Never pass `--admin`, disable a rule, dismiss a required review, or accept a skipped or neutral required check.

After the merge write, re-read the PR. Require GitHub to report `merged: true` and a resulting `merge_commit_sha` for the selected merge method. On rejection or transport ambiguity, apply the ambiguous GitHub write rule before any retry. Perform the evaluator's permitted action or record the blocker. Do not retry through a bypass. Wait for later automatic `main` E2E evidence before counting the root cause as verified fixed.
