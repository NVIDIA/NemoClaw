---
name: nemoclaw-maintainer-evening
description: Complete the NemoClaw v1 end-of-day documentation and product release handoff. Use to prepare a release and cut the final tag when the maintainer requests it.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from main's maintainer evening skill at 4649634639d2ddcb26b84cb34db63b2d4176a8a1 for the v1 branch, Rust release workflows, and Markdown changelog. -->

# NemoClaw Maintainer Evening

Close the day with one release candidate, one cumulative documentation change, and a release handoff.
Cut a final tag only when the maintainer requests the cut and confirms the plan.

## 1. Select the Target Version

Use the maintainer's requested final `v0.1.<patch>` version.
If they haven't specified one, fetch the v1 branch and release tags and find the latest final tag reachable from `origin/v1`.

```sh
git fetch origin refs/heads/v1:refs/remotes/origin/v1 'refs/tags/v0.1.*:refs/tags/v0.1.*' &&
  git tag --merged origin/v1 --sort=-version:refname --list 'v0.1.*' |
    awk '/^v0[.]1[.][0-9]+$/ { print; exit }'
```

Verify the result on the remote and check its release state.
For the first final release, show `v0.1.0` as the proposed target.
If the last final tag has published, propose the next patch. If its publication is pending, show its status.
Confirm the target with the maintainer.

List merged PRs in the release range and open PRs and issues assigned to the target version, using a version label when one exists.
Check that each reported merged PR is included in the intended release range on `v1`.
For the first release, use the agreed v1 launch scope and the [internal RC history](../../../internal-docs/contributing/release-candidates.md) to account for changes before and between the RCs.
If no changes are ready to ship, ask whether to end the handoff without tagging.

## 2. Finish One Cumulative Documentation Change

Start read-only checks for the release brief while the documentation is in review.
Find the same-version RC that staged the release images, its assessment, the product sign-offs, and the available E2E results.
Use the [product release runbook](../../../internal-docs/contributing/releases.md#publishing) to identify the required evidence.
Select the final tag candidate after the documentation is merged.

Check for an active documentation PR covering the selected changes.
Continue that PR if it can carry the release entry. If no such PR exists and documentation needs changes, use one documentation PR against `v1`.
Put the required documentation for all included changes and the dated `docs/changelog/YYYY-MM-DD.md` entry headed `## vX.Y.Z` in that PR.
Follow the [documentation contribution guide](../../../internal-docs/contributing/documentation.md), including independent review.
If the entry and documentation already cover the release, record the merged evidence and proceed.

Merge the documentation PR before selecting the tag candidate.
Keep its URL, merge commit, review, and check results.
If more product work lands, decide whether to include it and verify its documentation before selecting a new candidate.
Later commits can be carried forward while the selected candidate remains on `v1`.
If the release scope changes after planning, create a new plan after the updated documentation merges.

## 3. Show the Release Handoff

Show the maintainer:

- The requested version, included changes, and open PRs and issues still assigned to the version.
- The dated release entry, the merged docs PR or existing equivalent evidence, coverage commit, later changes, review, and checks.
- The same-version RC, staged image evidence, assessment, and installer, onboarding, QA, and product sign-offs.
- The newest relevant full E2E result from the [live test workflows](../../../internal-docs/contributing/testing.md#live-suites), with its revision, time, conclusion, and URL.

Ask the maintainer to accept the documentation coverage, request updates, or stop.
Resolve requested documentation updates before proceeding to tag confirmation.
Give the maintainer the choice to request focused tests, request the full suite, or proceed with the displayed E2E evidence.
Record the choice and the reason when the evidence has a gap.
List open items for carry-forward planning.

## 4. Cut the Tag When Requested

Load [Cut a v1 Product Release](../nemoclaw-maintainer-cut-release-tag/SKILL.md) for the requested version.
It owns the immutable candidate and brief, the pre-tag release-notes gate, exact maintainer confirmation, signed tag creation, and remote readback.
Ask for tag confirmation only after the maintainer can review the complete brief.

## 5. Complete the Handoff

Report the tag and candidate as soon as remote readback succeeds, with the plan and brief paths and the documentation, image, and E2E evidence.
Continue through the tag-triggered product release and documentation jobs, and draft an announcement from the approved brief.
Use [the tag skill's follow-through](../nemoclaw-maintainer-cut-release-tag/SKILL.md#follow-the-release) to classify the result of each workflow.
