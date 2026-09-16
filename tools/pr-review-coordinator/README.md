<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR review coordinator

This directory contains the side-effect-free decision core for a repository-owned review
coordinator. The coordinator consumes an exact-head PR Review Advisor result, repository
readiness, and the prior review contract. It decides whether a GitHub adapter should stay quiet,
request changes, or approve.

The local command is deliberately read-only:

```bash
npm run review:coordinate:local -- --input tools/pr-review-coordinator/examples/clear.json
```

It does not call GitHub, run the Advisor, post reviews, modify branches, rerun CI, merge, or use an
App key. This makes it safe to exercise the policy directly.

The checked-in Advisor workflow runs `shadow.mts` after every complete exact-head specialist run.
That adapter verifies the shared exact-head artifacts and emits a retained decision artifact and job
summary. It has read-only repository permissions. Model findings remain ambiguous in shadow mode,
and commit-verification and product-scope gates remain closed, so the adapter cannot propose a
review write or approval from evidence it does not yet own.

The policy preserves the maintainer review loop's important behavior. Its input is reconciled
Advisor evidence: the adapter must retain only P0/P1 ledger findings and label whether each finding
belongs to the frozen contract or was newly proven on the exact follow-up delta.

- Advisor cadence is unchanged. The coordinator only consumes a complete result for the exact
  current head and base.
- The first validated P0/P1 result becomes one consolidated changes-requested review.
- Already-reported findings become a frozen contract and are not repeated on later commits.
- Follow-up feedback is allowed only for a validated P0/P1 blocker newly introduced or newly
  proven by the reviewed delta.
- Malformed evidence and unsupported Advisor statuses are rejected before a decision.
- Ambiguous evidence, stale results, pending prerequisites, drafts, self-authored changes, and
  duplicate exact-head writes stay quiet.
- Approval is proposed only for an exact head with a clear Advisor result, passing required checks,
  mergeability, verified commits, and accepted product scope.

Any future GitHub writer must re-read the live head and base immediately before a write and apply
the same duplicate-write guard. Approval and merge remain separate actions; this coordinator never
merges.
