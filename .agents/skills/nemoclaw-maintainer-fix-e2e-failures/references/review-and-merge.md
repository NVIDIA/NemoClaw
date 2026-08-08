<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Review and Merge

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

Immediately before approval, run the existing gate checker:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number>
```

Also read the effective rules for `main` immediately before the decision. Treat every active required-status and pull-request-review rule as authoritative even when it changed during the loop:

```bash
gh api --paginate "repos/NVIDIA/NemoClaw/rules/branches/main"
```

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

The reviewer submits the approval. After approval, re-read the PR, head SHA, base SHA, review decision, required checks, and merge state. Restart the gate if anything changed.

## Merge Without Bypass

When the invocation grants merge authority and every final gate remains true, merge with an allowed repository method. Never pass `--admin`, disable a rule, dismiss a required review, or accept a skipped or neutral required check.

After the merge write, re-read the PR and require GitHub to report it merged with a merge commit. On rejection or transport ambiguity, apply the common write rule before any retry. Take the indicated normal action or record the blocker; do not retry through a bypass. Wait for later automatic `main` E2E evidence before counting the root cause as verified fixed.
