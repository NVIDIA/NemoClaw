<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Review and Merge an E2E Repair

For workflow approval, review approval, merge, retry, or rollback PR writes, perform only the write that the trusted policy evaluator permits. Require an independent review, the shared approval gate, and unchanged GitHub identifiers before a merge.

## Run the write policy evaluator

Before a workflow approval, review, merge, retry, or rollback PR write, capture the GitHub object identifiers. From the clean candidate checkout, refresh canonical `origin/main`, then execute the wrapper source from that ref. The trusted ref—not the candidate checkout—selects the wrapper:

```bash
git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
bash <(git show origin/main:.agents/skills/nemoclaw-maintainer-fix-e2e-failures/scripts/run-trusted-policy.sh) policy-state.json
```

The wrapper refreshes `origin/main`, compares the evaluator with the current checkout, executes the trusted copy, and removes its temporary worktree.

Stop when a listed file is absent, differs, has local changes, or has an unlisted local import. Add an import to `policy_surface` only after review.

Use one supported `kind`: `ambiguous-write`, `fork-workflow-approval`, `review`, `merge`, or `post-merge-e2e`. The policy tests define each required state field.

Perform only the entry in `allowedWrites`. An empty list denies the write. Do not treat `reason` as permission. Re-read GitHub immediately before the write. Run the evaluator again when an identifier or merge requirement changes.

## Reconcile an ambiguous write

Treat a nonzero exit, timeout, interrupted response, or malformed response as a possible write. Do not retry immediately.

Re-read the remote object by its stable identifier. If GitHub has the intended state, continue. Otherwise, verify that all captured identifiers are unchanged before one retry. If the result stays uncertain, record the blocker and select another queue item.

Do not use another endpoint or write as a bypass. After transfer or cancellation starts, perform one read-only reconciliation and do not retry. Record the state, identifiers, owner, and next actor.

## Require an independent review

The fix owner handles diagnosis, implementation, tests, and CI follow-up. Another maintainer must approve the PR.

Do not approve when the reviewer is the PR opener, a commit author, or a co-author. Bind the review claim to the commit under review. Release the claim when the latest PR commit changes.

Use [Follow Up on PR CI and Reviews](../../_shared/pr-follow-up.md) for complete review collection. This workflow adds these requirements:

- The diff fixes one root cause.
- A diagnostic or regression test detects the failure.
- Security-sensitive changes receive `nemoclaw-maintainer-security-code-review`.
- Required CI passes for the commit under review before approval.

## Decide the requested write

### Approve a fork workflow

Approve only an `action_required` run for the expected repository, PR, workflow, and latest PR commit. Review the complete diff first. Confirm that the run is the ordinary untrusted-fork CI path and exposes no repository secret or privileged credential to PR code.

Re-read the run before and after approval. Record success only when GitHub reports the intended transition. An environment deployment approval is a different operation and belongs to its owning workflow.

### Refresh the branch

Evaluate branch currency after all other gates pass.

| State | Action |
|---|---|
| Conflict, required stale-base result, or explicit up-to-date rule | Refresh once before approval. |
| Current PR, or only advisory output mentions `main` | Do not refresh. |
| CI is pending or failing for the latest PR commit | Wait or repair. Do not refresh to create another attempt. |

Bind the update to the captured latest PR commit. After the write, require a new latest PR commit. Return the PR to CI and review. Do not use `--admin`, force-push, or update after approval.

### Approve

Apply [Decide Whether to Approve a Pull Request](../../nemoclaw-maintainer-day/MERGE-GATE.md). This workflow adds the independent-review and one-root-cause requirements above. It does not redefine the approval gates.

### Merge

Merge only when the user authorizes it, the evaluator permits it, the repair is not obsolete, and the shared approval gate still passes. Read the effective rules for `main` again. Require each active rule to pass for the unchanged PR commit and base commit. Bind the write to the commit under review:

```bash
gh api --method PUT \
  "repos/NVIDIA/NemoClaw/pulls/<pr-number>/merge" \
  -f sha='<commit-under-review-sha>' \
  -f merge_method='<allowed-method>'
```

If the commit precondition fails, restart the gate. Do not change the merge method as a retry. Never use `--admin`, disable a rule, dismiss a required review, or accept a skipped required check.

After the write, require `merged: true` and a `merge_commit_sha`. Reconcile an ambiguous result before any retry. Wait for automatic `main` E2E evidence before you record the root cause as fixed.
