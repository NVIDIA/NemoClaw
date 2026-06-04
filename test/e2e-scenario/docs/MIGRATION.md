<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E migration tracking

Migration state for the scenario-based E2E framework is intentionally tracked
outside the repository, in GitHub issues and pull requests. This file documents
that policy so the repo does not retain stale per-script checklists, migrated
counts, or ownership tables after the work moves on.

## Where to track current work

- Use issue #3588 as the parent epic for the layered E2E scenario model.
- Use the active audit-coverage phase issues #4347 through #4357 for current
  domain-by-domain implementation, review, and reconciliation state.
- Use issue #4378 for the setup-scenario alias cleanup that bridges layered
  `test_plans` to friendly scenario IDs.
- Use the pull request for each change as the evidence record for what landed,
  what was deferred, and what follow-up issues remain.

## What belongs in the repo

Keep durable framework guidance here:

- how to run the scenario runner,
- where scenario metadata, typed builders, manifests, and suites live,
- how to add or review a scenario, expected state, assertion, or suite,
- stable conventions that should not change with every migration batch.

Do not add migration status tables, per-legacy-script checklists, temporary
coverage counts, or owner queues to this file. Put those in the issue or PR
that owns the work instead.

## Why

The E2E migration moves quickly and is coordinated across multiple issues and
pull requests. Keeping mutable migration state in GitHub avoids leaving stale
repo documentation that disagrees with the latest merged code or open review.
