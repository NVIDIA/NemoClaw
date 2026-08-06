---
name: nemoclaw-maintainer-cut-release-tag
description: Runs or verifies NemoClaw's nonblocking daily release tag, preserves the manual recovery path, handles release housekeeping, drafts announcement release notes, and verifies the maintainer-published Announcement. Use when cutting or checking a release, tagging a version, shipping a build, creating vX.Y.Z tags, or completing release communication.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cut Release Tag

The normal release path is the scheduled `Release / Daily Tag` workflow. At 4 PM America/Los_Angeles it tags the current `main` commit with the next patch version. It does this regardless of E2E state. Merges continue before, during, and after the tag.

Every push to `main` separately starts the complete E2E workflow. Treat those results as asynchronous regression evidence: from 4 PM through 8 AM, keep merging normally while agents consolidate failures, delete redundant coverage, and fix broken or flaky E2Es. E2E does not select, delay, cancel, or authorize the daily tag.

Use the release scripts for release operations. Do not run raw `git tag`, `git push`, `gh api`, or version-bump commands by hand for the normal release flow.

## Hard Rules

- Let `.github/workflows/release-daily-tag.yaml` own the normal 4 PM tag.
- Tag the current trusted `main` commit captured by the scheduled release plan. A later merge belongs to the next release and does not cancel the current cut.
- Do not consult E2E state before cutting the scheduled tag.
- Require exactly one direct `docs/changelog/YYYY-MM-DD.mdx` file with the exact planned `## vX.Y.Z` heading. A maintainer may explicitly waive this only through the manual recovery flow.
- Push only one new signed annotated semver tag. The tag must become GitHub-Verified.
- Never move, delete, or force-push an existing remote semver tag unless a maintainer explicitly starts protected-tag remediation.
- Never push `latest` or `lkg` from this skill. Let `release-latest-tag` move `latest`; release admins promote `lkg` after validation.
- Delete the released version label only after open work moves forward and a final query finds no open stragglers. Never rename or reuse a released label.
- Keep label retirement inside the `release-latest-tag` workflow. Do not run the retirement script directly.
- Draft release notes locally. Do not create the GitHub Discussion; the maintainer publishes it.
- Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md) for access or permission failures.

## Scheduled Release

The workflow runs both UTC cron values needed for daylight and standard time, then selects only the invocation corresponding to 4 PM in `America/Los_Angeles`.

The `release-tag` environment must provide:

- secret `NEMOCLAW_RELEASE_TAG_SIGNING_KEY` containing the SSH private key for a GitHub-verified release signer;
- variable `NEMOCLAW_RELEASE_TAG_SIGNER_NAME`; and
- variable `NEMOCLAW_RELEASE_TAG_SIGNER_EMAIL`.

The scheduled job:

1. checks out trusted `main` with full history;
2. generates the next patch release plan for the current `origin/main`;
3. skips the release when there are no commits after the previous semver tag;
4. verifies the exact dated changelog heading;
5. invokes `scripts/release-cut-tag.sh --scheduled` in the restricted GitHub Actions context;
6. preserves the plan and cut receipt as a workflow artifact; and
7. calls `release-latest-tag` directly so `latest` and version-label housekeeping run even though a tag pushed with `GITHUB_TOKEN` does not start another workflow.

Inspect the scheduled run and report its tag, target commit, artifact, and `release-latest-tag` result. A failed E2E run is not a release failure; route it into overnight stabilization.

## Manual Recovery

Use this path only when the scheduled workflow fails or a maintainer explicitly requests a non-patch release or changelog waiver.

### Step 1: Generate and inspect the plan

Refresh `origin/main`, verify the dated changelog, and run one of:

```bash
git grep -n '^## vX\.Y\.Z$' origin/main -- 'docs/changelog/*.mdx'
npm run release:plan -- --bump patch
npm run release:plan -- --bump minor
npm run release:plan -- --bump major
```

Unless Step 1 records an explicit waiver, require the plan's next tag to match exactly one dated changelog heading. When waived, show the recorded waiver reason. A conventional Release Notes page or post-tag Announcement draft cannot replace the canonical dated changelog entry.

Show the previous tag, next tag, target commit, plan hash, forbidden operations, carry-forward plan, and confirmation phrase. Do not show or request E2E evidence.

### Step 2: Verify signing and request confirmation

Run:

```bash
npm run release:cut -- --plan <plan.json> --preflight-only
```

This exercises the configured OpenPGP, SSH, or X.509 signer without publishing a ref. Then ask the maintainer to paste the exact phrase from the plan:

```text
CONFIRM RELEASE vX.Y.Z <full-origin-main-sha>
```

Do not proceed on a generic confirmation.

### Step 3: Cut the manual tag

Run:

```bash
npm run release:cut -- --plan <plan.json> --confirm "CONFIRM RELEASE vX.Y.Z <full-origin-main-sha>"
```

Manual mode requires `origin/main` to remain at the planned commit. If it moves, regenerate the plan and request the new phrase. The script verifies the plan hash, current latest semver tag, target reachability, tag availability, signer, and remote peeled state before writing `cut-result.json`.

### Step 4: Verify `latest` and housekeeping

Run `npm run release:wait-latest -- --plan <plan.json>`. Require the semver tag and `latest` to reference the same tag object and peel to the planned commit. Verify `lkg` did not move.

For a manually pushed tag, find exactly one promotion run:

```bash
RELEASE_SHA="<full-origin-main-sha>"
mapfile -t RELEASE_RUN_IDS < <(
  gh run list --repo NVIDIA/NemoClaw --workflow release-latest-tag.yaml --limit 20 \
    --event push --commit "$RELEASE_SHA" --json databaseId --jq '.[].databaseId'
)
if (( ${#RELEASE_RUN_IDS[@]} != 1 )); then
  echo "Expected exactly one release-latest-tag push run for $RELEASE_SHA" >&2
  exit 1
fi
gh run watch "${RELEASE_RUN_IDS[0]}" --repo NVIDIA/NemoClaw --exit-status
```

Confirm open items moved to the next patch label, no open item retains the released label, and the released label was deleted.

## Release Notes and Announcement

Run `npm run release:notes-data -- --plan <plan.json>`, then load `nemoclaw-maintainer-release-notes`. Save the Markdown draft outside the checkout. Do not edit `docs/changelog/` after tagging and do not publish the Discussion.

Ask the maintainer to publish the draft in the `Announcements` category with title `NemoClaw vX.Y.Z is out` and return its URL. Accept only `https://github.com/NVIDIA/NemoClaw/discussions/<positive-integer>` without a query or fragment. Verify the title, category, compare link, PR links, contributor names, and substantive draft content before completing the handoff.

## LKG Production Image Dispatch

When a release admin creates or moves `lkg` to a commit carrying a semver tag, `Release / LKG Brev Image` dispatches `Release Production Image` in `brevdev/nemoclaw-image`. Treat dispatch acceptance as intermediate; verify the downstream run succeeds, runtime E2E validation passes, and the `nemoclaw-brev-cpu` image family is promoted. A rejected dispatch does not move or roll back `lkg`.

## Recovery

- Scheduled tag fails: report the failing precondition or workflow step; do not wait for E2E before retrying.
- Dated changelog is missing: merge the release-prep docs entry, then use manual recovery. Record an explicit maintainer waiver only when directed.
- No commits exist after the last semver tag: accept the scheduled no-op; do not create an empty release.
- Latest remote semver changed after plan generation: regenerate the plan; never race or overwrite the existing tag.
- Signing fails: repair the `release-tag` environment signer, then rerun the workflow or manual preflight.
- `latest` or label retirement fails: rerun `release-latest-tag.yaml` for the immutable semver tag. Do not move `latest` or retire labels by hand.
- E2E fails: leave the tag in place and continue the asynchronous stabilization loop.
- `lkg` changes unexpectedly: stop and escalate to a release admin.
- Announcement is not published: return the draft and keep announcement verification pending.
