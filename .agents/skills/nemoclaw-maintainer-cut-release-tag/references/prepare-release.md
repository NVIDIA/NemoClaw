<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Prepare the Release

## 1. Generate the Plan and Brief Template

Start the [kickoff checks](candidate-evidence.md#start-independent-checks-at-kickoff) before generating the plan.
These preliminary reads do not select a candidate or initialize candidate evidence.
Inspect general E2E context early and continue authorized docs preparation during image waits.

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
- range from the previous commit through the candidate; and
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

Create the brief template now, before collecting candidate-bound evidence, so each result can be
recorded as it is read:

```bash
node --no-warnings \
  .agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary.ts \
  --plan ../nemoclaw-release-vX.Y.Z/plan.json \
  --output ../nemoclaw-release-vX.Y.Z/release-brief.md
```

The helper refuses to overwrite an existing brief. Fill this generated file in place; do not rerun
the helper after evidence has been added.

## 2. Verify Required Candidate Evidence

Read and follow [Candidate Evidence](candidate-evidence.md). It owns the executable reads
for the release entry, documentation coverage, and applicable base-image verifier.

Show the complete documentation coverage evidence. Offer the maintainer the three choices defined
there. If the maintainer requests documentation work or stops, do not continue to E2E or tag
confirmation. If the maintainer proceeds, record the decision line in the release brief.

Do not offer the general E2E proceed option until the release entry and image checks pass and the
maintainer chooses to proceed with the displayed documentation coverage. Record the returned paths,
URLs, PR state, commit ranges, review state, check state, and image identities in the release brief.

## 3. Present General E2E and Ask for a Decision

Follow [Report the Release Context](../../nemoclaw-maintainer-e2e/SKILL.md#report-the-release-context)
to inspect the newest completed or active full run. Present its release context for the candidate.

Offer exactly these three choices:

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

## 4. Finish and Review the Release Brief

Replace every `TODO_RELEASE_BRIEF` prompt in that Markdown file with:

- the complete canonical release entry and its repository path for a current-main plan, or the
  plan-bound historical release-entry exception;
- the latest included cumulative docs PR, coverage commit, later commits and PRs, changed-path
  result, review and check state, open managed docs PRs, and maintainer decision;
- candidate E2E workflow, attempt, and successful `base-image-publication` job URL;
- the newest full E2E result and every focused or full rerun result, including SHA, time, age, status,
  conclusion, and URLs;
- the maintainer's E2E choice; and
- a final `Exceptions: None` line or `Exceptions: <plain-language reason>` line.

Keep the helper's compact range counts and QA focus. Do not duplicate every commit or risky file;
the canonical release entry and compare range already preserve that detail.

Do not put secrets in the brief. Show the complete rendered file to the maintainer. Because this
public Markdown becomes the signed tag annotation, make any correction in the file before
asking for confirmation.
