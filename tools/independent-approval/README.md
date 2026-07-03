<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Independent approval policy

This directory contains the deterministic policy evaluator and a repository-side interim GitHub
Actions adapter for issue #6222.

The evaluator disqualifies the pull request opener, mapped commit authors and co-authors, mapped
committers, and observed push actors. It accepts one current-head approval from a non-service
`User` with write, maintain, or admin repository permission. Existing reviews remain recorded; the
policy does not dismiss stale approvals.

## Repository-side interim

The Actions implementation uses three boundaries:

1. `pull_request_target` records each event against its webhook head. If the live head has already
   advanced, the delayed event still preserves its push actor and conservatively unions the live
   contributor snapshot into the append-only PR contributor set.
2. An unprivileged `pull_request_review` workflow emits no required context. Its completion wakes a
   trusted default-branch `workflow_run` reconciler.
3. The reconciler creates or updates `independent-human-approval` on the exact live head SHA.
   A five-minute schedule repairs missed review signals and fails closed on missing observations.

Only the manually published `independent-human-approval` Check Run is a policy result. The signal,
recorder, and reconciler job conclusions must not be configured as required checks.
Because GitHub checks are commit-scoped, open PRs that share one head SHA also share this result; the
reconciler requires every associated open PR to satisfy the policy before that SHA passes.

## Security boundary and activation

This repository-side adapter is defense in depth, not the final source-isolated enforcement
described by #6222. All Actions workflows share the `github-actions` App identity, PR comments are
not tamper-proof storage, review dismissal and check publication are not atomic, and contributors
who pushed before deployment cannot be reconstructed reliably. Returning a branch to a previously
successful SHA can expose the old commit-scoped result until the synchronize event is reconciled;
the native last-pusher rule is therefore a prerequisite, not an optional enhancement. Merge-queue
publication is not implemented, so enabling this check for a merge queue fails closed.

Full enforcement therefore still requires a centrally governed GitHub App or service with durable
append-only storage, eligible human-team membership, and a `main` ruleset that pins the required
check to that App. The native ruleset should also require one pull request approval, approval of the
most recent reviewable push by someone other than the last pusher, resolved conversations, and no
routine bypass. Blanket stale-approval dismissal remains disabled.
