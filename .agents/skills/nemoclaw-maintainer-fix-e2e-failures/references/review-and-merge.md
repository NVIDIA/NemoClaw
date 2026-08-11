<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Review and Merge

## Contents

- [Reconcile Every GitHub Write](#reconcile-every-github-write)
- [Run the Executable Write Guard](#run-the-executable-write-guard)
- [Separate Roles](#separate-roles)
- [Review the Exact Head](#review-the-exact-head)
- [Unblock “Approve and run workflows”](#unblock-approve-and-run-workflows)
- [Decide Whether to Refresh the Branch](#decide-whether-to-refresh-the-branch)
- [Final Merge Gate](#final-merge-gate)
- [Merge Without Bypass](#merge-without-bypass)

## Run the Executable Write Guard

The evaluator and every transitive local import are part of the write authority boundary. Never run
the checkout-local copy until its complete execution surface matches refreshed `origin/main`. The
evaluator currently has no local imports; if one is added, include it and its transitive local imports
in `policy_surface` before using the guard.

Before a retry, fork-workflow approval, review approval, merge, or rollback PR write, capture the
current GitHub identities. Then create a clean trusted worktree, compare the complete candidate
surface (including staged, unstaged, and untracked state) with that trusted source, and run only the
trusted worktree copy:

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

If any trusted file is absent, any comparison or worktree-state check fails, or the local import graph
is incomplete, do not execute the candidate evaluator. Obtain explicit approval for the exact changed
surface or use a separately reviewed trusted copy from a clean worktree. Remove the temporary trusted
worktree after the decision, including on an interrupted or denied run.

Use one supported `kind`: `ambiguous-write`, `fork-workflow-approval`, `review`, `merge`, or
`post-merge-e2e`. The executable scenarios in `test/maintainer-fix-e2e-policy.test.ts` define each
required state field.

Perform only the exact entry returned in `allowedWrites`. An empty list denies the requested write.
Do not reinterpret `reason` as permission. Re-read GitHub immediately before the write and rerun the
guard when an identity or gate changes.

## Reconcile Every GitHub Write

Treat a nonzero exit, timeout, interrupted response, or malformed response from a GitHub write as ambiguous. Do not assume that the write failed, and do not retry immediately.

Re-read the exact remote run, PR, review, branch head, or merge state by its stable identity. If the intended write occurred, continue from the observed state. If it did not occur, confirm that every captured identity is unchanged before one retry. If the result remains uncertain, record the blocker and continue another queue item.

Apply this rule to workflow approval, draft creation, push, branch update, review submission, merge, and PR closure. Never use a different write or bypass to resolve transport ambiguity.

If ownership transfers or the operator cancels while a write remains ambiguous, perform one read-only reconciliation. The outgoing agent does not retry the write after transfer or cancellation starts. Record the observed remote state, captured identities, owner, and next actor in the continuity handoff.

## Separate Roles

The fix owner owns diagnosis, code, tests, CI follow-up, and scope. A different maintainer owns the approval. The reviewer may have a separate waiting fix, but must review this PR independently.

Do not approve when the reviewer is the PR opener, a commit author, or a co-author. Do not approve merely because another agent approved your PR. Bind the review to the current head SHA. After that independent approval, either the author or another maintainer may perform the final gated merge.

Use available agent coordination before starting a review. Treat `Reviewing <head-sha>` in the coordination channel or on the PR as a review claim. If another reviewer already owns that exact head, review another PR or resume the failure queue.

A review claim applies only to the named head SHA. If the head changes, release the old claim, rescan, and claim and review the new head before approval. A waiting-CI PR may be reviewed, but approval must wait until required CI passes on that same head.

## Review the Exact Head

1. Capture the PR number, head SHA, base SHA, author, commits, files, draft state, merge state, reviews, review threads, and required checks.
2. Follow [Follow Up on PR CI and Reviews](../../_shared/pr-follow-up.md) for complete, head-stable collection and actionable feedback.
3. Confirm that the diff fixes one root cause and includes the missing prevention evidence.
4. Run `nemoclaw-maintainer-security-code-review` when the change touches credentials, remote execution, workflows, containers, policies, dependencies, or another security-sensitive boundary.
5. Resolve every correctness, security, data-safety, supported-contract, and required-test finding. Do not block on style-only suggestions.
6. Submit approval only after branch refresh and final CI for the approved head.

## Unblock “Approve and run workflows”

Do not leave an eligible first-time contributor run with an `action_required` conclusion or state without a decision.

1. Resolve the PR from the workflow run and capture the current PR head and base SHAs.
2. Require the run to belong to the expected `pull_request` workflow, repository, PR, and current head SHA.
3. Review the complete candidate diff, including workflow and dependency changes. Confirm that the run is the ordinary untrusted-fork CI path and does not expose repository secrets or privileged credentials to candidate code.
4. Re-read the run immediately before approval. If its conclusion or state is still `action_required` and the identity is unchanged, approve it:

   ```bash
   gh api --method POST \
     "repos/NVIDIA/NemoClaw/actions/runs/<run-id>/approve"
   ```

5. Re-read the run after the write. Record the approving maintainer and run URL only when GitHub reports the intended transition, then monitor the resulting checks.

If the trust boundary is unclear, sensitive workflow code changed, the run is stale, or authorization is missing, record the exact blocker and take another queue item. Do not use another workflow, rerun, or privileged dispatch as a workaround.

An environment deployment approval is not this operation. Follow the owning workflow skill for an environment gate, especially for credentialed or hardware E2E.

## Decide Whether to Refresh the Branch

Do not refresh a draft or active fix merely because `main` advanced. Do not merge `main` repeatedly while CI or review is still finding defects.

Evaluate branch currency after every other gate passes:

| Observed state | Action |
|---|---|
| PR has conflicts | Resolve mechanically through the salvage workflow. Stop if resolution changes behavior. |
| Existing gate checker reports `BEHIND` or stale base | Refresh once before approval, then wait for the new head's checks. |
| GitHub rules explicitly require an up-to-date branch | Refresh once before approval. |
| A required check or exact-diff E2E result names an older base | Refresh once before approval. |
| PR is current, or only optional/advisory output mentions `main` | Do not refresh. Diagnose the actual gate. |
| CI is pending or failing for the current head | Do not refresh to manufacture another attempt. Wait or fix the root cause. |

For an eligible PR, prefer GitHub's guarded update operation and bind it to the captured head:

```bash
gh api --method PUT \
  "repos/NVIDIA/NemoClaw/pulls/<pr-number>/update-branch" \
  -f expected_head_sha='<captured-head-sha>'
```

Re-read the PR after the write and require a new head before classifying the refresh as successful. Do not use `--admin`, force-push, or update after approval. A refresh creates a new head, invalidates prior CI identity, and can dismiss approval. Return the PR to `waiting-ci`, then require a new current-head review.

## Final Merge Gate

Treat the gate checker and all transitive local imports as execution surfaces. Refresh `origin/main`. Before executing a checkout-local copy, compare the complete execution surface with refreshed `origin/main`, including staged, unstaged, and untracked files. If any surface differs, do not execute the checkout-local copy. Obtain explicit user approval for the exact changed surface, or invoke a separately reviewed trusted copy from a clean `origin/main` worktree.

Immediately before approval, run that trusted gate checker as a preliminary gate:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number>
```

Also read the effective rules for `main` as part of the preliminary gate. Treat every active required-status and pull-request-review rule as authoritative even when it changed during the loop:

```bash
gh api --paginate "repos/NVIDIA/NemoClaw/rules/branches/main"
```

Before approval, require every preliminary gate other than the still-missing independent approval to pass for the captured head and base. The reviewer then submits the approval.

After the approval write, re-read the PR, head SHA, base SHA, review decision, required checks, and merge state. Rerun both the trusted gate checker and the effective-rules read. Require the post-approval checker to return `allPass: true` and every current effective rule to pass for the same head and base. If any relevant identity, rule, check, review, or merge state changed, restart the final gate.

Require all of these conditions:

- product scope is already accepted;
- PR body includes the contributor's DCO declaration;
- every PR commit appears `Verified` in GitHub;
- the existing gate checker returns `allPass: true` for the captured head and base;
- every check required by the current effective GitHub rules is completed successfully for the current head;
- every current pull-request-review rule is satisfied, including at least one independent current-head approval;
- no unresolved actionable feedback remains;
- required tests and applicable security review pass;
- a current-head approval exists from a maintainer who is not a contributor to the PR;
- the PR remains open, non-draft, mergeable, and current with `main`;
- the fix is not obsolete.

## Merge Without Bypass

When the invocation grants merge authority and every final gate remains true, use an allowed repository merge method and bind the write to the captured reviewed head SHA:

```bash
gh api --method PUT \
  "repos/NVIDIA/NemoClaw/pulls/<pr-number>/merge" \
  -f sha='<captured-head-sha>' \
  -f merge_method='<allowed-method>'
```

If the head precondition fails, re-read the PR and restart the final gate. Do not retry through another merge method. Never pass `--admin`, disable a rule, dismiss a required review, or accept a skipped or neutral required check.

After the merge write, re-read the PR. Require GitHub to report `merged: true` and a resulting `merge_commit_sha` for the selected merge method. On rejection or transport ambiguity, apply the common write rule before any retry. Take the indicated normal action or record the blocker; do not retry through a bypass. Wait for later automatic `main` E2E evidence before counting the root cause as verified fixed.
