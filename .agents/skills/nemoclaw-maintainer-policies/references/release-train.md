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
- Open PRs and issues that miss a tagged release carry forward automatically by moving from the released version label to the next patch label.
- A PR or issue leaves the daily release cycle only when its version label is removed without a replacement.
- Version labels are pruned after seven days only after durable release history is preserved and no open PR still carries or depends on the old label.

## Release Lifecycle

NemoClaw uses this release sequence:

```text
prepare -> declare ready -> freeze/plan -> tag candidate -> validate -> promote lkg
```

The semver tag publishes the release candidate, including public docs and release artifacts.
Release-prep docs therefore gate the semver tag.
Exact-tag E2E and QA validation gate `lkg` promotion unless maintainers explicitly choose a different release model.

The release plan is the commit-freeze boundary.
All mutable release readiness work must finish before `release:plan` captures the final `origin/main` SHA.
Any merge after plan generation invalidates the plan and requires maintainers to re-check readiness against the new candidate SHA before generating a fresh plan.

## Cutoff

The daily cutoff is the maintainer-defined point where the release tag is prepared.

At cutoff:

1. List merged PRs carrying the target version label.
2. Confirm each is intended for the release.
3. List open PRs and issues still carrying the target label as post-tag stragglers.
4. Merge release-prep docs, or record a maintainer waiver with the reason.
5. Record the SHA through which docs were scanned and review any `docs_scan_sha..candidate_sha` delta for additional docs impact.
6. Finish or explicitly waive every pre-tag check required for the release.
7. Confirm that no further intended merge remains.
8. Generate the final release plan for the current `origin/main` SHA.
9. Cut the release tag only with explicit maintainer confirmation from the final plan.
10. After the tag and workflow-managed `latest` are verified, automatically move every open straggler to the next patch label.

Release readiness is complete only when the maintainer can report:

- the cutoff inventory and post-tag straggler plan;
- release-prep docs status, either merged with PR and merge SHA or waived with reason;
- docs scan SHA and candidate SHA delta review;
- pre-tag check status, including waivers and reasons;
- confirmation that no further intended merge remains before plan generation.

If release-prep docs are still pending, stop before generating the release plan.

## Carry Forward

Open PRs and issues that miss the cutoff remain active carry-forward work, but their target changes after the release succeeds. Post-tag housekeeping creates the next patch label if needed, removes the released-version label from every open straggler, and adds the next patch label.

Run the automatic bump only after both the semver tag and workflow-managed `latest` resolve to the confirmed release commit. The release confirmation must include the housekeeping plan, so the post-tag label writes remain inside the authorized release operation.

Maintainers may:

- Add the current version label when they want the PR visible in the current day queue.
- Remove a version label without replacement when an item is deferred, superseded, closed, or no longer part of the daily cycle.
- Rerun post-tag housekeeping after a partial failure; already-moved items no longer match the released source label, so the operation is safely resumable.

## Pruning

Old version labels may be deleted only when all conditions are true:

1. The label is older than seven days.
2. Durable release history has been preserved in tags, release notes, Agent Feed artifacts, or equivalent reports.
3. No open PR or issue still carries or depends on the old label after post-tag housekeeping.
4. The current authorization context explicitly allows label pruning.

Pruning is a cleanup operation, not part of ordinary daily triage.
