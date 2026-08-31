---
name: nemoclaw-maintainer-evening
description: Runs the end-of-day NemoClaw release handoff and optionally cuts a release tag. Use for evening, handoff, wrap-up, or ship requests.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer Evening

Close the day with one release candidate, one cumulative documentation change, and a clear handoff.
Tagging is optional. Report tag creation first, then let the tag skill finish post-tag follow-through.

See [PR-REVIEW-PRIORITIES.md](../nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md) for the daily
cadence and the [release-train policy](../nemoclaw-maintainer-policies/references/release-train.md)
for release rules.

## 1. Select the Target Version

Use the maintainer's `vX.Y.Z` when supplied. Otherwise, read the current target and show its
merged and open work:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-day/scripts/version-target.ts
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-day/scripts/version-progress.ts vX.Y.Z
```

Do not silently convert the answer into a patch, minor, or major bump. If nothing shipped, ask
whether to stop without a tag.

## 2. Finish One Cumulative Documentation Change

Inspect the current `Docs / Author Post-Merge Catch-Up` state. The Pi workflow owns documentation catch-up
for merged changes. Continue its managed draft PR when one exists. If no managed PR exists and the
release entry is the only missing change, use one direct documentation-only PR.

The documentation PR must contain all required documentation for every merged change selected for
the release and one canonical dated entry headed `## vX.Y.Z`. Follow
[`docs/CONTRIBUTING.md`](../../../docs/CONTRIBUTING.md) and obtain its required independent
documentation writer review. Do not create a separate release-entry PR when the active cumulative
docs PR can carry it.

Merge the documentation PR before selecting the tag candidate. A docs-only merge does not start
another `Docs / Author Post-Merge Catch-Up` run. Preserve the merged PR, its final commit, its merge commit,
and the final automated refresh coverage commit for the tag session.

If another product merge lands before candidate selection, decide whether it belongs in this
release. When it does, update the cumulative documentation change first. When it does not, the tag
skill may keep an earlier planned candidate that remains on `main`; later managed documentation work
does not invalidate that candidate.

When an included merge changes the candidate after planning, generate a new version plan after
its documentation merges.

## 3. Show the Release Handoff

Show:

- merged work in `vX.Y.Z`;
- open PRs and issues still carrying `vX.Y.Z`;
- the canonical release entry;
- the cumulative docs PR, coverage commit, later commits and PRs, review state, and check state;
- known image-publication state; and
- the newest full E2E status, SHA, age, and URLs.

Open labeled items are post-tag planning state, not a tag blocker. State which items are expected to
move to the next target, but do not perform label writes here.

## 4. Cut the Tag When Requested

Load `nemoclaw-maintainer-cut-release-tag` and pass the version. That skill owns:

- the version plan and candidate;
- the required release entry, documentation coverage decision, and image evidence;
- the maintainer's focused, full, or proceed E2E choice;
- `../nemoclaw-release-vX.Y.Z/release-brief.md`;
- the exact confirmation phrase; and
- signed tag creation and remote readback.

Do not run a full E2E suite automatically. Do not ask for confirmation until the release brief is
complete and the maintainer has reviewed it.

## 5. Complete the Handoff

After tag readback, report:

- tag and candidate commit;
- plan and release-brief paths;
- documentation coverage, maintainer decision, and image evidence URLs; and
- E2E decision and exception reason, if any.

Then let `nemoclaw-maintainer-cut-release-tag` monitor the automatic post-tag workflows, draft the
Announcement, and report `lkg` state. A post-tag failure does not change tag success.

## Hard Rules

- Never cut a tag without the maintainer's exact confirmation phrase.
- Never bypass the release entry, documentation coverage decision, or applicable GHCR evidence.
- Never make a different candidate stale merely because `main` advanced or a later documentation PR opened.
- Never delay the tag-cut report for post-tag work. Continue the same task after that report.
