---
name: nemoclaw-maintainer-cut-release-tag
description: "Prepare and cut one signed NemoClaw semver release tag, then follow release workflows and draft the Announcement."
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cut Release Tag

Cut one signed annotated semver tag from a generated plan. Use the release scripts for tag writes.
Use [Run Maintainer E2E](../nemoclaw-maintainer-e2e/SKILL.md) for maintainer-requested workflow
dispatches. Do not improvise tag, push, version-bump, or other release-state GitHub writes.

Treat these as separate states:

- **Tag can be cut:** the release entry and required image checks pass.
  The maintainer chooses to proceed with the displayed documentation coverage and general E2E state.
  The release brief records both decisions and contains no unresolved prompts.
- **Tag cut:** the remote signed tag exists and peels to the planned candidate.
- **Post-tag follow-through:** after reporting the tag as cut, continue the same task. Monitor
  `latest`, release labels, public documentation, and release images. Draft the Announcement and
  report `lkg` state.

## Hard Rules

- Use the requested version. Generate the plan with `--version vX.Y.Z`; never infer a bump.
- Tag only the candidate captured in the plan.
- By default, plan `origin/main` without an exception. For urgent QA qualification, a maintainer may
  select a historical ancestor with `--candidate <full-sha> --exception <reason>`.
- Require the release entry for a current-main plan. A historical plan records its explicit
  release-entry exception in the signed release brief.
- Treat documentation coverage as maintainer context, not a tag gate. Show the coverage point,
  later commits and PRs, review and check state, changed paths, and open managed docs PRs.
- Record the maintainer's documentation decision in the signed release brief.
- Require applicable GHCR base and managed-image publication evidence.
- Treat E2E as maintainer context, not a tag gate. Show the newest full E2E result and let the
  maintainer run focused tests, run the full suite, or proceed with the displayed status.
- Record every displayed or requested E2E result and the decision in the release brief, the signed
  Markdown release record. Record a plain-language exception reason when the status is exceptional
  or a requested run remains unresolved.
- Pass the final release brief to `release:cut` with `--message-file`. The file becomes the
  signed tag annotation; do not maintain another exception record.
- Ask the maintainer to paste the plan's full confirmation phrase before cutting.
- Push only the planned semver tag. Never push or move `latest` or `lkg` here.
- Report the tag as cut immediately after remote readback. This report is a progress checkpoint, not
  the final response.
- Continue the same task through post-tag follow-through. Do not make a post-tag result a tag gate.
- Ask before a workflow rerun. Never create a GitHub Discussion.
- Never move, delete, or replace an existing remote semver tag unless the maintainer starts a
  protected-tag remediation.
- Follow the [release-train policy](../nemoclaw-maintainer-policies/references/release-train.md) and
  the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).

## Work to the requested outcome

- **Prepare:** follow [Prepare the Release](references/prepare-release.md) and its linked candidate
  evidence. Start independent read-only checks early and prepare authorized documentation during
  image waits. Keep the planned candidate immutable.
- **Cut:** after the final brief is reviewable and the required confirmation is supplied, follow
  [Cut and Follow Through](references/cut-and-follow-through.md). Its tag readback establishes tag success.
- **Follow through:** continue the same task through automatic release workflows, the local
  Announcement draft, and `lkg` classification using the same reference.
- **Recover:** use [Recovery](references/recovery.md) for failed evidence or post-tag work. Retain the
  specific rerun authorization and immutable-tag boundaries.

The release confirmation protects a signed public tag. Do not apply that confirmation requirement
to preliminary reads or already-authorized preparation. Report tag success as a progress checkpoint;
report final completion only after the follow-through conditions are classified.
