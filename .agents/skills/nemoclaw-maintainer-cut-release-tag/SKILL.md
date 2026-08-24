---
name: nemoclaw-maintainer-cut-release-tag
description: Cuts one signed NemoClaw semver tag after required candidate checks and the maintainer's E2E decision, then follows the tag-triggered release work and drafts the Announcement. Use when preparing or publishing a vX.Y.Z release tag.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cut Release Tag

Cut one signed annotated semver tag from a generated plan. Use the release scripts for tag writes
and `nemoclaw-maintainer-e2e` for maintainer-requested workflow dispatches. Do not improvise raw tag,
push, version-bump, or other release-state GitHub writes.

Treat these as separate states:

- **Tag can be cut:** the release entry and required image checks pass.
  The maintainer chooses to proceed with the displayed documentation coverage and general E2E state.
  The release brief records both decisions and contains no unresolved prompts.
- **Tag cut:** the remote signed tag exists and peels to the planned candidate.
- **Post-tag follow-through:** after reporting the tag as cut, continue the same task. Monitor
  `latest`, release labels, public documentation, and release images. Draft the Announcement and
  report `lkg` state.

## Hard Rules

- Use the exact requested version. Generate the plan with `--version vX.Y.Z`; never infer a bump.
- Tag only the candidate captured in the plan.
- By default, plan `origin/main` without an exception. For urgent QA qualification, a maintainer may
  select an exact historical ancestor with `--candidate <full-sha> --exception <reason>`.
- Require the release entry for a current-main plan. A historical plan records its explicit
  release-entry exception in the signed release brief.
- Treat documentation coverage as maintainer context, not a tag gate. Show the exact coverage point,
  later commits and PRs, review and check state, changed paths, and open managed docs PRs.
- Record the maintainer's documentation decision in the signed release brief.
- Require applicable GHCR base and managed-image publication evidence.
- Treat E2E as maintainer context, not a tag gate. Show the newest full E2E result and let the
  maintainer run focused tests, run the full suite, or proceed with the displayed status.
- Record every displayed or requested E2E result and the decision in the release brief, the signed
  Markdown release record. Record a plain-language exception reason when the status is exceptional
  or a requested run remains unresolved.
- Pass the exact final release brief to `release:cut` with `--message-file`. The file becomes the
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

## Workflow

Copy this checklist and update it as you work:

```text
Release tag:
- [ ] 1. Generate the exact-version plan and release-brief template
- [ ] 2. Verify required candidate evidence
- [ ] 3. Show E2E context and record the maintainer's decision
- [ ] 4. Finish and review the Markdown release brief
- [ ] 5. Confirm, cut, and read back the signed tag
- [ ] 6. Follow tag-triggered work and draft the Announcement
```

### 1. Generate the Plan and Brief Template

Run the default current-main plan:

```bash
npm run release:plan -- --version vX.Y.Z
```

For an accepted urgent QA qualification, run:

```bash
npm run release:plan -- --version vX.Y.Z \
  --candidate <full-lowercase-40-sha> \
  --exception "<plain-language reason>"
```

Do not pass `--exception` without a historical candidate. Do not select current `origin/main` with an
exception.

The script writes `../nemoclaw-release-vX.Y.Z/plan.json`. Show the maintainer:

- previous tag and peeled commit;
- requested version;
- candidate commit and headline;
- exact range from the previous commit through the candidate; and
- the full confirmation phrase derived from the version and candidate.

After later reads of remote state, keep this candidate when all of these remain true:

- the candidate is still an ancestor of `origin/main`;
- the previous release tag still peels to the commit recorded in the plan;
- the candidate's release entry remains valid, or the historical plan retains its explicit
  release-entry exception; and
- the candidate's own required evidence remains valid.

New commits on `main` do not invalidate that plan. A managed documentation PR or branch for a later
commit does not invalidate it either. Regenerate the plan only when the release range, version, or
candidate must change.

The plan is immutable once written. The helper creates the brief only when it is absent; fill that
same brief in place. A same-version candidate change starts a new release workspace, such as
`../nemoclaw-release-vX.Y.Z-replan-2/`. Never overwrite a plan or pair a new plan with an old brief.
Pass that workspace explicitly:

```bash
npm run release:plan -- --version vX.Y.Z \
  --output ../nemoclaw-release-vX.Y.Z-replan-2/plan.json
```

Use the returned plan directory for the brief and cutter commands that follow.

Create the brief template now, before collecting evidence, so each result can be recorded as it is
read:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary.ts \
  --plan ../nemoclaw-release-vX.Y.Z/plan.json \
  --output ../nemoclaw-release-vX.Y.Z/release-brief.md
```

The helper refuses to overwrite an existing brief. Fill this generated file in place; do not rerun
the helper after evidence has been added.

### 2. Verify Required Candidate Evidence

Read and follow [Candidate Evidence](references/candidate-evidence.md). It owns the executable reads
for the release entry, documentation coverage, and applicable base-image verifier.

Show the complete documentation coverage evidence. Offer the maintainer the three choices defined
there. If the maintainer requests documentation work or stops, do not continue to E2E or tag
confirmation. If the maintainer proceeds, record the exact decision line in the release brief.

Do not offer the general E2E proceed option until the release entry and image checks pass and the
maintainer chooses to proceed with the displayed documentation coverage. Record the returned paths,
URLs, PR state, commit ranges, review state, check state, and image identities in the release brief.

### 3. Present General E2E and Ask for a Decision

Use `nemoclaw-maintainer-e2e` to find the newest completed or active full E2E run. Show these details
instead of reducing the run to one passing/failing label:

- candidate SHA and full-run SHA;
- status and conclusion;
- workflow attempt, created, started, and last-updated timestamps, plus age at inspection;
- workflow URL and `Release qualification` job URL; and
- any failed, cancelled, skipped, queued, or still-running results.

Offer exactly these choices:

1. Run focused tests selected by the maintainer.
2. Run the full suite.
3. Proceed with the status as shown.

After a requested run, show its same fields and add every result to the release brief. A requested
run remains unresolved while it is queued or running, or after it ends without success. It becomes
resolved only when a successful result covers the same requested scope.

Use `Exceptions: None` only when the maintainer accepts a successful full result for the candidate
and no requested run remains unresolved. Otherwise, ask for and record one concise plain-language
reason. The reason must say what differs or remains unresolved and why the maintainer is proceeding.
Selecting “Proceed with the status as shown” is the decision, not the reason. Stop and ask the
maintainer why before continuing when a reason is required.
This exception applies only to E2E. It never replaces the current-main release entry, a historical
plan's release-entry exception, the documentation coverage decision, or required image evidence.

### 4. Finish and Review the Release Brief

Replace every `TODO_RELEASE_BRIEF` prompt in that Markdown file with:

- the complete canonical release entry and its repository path for a current-main plan, or the
  plan-bound historical release-entry exception;
- the latest included cumulative docs PR, coverage commit, later commits and PRs, changed-path
  result, review and check state, open managed docs PRs, and maintainer decision;
- exact-candidate E2E workflow, attempt, and successful `base-image-publication` job URL;
- the newest full E2E result and every focused or full rerun result, including SHA, time, age, status,
  conclusion, and URLs;
- the maintainer's E2E choice; and
- a final `Exceptions: None` line or `Exceptions: <plain-language reason>` line.

Keep the helper's compact range counts and QA focus. Do not duplicate every commit or risky file;
the canonical release entry and compare range already preserve that detail.

Do not put secrets in the brief. Show the complete rendered file to the maintainer. Because this
exact public Markdown becomes the signed tag annotation, make any correction in the file before
asking for confirmation.

### 5. Confirm, Cut, and Report the Tag

Ask the maintainer to paste the plan's exact phrase:

```text
CONFIRM RELEASE vX.Y.Z <full-candidate-sha>
```

After receiving that exact phrase, run the cutter immediately. The cutter reads the immutable plan,
validates the signed release brief's documentation decision, and checks remote tag state before the
push.

Run:

```bash
npm run release:cut -- \
  --plan ../nemoclaw-release-vX.Y.Z/plan.json \
  --message-file ../nemoclaw-release-vX.Y.Z/release-brief.md \
  --confirm "CONFIRM RELEASE vX.Y.Z <full-candidate-sha>"
```

Require the script's remote readback to show that the signed annotated tag exists and peels to the
planned candidate. Report the tag, candidate, plan path, brief path, and readback. Then continue the
same task.

### 6. Follow Tag-Triggered Work and Draft the Announcement

Start these operations together:

1. Load `nemoclaw-maintainer-release-notes`. Draft `release-note-draft.md` from the plan's immutable
   range. Open the completed draft in the requested editor. Never create the Discussion.
2. Find the tag-push runs for these workflow files:
   - `.github/workflows/release-latest-tag.yaml`
   - `.github/workflows/docs-publish-public.yaml`
   - `.github/workflows/base-image.yaml`
3. Bind each run by workflow path, `event=push`, release tag, and planned candidate. Retain its run
   ID and attempt. Monitor the three runs concurrently until they reach terminal results.

Classify the effects that each workflow owns:

- For `Release / Latest Tag`, verify that `latest` identifies the release tag. Verify label
  carry-forward and released-label deletion.
- For `Docs / Publish Public`, require the `publish` job to succeed.
- For `Images / Base Images`, require `Publish complete managed images` to
  succeed. Report Pi candidate failures separately; they do not determine production promotion.

A failed post-tag workflow does not change tag success. Report the failing job and recovery path.
Ask before a rerun. Bind and monitor the new attempt. The managed-image workflow supports failed-job
reruns that reuse successful producer artifacts from the same run.

After image classification, read the peeled `lkg` commit. This skill never moves `lkg`. If
production promotion succeeded and `lkg` differs, show the current and proposed releases and ask for
separate maintainer authorization. If the maintainer moves `lkg`, monitor
`.github/workflows/release-lkg-brev-image.yaml` and its returned downstream production-image run.

Send the final response only after:

- all three automatic workflows are terminal and their effects are classified;
- the Announcement draft exists; and
- `lkg` already identifies the release, is ineligible because production promotion failed, awaits
  an explicit maintainer decision, or its authorized downstream production run is classified.

Keep the semver tag immutable.

## Recovery

- Missing release entry in a current-main plan: finish the candidate's documentation work and
  generate a new plan for the resulting commit. A historical plan uses only its plan-bound explicit
  exception.
- Documentation coverage shows a gap, failed checks, unapproved changes, unsupported paths, or an
  open managed docs PR: show that state. Let the maintainer proceed, create or update a docs PR, or
  stop. If documentation work changes the candidate, generate a new plan.
- Required GHCR evidence fails: repair and rerun only the affected image work. Do not replace it
  with the general E2E proceed decision.
- General E2E is old, incomplete, failed, or from another SHA: show it and offer focused, full, or
  proceed. Record the decision and reason in the brief.
- Candidate is no longer on `origin/main`, the previous release changed, or the version is no longer
  available: stop and generate a new plan.
- Signing or access fails: report the exact error and follow the shared hard-stop guidance. Do not
  improvise tag commands.
- A post-tag workflow fails: report that state and its rerun path separately. Do not move the
  already-published semver tag.
