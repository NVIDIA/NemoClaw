---
name: nemoclaw-maintainer-cut-release-tag
description: Operates NemoClaw's frozen daily release edition, including the scheduled 4 PM candidate plan, the 4 AM signed semver tag for a non-empty edition regardless of E2E state, workflow-managed latest and release-label housekeeping, manual recovery, release-note data, and Announcement handoff. Use when closing an edition, cutting or recovering a release tag, verifying latest, or explaining the daily release timeline.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cut a NemoClaw Release Tag

Use the canonical repository `NVIDIA/NemoClaw`. Read the maintainer policy
[release train](../nemoclaw-maintainer-policies/references/release-train.md) before a release operation.

## Daily Contract

Use `America/Los_Angeles` for every boundary:

| Time | Contract |
|---|---|
| 8:00 AM–4:00 PM | Merge reviewed PRs. Each `main` advance asynchronously dispatches an agent review for its exact SHA range and selects every workflow E2E. |
| 4:00 PM | Stop merging. `.github/workflows/release-edition-close.yaml` freezes the latest GitHub-recorded `main` push at or before the cutoff. |
| 4:00 PM–4:00 AM | Consume the E2E runs already triggered by the edition's `main` pushes; diagnose, rerun selectively, or prepare fix PRs. Do not merge during the freeze. |
| 4:00 AM | `.github/workflows/release-edition-cut.yaml` tags the frozen candidate regardless of E2E state. |
| 4:00 AM–8:00 AM | Continue advisory E2E work and prepare next-edition fixes. |
| 8:00 AM | Hand off state to the next release doula and reopen merging. |

A merge after 4:00 PM belongs to the next edition. Never regenerate or advance the frozen candidate merely because `main` moved.

## Authority and Invariants

- E2E is advisory. Never inspect E2E state to authorize, delay, cancel, or select the tag.
- Keep the required deterministic `checks` aggregate, including `npm run test:smoke` and installer integration, as the PR merge floor while live E2E runs asynchronously after merge.
- Require exactly one direct `docs/changelog/*.mdx` entry with the exact `## vX.Y.Z` heading at a non-empty candidate. No changelog waiver exists.
- Require the frozen candidate to remain an ancestor of `origin/main` and the planned previous tag to remain the newest remote semver tag.
- Treat trusted workflow-run and artifact provenance, plan consistency, tag collision checks, signing, GitHub verification, `latest`, `lkg`, carry-forward, and label retirement as fail-closed controls.
- Skip the edition without creating a tag when the frozen candidate contains no commits after the latest semver tag.
- Never move `lkg`; only a release admin may do that through a separate operation.
- Never create or update a GitHub Discussion. A maintainer publishes the Announcement.

## Normal Scheduled Path

### 1. Prepare Before 4 PM

Run `/nemoclaw-contributor-update-docs for vX.Y.Z` early enough for its dated changelog PR to merge before cutoff. Confirm the exact heading at the intended candidate:

```bash
git grep -n -E '^## vX\.Y\.Z$' origin/main -- ':(glob)docs/changelog/*.mdx'
```

The output must contain exactly one match from a direct child of `docs/changelog/`.

### 2. Close the Edition at 4 PM

The scheduled close workflow:

1. derives the edition date in `America/Los_Angeles`;
2. resolves the latest `post-merge-agent-review.yaml` push run that GitHub recorded at or before exactly 4:00 PM;
3. validates ancestry, version progression, tag absence, and the changelog entry;
4. writes a schema-v2 plan with a SHA-256 consistency hash; and
5. uploads `release-edition-plan-YYYY-MM-DD` for three days.

If a merge creates its `main` push run after 4:00 PM, the cutoff selection excludes it even when the close workflow starts late.

### 3. Use the Freeze for Advisory Validation

Assign one agent to the complete 4:00 PM–8:00 AM loop. Load `nemoclaw-maintainer-e2e` to inventory every immutable E2E run triggered by an edition `main` push, including every selected workflow E2E, its automatic retry evidence, and any selective reruns. Classify failures as product regressions, flaky tests, infrastructure failures, or stale tests. After each result, immediately select the next actionable failure, rerun, or prepared fix. Prepare and validate fix PRs, but do not merge them until 8:00 AM. Keep the loop running after the 4:00 AM tag; stop only at handoff or transfer the same state to a replacement agent.

Keep this state for the morning handoff:

- frozen candidate SHA and next tag;
- exact-SHA post-merge agent-review runs;
- E2E failures, classifications, reruns, and prepared fix PRs;
- unresolved release risks; and
- cut, `latest`, housekeeping, and release-note artifact URLs.

Do not put internal E2E classifications or rerun details in the public Announcement.

### 4. Cut at 4 AM

The scheduled cut workflow selects the successful scheduled close artifact for the previous edition date. It validates the artifact-to-edition binding and invokes:

```bash
scripts/release-cut-tag.sh --plan <plan.json> --scheduled
```

The script accepts unattended authority only when all of these values match:

- `GITHUB_ACTIONS=true`;
- `GITHUB_REPOSITORY=NVIDIA/NemoClaw`;
- `GITHUB_EVENT_NAME=schedule`; and
- `GITHUB_WORKFLOW_REF=NVIDIA/NemoClaw/.github/workflows/release-edition-cut.yaml@refs/heads/main`.

The `release-tag` GitHub environment must provide:

- secret `NEMOCLAW_RELEASE_TAG_SIGNING_KEY`, containing only the dedicated SSH private signing key;
- variable `NEMOCLAW_RELEASE_TAG_SIGNER_NAME`; and
- variable `NEMOCLAW_RELEASE_TAG_SIGNER_EMAIL`.

Register the corresponding public key as a signing key on the dedicated GitHub release identity. Restrict the environment to `main` and do not add a human approval wait: the schedule is the release authority. `GITHUB_TOKEN` pushes the tag; the signing key never authenticates a network request.

The workflow writes the private key to a mode-`0600` file under `RUNNER_TEMP` only for the cut job. The always-run step deletes that file during normal and cancellation cleanup; disposal of the ephemeral GitHub-hosted runner is the fallback if abrupt runner loss prevents the step from executing. GitHub supplies `GITHUB_TOKEN` only to the job, limits it to the declared `actions: read` and `contents: write` permissions, and expires it when the job finishes.

Because a tag pushed with `GITHUB_TOKEN` does not emit a second workflow run, the cut workflow directly calls `release-latest-tag.yaml`. That reusable workflow verifies the exact signed annotated tag object through GitHub, moves `latest`, carries open items to the next patch label, verifies none remain, and deletes the released label.

### 5. Verify and Hand Off at 8 AM

Require the cut workflow's handoff artifact to contain:

- `plan.json` and its plan hash;
- `cut-result.json` with `tagged` or `no-changes`;
- `latest-result.json` for a tagged edition; and
- `notes-data.json` for a tagged edition.

Report failed non-E2E controls immediately. Report E2E state separately as advisory next-edition work. Load `nemoclaw-maintainer-release-notes` to draft Markdown, then ask the maintainer to publish it in the `Announcements` Discussion category and return the URL for read-only verification.

## Manual Preflight and Recovery

A manual dispatch of `release-edition-cut.yaml` accepts an `edition_date` and downloads the trusted close artifact. For a ready edition it performs signing preflight only; for a `no-changes` edition it records that no tag is needed. It cannot publish a tag.

For local recovery of the already frozen edition, download its trusted plan artifact, inspect its SHA, edition date, plan hash, changelog entry, and operations, then run:

```bash
scripts/release-cut-tag.sh --plan <plan.json> --preflight-only
scripts/release-cut-tag.sh \
  --plan <plan.json> \
  --confirm 'CONFIRM RELEASE vX.Y.Z <full-frozen-sha>'
```

Confirmed local recovery may cut a scheduled plan whose candidate is behind current `origin/main`; ancestry must still hold. A newly generated maintainer plan remains bound to the current `origin/main` tip and becomes stale if `main` moves.

After a locally authenticated tag push, wait for the tag-triggered `release-latest-tag.yaml` run and verify:

```bash
scripts/release-wait-latest.sh --plan <plan.json>
node --experimental-strip-types --no-warnings scripts/release-notes-data.mts --plan <plan.json>
```

If tag push, GitHub verification, `latest`, signing, changelog, ancestry, collision, or housekeeping fails, stop and report the exact invariant. Do not retag, move `latest`, retire labels directly, or use E2E state as a workaround.
