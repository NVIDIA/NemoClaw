<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Release Train

Daily release labels coordinate release work. They do not classify issues and they do not promise readiness.

## Rules

- PRs own the release-inclusion meaning of daily version labels.
- Engineers and agents may add the current `v0.0.x` label to open PRs to activate them for day work.
- Issues may also carry daily version labels when they need a PR, fix, or regression follow-up for the daily tag.
- Applying a daily version label is not a readiness claim.
- Release includes PRs that both carry the daily version label and are merged by cutoff.
- Issue version labels are tracking signals only; an issue label does not include work in the release without a merged labeled PR.
- Open PRs with version labels carry forward automatically.
- A PR leaves the cycle only when the version label is removed.
- Version labels are pruned after seven days only after durable release history is preserved and no open PR still carries or depends on the old label.

## Cutoff

The daily cutoff is the maintainer-defined point where the release tag is prepared.

At cutoff:

1. List merged PRs carrying the target version label.
2. Confirm each is intended for the release.
3. List open PRs still carrying daily version labels as carry-forward work.
4. Generate QA handoff from merged PRs.
5. Cut the release tag only with explicit maintainer confirmation.

## Carry Forward

Open PRs with version labels remain active carry-forward work by default. Do not change the version label just because the day ended. Keep the label while the PR is still intended for the daily release flow, and remove it when the PR should leave that flow.

Maintainers may:

- Add the current version label when they want the PR visible in the current day queue.
- Remove an old version label when the PR is deferred, superseded, closed, or no longer part of the daily cycle.
- Keep an old version label until release history and dashboards no longer need it.

## Pruning

Old version labels may be deleted only when all conditions are true:

1. The label is older than seven days.
2. Durable release history has been preserved in tags, release notes, Agent Feed artifacts, or equivalent reports.
3. No open PR still carries or depends on the old label.
4. The current authorization context explicitly allows label pruning.

Pruning is a cleanup operation, not part of ordinary daily triage.
