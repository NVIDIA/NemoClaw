---
name: nemoclaw-maintainer-cut-release-tag
description: Creates deterministic NemoClaw semver release tags on origin/main after verifying the pre-tag dated changelog entry, handles release housekeeping, drafts announcement release notes, and verifies the maintainer-published Announcement. Use when cutting a release, tagging a version, shipping a build, creating vX.Y.Z tags, publishing release announcements, or completing release communication.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cut Release Tag

Use the release scripts for normal release operations. Do not run raw `git tag`, `git push`, `gh api`, or version-bump commands by hand for the normal release flow.

The release is one signed annotated semver tag on an already-merged `origin/main` commit. The GitHub workflow requires that tag to be GitHub-Verified, points `latest` at the exact verified tag object, carries remaining open issues/PRs to the next patch label, and deletes the released label while holding the shared release-label coordination queue; release admins promote `lkg` manually after validation. After the workflow is verified, draft release notes, then verify the maintainer-published Announcement before final handoff.

## LKG Production Image Dispatch

When a release admin creates or moves `lkg` to a commit carrying a `vX.Y.Z` tag, the `Release / LKG Brev Image` workflow dispatches the `Release Production Image` workflow in `brevdev/nemoclaw-image` on its `main` branch.
The dispatch passes the immutable semver tag instead of the mutable `lkg` tag.
The source workflow requires the `NEMOCLAW_IMAGE_DISPATCH_TOKEN` Actions secret with Actions read/write access to `brevdev/nemoclaw-image`; a missing secret fails before the API request, and the workflow summary never includes its value.
The trigger summary records the selected release tag, full commit SHA, target workflow, dispatch result, downstream run ID, and a direct link to the downstream run.
After `lkg` promotion, find and wait for the source trigger run using the promoted commit:

```bash
gh run list --repo NVIDIA/NemoClaw --workflow release-lkg-brev-image.yaml --commit <lkg-commit> --event push --limit 1 --json databaseId,status,conclusion,url
gh run watch <source-run-id> --repo NVIDIA/NemoClaw --exit-status
gh run view <source-run-id> --repo NVIDIA/NemoClaw --log
```

Extract the exact `https://github.com/brevdev/nemoclaw-image/actions/runs/<run-id>` URL printed by the source run, give that link to the maintainer immediately, and tell them to follow it to terminal success.
Treat dispatch acceptance as an intermediate state, not proof of production image promotion: the downstream run must succeed and its summary must show successful runtime E2E validation and promotion of the `nemoclaw-brev-cpu` image family.
A rejected dispatch fails the trigger run but does not move or roll back `lkg`.
Deleting `lkg` does not dispatch an image build.
The downstream scheduled reconciliation remains available if the event-driven dispatch fails or is delayed.

## Hard Rules

- Tag only the commit captured in a generated release plan.
- Do not generate the release plan until the release-prep docs PR containing `docs/changelog/YYYY-MM-DD.mdx` and the exact planned `## vX.Y.Z` heading is merged or explicitly waived.
- Treat the dated MDX entry as the canonical release history. A conventional Release Notes page or post-tag Announcement draft cannot replace it.
- If `origin/main` changes after plan generation, regenerate the plan before cutting the tag.
- Before asking for release confirmation, satisfy the canonical [pre-tag E2E evidence policy](../nemoclaw-maintainer-policies/references/release-train.md#pre-tag-e2e-evidence) for that commit.
- Ask the maintainer to paste the confirmation phrase from the plan before cutting the tag.
- Push only the semver tag (`vX.Y.Z`) from the agent-controlled step.
- Never push `latest` or `lkg` from this skill.
- Never move, delete, or force-push an existing remote semver tag unless the maintainer explicitly starts protected-tag remediation.
- Delete the released version label only after open work moves forward and a final query finds no open stragglers. Never rename or reuse a released label.
- Keep label retirement inside the `release-latest-tag` workflow so it cannot overlap the post-merge labeler. Do not run the retirement script directly.
- Draft release notes locally. Do not create the GitHub Discussion; the maintainer does that.
- Do not mark the announcement step complete until the maintainer provides a valid Discussion URL and the published Announcement is verified.
- Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md) for SSH, authentication, remote access, authorization, or permission failures.

## Workflow

Copy this checklist and update it as you proceed:

```text
Release Progress:
- [ ] Step 1: Generate release plan
- [ ] Step 2: Show plan, E2E evidence, and confirmation phrase
- [ ] Step 3: Cut the semver tag from the confirmed plan
- [ ] Step 4: Wait for workflow-managed latest
- [ ] Step 5: Carry open work forward and retire the released label
- [ ] Step 6: Generate release-note data and draft Markdown
- [ ] Step 7: Wait for maintainer-published Announcement
- [ ] Step 8: Verify Announcement and hand off sharing
```

### Step 1: Generate Release Plan

Before this step, confirm release-prep docs are merged or explicitly waived.
Return to `nemoclaw-maintainer-evening` if docs are still pending.

For the planned version, inspect `origin/main` before generating the plan:

```bash
git grep -n '^## vX\.Y\.Z$' origin/main -- 'docs/changelog/*.mdx'
```

Require exactly one match in a dated file directly under `docs/changelog/`.
Confirm that a newly created file begins with the parser-safe MDX SPDX comment and that the entry contains its summary and detailed bullets.
If the entry is missing or malformed, return to `nemoclaw-contributor-update-docs`; do not substitute the post-tag announcement workflow.
If the maintainer explicitly waives the entry, preserve the reason in the release-plan presentation and confirmation handoff.

Run one of:

```bash
npm run release:plan -- --bump patch
npm run release:plan -- --bump minor
npm run release:plan -- --bump major
```

Patch is the default if the maintainer says "yes", "go", or similar without choosing.

The script writes a plan outside the checkout root, for example:

```text
../nemoclaw-release-v0.0.58/plan.json
```

### Step 2: Show Plan, E2E Evidence, and Ask for Confirmation

Read the generated `plan.json` and show the maintainer:

- previous tag,
- next tag,
- target `origin/main` commit and headline,
- plan hash,
- forbidden operations,
- confirmation phrase,
- open issue/PR housekeeping plan for the release label, including deletion of the released label after carry-forward succeeds.

Unless Step 1 records an explicit waiver, verify that the plan's next tag matches the H2 version heading in the dated changelog entry at the candidate SHA.
When the entry is waived, show the recorded waiver reason in the plan presentation and confirmation handoff instead.

For the plan's full `origin/main` SHA, review `.github/workflows/e2e.yaml` at that commit and build the evidence ledger required by the canonical [pre-tag E2E evidence policy](../nemoclaw-maintainer-policies/references/release-train.md#pre-tag-e2e-evidence). The workflow is the sole source of truth; do not substitute or maintain a separate release-gating test list.

Before showing the confirmation prompt, present:

- the candidate SHA;
- the number of tests with green evidence out of the number required by the workflow;
- each required test mapped to a successful run or job URL and attempt; and
- an itemized maintainer exception for every test without green evidence, including its current result or failure summary and the rationale for proceeding.

Do not ask for the phrase until every test has green evidence or an explicit itemized maintainer exception. If `origin/main` moves or the candidate SHA otherwise changes, regenerate the plan and rebuild the ledger for the new SHA.

Ask the maintainer to paste this phrase:

```text
CONFIRM RELEASE vX.Y.Z <full-origin-main-sha>
```

Do not proceed on a generic "yes" at this step.

### Step 3: Cut the Semver Tag

Run the cut script with the plan and the maintainer's phrase:

```bash
npm run release:cut -- --plan <plan.json> --confirm "CONFIRM RELEASE vX.Y.Z <full-origin-main-sha>"
```

The script verifies a clean worktree, unchanged `origin/main`, tag availability, target reachability, and remote peeled tag state, then creates and pushes the signed annotated tag using the configured signing key. It writes:

```text
<release-dir>/cut-result.json
```

If the script fails because of SSH, authentication, remote access, authorization, or permissions, follow [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md). For other precondition failures, report the failed precondition and use the recovery guidance below. Do not improvise git commands.

### Step 4: Wait for Workflow-Managed `latest`

Run:

```bash
npm run release:wait-latest -- --plan <plan.json>
```

The script waits until `vX.Y.Z` and `latest` reference the same tag object, verifies both peel to the planned commit, and verifies `lkg` did not change from the plan. It writes:

```text
<release-dir>/latest-result.json
```

If it fails, report the failed workflow/status. Do not manually move `latest`.

### Step 5: Verify Carry-Forward and Label Retirement

The `release-latest-tag` workflow continues after moving `latest`: it moves every remaining open issue or PR carrying the released version to the next patch label, verifies none remain, and deletes the released label. The workflow and post-merge labeler share one queued concurrency group, so assignment cannot overlap the verification-and-delete window.

Find the workflow run started by Step 3 and wait for it to finish:

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

This automatic post-tag housekeeping is covered by the release plan and confirmation in Step 2. Do not run `scripts/retire-release-label.mts` directly; doing so would bypass the coordination boundary.

Then verify the released version label no longer exists:

```bash
gh label list --repo NVIDIA/NemoClaw --search <released-version> --json name \
  --jq '.[] | select(.name == "<released-version>")'
```

The command must return no output. Never rename the released label into a future version; a future target must be a separately created label with its own GitHub identity.

Summarize:

- open issues/PRs moved to `<next-version>`;
- released label deleted;
- any items that need manual maintainer attention.

### Step 6: Generate Release-Note Data and Draft Markdown

Collect deterministic release-note input:

```bash
npm run release:notes-data -- --plan <plan.json>
```

This writes:

```text
<release-dir>/notes-data.json
```

If `notes-data.json` has `status: "partial"` or non-empty `pullRequestWarnings`, report the warnings and ask the maintainer whether to fetch/fill the missing PR metadata before drafting.

Load and follow `nemoclaw-maintainer-release-notes`, then use its output as the draft. Save only Markdown, outside the checkout root:

```text
<release-dir>/release-note-draft.md
```

Before continuing to Step 7, verify the draft has three lead paragraphs, categorized shipped changes, one what-changed-and-why-it-matters bullet with a visible `#NNNN` link for every included change, and thanks for external contributors only.

Do not create or update a GitHub Discussion.
Do not edit `docs/changelog/` in this post-tag step; the canonical entry must already be present in the tagged commit.

### Step 7: Wait for Maintainer-Published Announcement

Return:

- release tag,
- confirmed release commit,
- plan path and plan hash,
- `cut-result.json`, `latest-result.json`, and `notes-data.json` paths,
- Markdown draft path,
- issue/PR housekeeping summary,
- suggested discussion title: `NemoClaw <new-version> is out`.

Ask the maintainer to publish the draft in the `Announcements` Discussion category and return the resulting Discussion URL. Do not create or update the Discussion. Keep Step 7 in progress until the maintainer provides the URL.

### Step 8: Verify Announcement and Hand Off Sharing

Before making any network request, reject the maintainer-provided URL unless it matches `https://github.com/NVIDIA/NemoClaw/discussions/<positive-integer>` with no query string or fragment. Only then open it using a read-only GitHub or web capability and verify:

- the title is `NemoClaw <new-version> is out`;
- the category is `Announcements`;
- the body preserves the draft's three lead paragraphs, category headings, every included PR link, comparison URL, and external contributor usernames; formatting-only edits are acceptable;
- the comparison link targets `<previous-version>...<new-version>` and visible PR links target `github.com/NVIDIA/NemoClaw/pull/<number>`.

If the Announcement is valid, return its URL with the release artifacts and mark the release workflow complete. Remind the maintainer to share that Discussion URL in the appropriate external channels. Do not create a duplicate Announcement.

## Recovery

- Plan generation fails: fix the named precondition, then regenerate the plan.
- Planned changelog entry is missing or malformed: stop before plan generation and run the pre-tag `nemoclaw-contributor-update-docs` workflow. Use post-release recovery only when the tag already exists.
- `origin/main` moved after plan generation: regenerate the plan and ask for the new confirmation phrase.
- Remote semver tag already exists: stop; do not retag unless the maintainer explicitly starts protected-tag remediation.
- `latest` workflow fails or times out: report the workflow/status; do not move `latest` manually.
- `latest` workflow rejects a rollback: keep `latest` unchanged, inspect the plan target commit, and regenerate the plan for the current `origin/main` tip if appropriate.
- `lkg` changed: stop and escalate to a release admin.
- Post-tag housekeeping fails: report the workflow error and list items still carrying the released label. After the failure is fixed, rerun `release-latest-tag.yaml` with `<released-version>` through `workflow_dispatch`; the promotion and retirement steps are idempotent, already-moved items no longer match the source label, and an already-deleted released label is treated as success. Do not run the retirement script outside the workflow.
- Announcement is not published yet: keep Step 7 in progress and return the draft path and suggested title; the tag and housekeeping remain complete.
- Announcement title, category, body, or links are wrong: ask the maintainer to edit the existing Discussion, then verify the same URL again. Do not create a replacement. After three failed verification attempts for the same Discussion, stop and escalate to a release admin.
- Announcement cannot be inspected: report the read failure and ask the maintainer to confirm access or provide a public URL; do not mark Step 8 complete.
