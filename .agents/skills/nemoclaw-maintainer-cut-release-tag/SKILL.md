---
name: nemoclaw-maintainer-cut-release-tag
description: Prepares and cuts NemoClaw's semi-automatic daily release tag after verifying release-prep docs and housekeeping, then drafts announcement release notes and verifies the maintainer-published Announcement. Use when cutting a release, tagging a version, shipping a build, creating vX.Y.Z tags, or completing release communication.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cut Release Tag

At 4 PM America/Los_Angeles, prepare and cut the daily release with an authorized maintainer. This is semi-automatic: the agent verifies that the dated changelog PR is merged, reviews the release plan and housekeeping, exercises the maintainer's local signer, and asks for the exact confirmation phrase before pushing the tag.

Every push to `main` separately starts the complete E2E workflow. Treat those results as asynchronous regression evidence: from 4 PM through 8 AM, keep merging normally while agents consolidate failures, remove redundant coverage, and fix broken or flaky E2Es. E2E does not select, delay, cancel, or authorize the daily tag.

Use the release scripts for release operations. Do not run raw `git tag`, `git push`, `gh api`, or version-bump commands by hand for the normal release flow.

## Hard Rules

- Do not generate the release plan until the release-prep docs PR containing `docs/changelog/YYYY-MM-DD.mdx` and the exact planned `## vX.Y.Z` heading is merged or a maintainer explicitly waives it.
- Tag only the `origin/main` commit captured by the generated release plan. If `origin/main` moves before the cut, regenerate the plan and request its new confirmation phrase; do not stop merging.
- Do not consult E2E state before cutting the tag.
- Ask the maintainer to paste the exact confirmation phrase from the plan before cutting the tag.
- Sign on the maintainer's workstation with its configured OpenPGP, SSH, or X.509 signer. Never put the release signing key in a GitHub Actions secret or use a release bot to sign tags.
- Push only one new signed annotated semver tag. The tag must become GitHub-Verified.
- Never move, delete, or force-push an existing remote semver tag unless a maintainer explicitly starts protected-tag remediation.
- Never push `latest` or `lkg` from this skill. Let `release-latest-tag` move `latest`; release admins promote `lkg` after validation.
- Delete the released version label only after open work moves forward and a final query finds no open stragglers. Never rename or reuse a released label.
- Keep label retirement inside the `release-latest-tag` workflow. Do not run the retirement script directly.
- Draft release notes locally. Do not create the GitHub Discussion; the maintainer publishes it.
- Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md) for access or permission failures.

## Workflow

### Step 1: Verify release prep and generate the plan

Refresh `origin/main`. Confirm the release-prep docs PR is merged and require exactly one dated changelog file with the planned version heading:

```bash
git grep -n '^## vX\.Y\.Z$' origin/main -- 'docs/changelog/*.mdx'
```

Unless Step 1 records an explicit waiver, require the plan's next tag to match that dated changelog heading. When waived, show the recorded waiver reason in the plan presentation. A conventional Release Notes page or post-tag Announcement draft cannot replace the dated changelog.

Generate the requested plan:

```bash
npm run release:plan -- --bump patch
npm run release:plan -- --bump minor
npm run release:plan -- --bump major
```

Patch is the default daily bump. Show the previous tag, next tag, target commit, plan hash, forbidden operations, carry-forward plan, label-retirement plan, and confirmation phrase. Do not show or request E2E evidence.

### Step 2: Verify local signing and request confirmation

Run:

```bash
npm run release:cut -- --plan <plan.json> --preflight-only
```

This exercises the maintainer workstation's configured signer without publishing a ref. Require status 0, then ask the maintainer to paste the exact phrase from the plan:

```text
CONFIRM RELEASE vX.Y.Z <full-origin-main-sha>
```

Do not proceed on a generic confirmation.

### Step 3: Cut the signed tag

Run:

```bash
npm run release:cut -- --plan <plan.json> --confirm "CONFIRM RELEASE vX.Y.Z <full-origin-main-sha>"
```

The script verifies the plan hash, clean worktree, unchanged `origin/main`, target reachability, tag availability, local signer, and remote peeled state before writing `cut-result.json`. If `origin/main` moved, regenerate the plan and ask for its new phrase. This refresh does not freeze or gate merging.

### Step 4: Verify `latest` and housekeeping

Run `npm run release:wait-latest -- --plan <plan.json>`. Require the semver tag and `latest` to reference the same tag object and peel to the planned commit. Verify `lkg` did not move.

Find exactly one `release-latest-tag` push run for the release commit and wait for it:

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

- Dated changelog is missing: merge the release-prep docs entry, then regenerate the plan. Record an explicit maintainer waiver only when directed.
- `origin/main` moved after plan generation: regenerate the plan and request its new confirmation phrase.
- Latest remote semver changed: regenerate the plan; never race or overwrite the existing tag.
- Signing preflight fails: repair the maintainer workstation's configured signer. Do not move the signing key into GitHub Actions.
- Tag push fails: follow the Git and GitHub access hard stop; do not improvise another signer or remote.
- `latest` or label retirement fails: rerun `release-latest-tag.yaml` for the immutable semver tag. Do not move `latest` or retire labels by hand.
- E2E fails: leave the tag in place and continue the asynchronous stabilization loop.
- `lkg` changes unexpectedly: stop and escalate to a release admin.
- Announcement is not published: return the draft and keep announcement verification pending.
