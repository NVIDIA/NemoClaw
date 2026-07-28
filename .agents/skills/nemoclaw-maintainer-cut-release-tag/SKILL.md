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
- Load `nemoclaw-maintainer-e2e` and run full mode if the candidate has no applicable exact Brev Launchable evidence.
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
- [ ] Step 1: Preflight and generate release plan
- [ ] Step 2: Show plan, E2E evidence, and confirmation phrase
- [ ] Step 3: Cut the semver tag from the confirmed plan
- [ ] Step 4: Wait for workflow-managed latest
- [ ] Step 5: Carry open work forward and retire the released label
- [ ] Step 6: Generate release-note data and draft Markdown
- [ ] Step 7: Wait for maintainer-published Announcement
- [ ] Step 8: Verify Announcement and hand off sharing
```

### Step 1: Preflight and Generate Release Plan

Start with one read-only pass that checks these prerequisites together:

- refresh `origin/main` and resolve its full SHA;
- check the target changelog heading and release-prep docs state;
- ask a repository administrator for the authoritative Jetson runner state when that lane is required; and
- inventory existing E2E runs for the same SHA before deciding what to dispatch.

Do not wait for merges to stop. The plan captures one candidate SHA for evidence; a late drift check advances it when `origin/main` moves.
Do not dispatch or poll a workflow during this pass.

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

From a checkout whose `HEAD` is the plan candidate SHA and whose `git status --short` is empty, generate one release E2E preflight:

```bash
CANDIDATE_SHA="<full-plan-sha>"
JETSON_RUNNER_ONLINE="<true-false-or-unknown>"
npm run release:e2e-evidence -- \
  --candidate-sha "$CANDIDATE_SHA" \
  --jetson-runner-online "$JETSON_RUNNER_ONLINE" \
  >"$EVIDENCE_DIR/preflight.json"
```

The preflight derives every required execution and these dispatch groups from the candidate workflow:

- `defaultSuite`: full mode, which includes the default-enabled suite and `Exact staging Brev Launchable`;
- `parallelExplicit`: explicit-only selectors that require neither the protected Launchable E2E job nor runner confirmation; and
- `conditional`: Jetson or another lane that must not queue until its authoritative runner inventory is confirmed online.

First feed applicable existing runs for the candidate SHA into the ledger.
Dispatch only groups that still lack green evidence.
When no applicable exact Brev evidence exists, load `nemoclaw-maintainer-e2e` and dispatch full mode for that SHA.
Require that run to include the default-enabled suite and `Exact staging Brev Launchable`.
Do not substitute a selective `staging-brev-launchable` run for full-mode evidence.

Dispatch `parallelExplicit` immediately alongside the default/full run, with separate correlation IDs.
Do not wait for either run to finish before dispatching the other.

Dispatch a `conditional` lane only when the preflight reports its runner online.
For Jetson, pass `allow_jetson_runner_queue=true` only after that confirmation.
When the runner is false or unknown, do not create a job that can queue indefinitely; reserve its itemized exception.

Monitor all dispatched correlation IDs as one run group.
Use one bounded status query for the group, then collect evidence when the group reaches terminal state.
Do not run a separate polling loop for each workflow.

Before accepting full-mode exact Brev evidence, require:

- the workflow `head_sha` to equal the plan candidate SHA;
- the trusted dispatch receipt to prove empty selectors and `include_staging_brev_launchable=true`;
- the workflow conclusion to be `success`;
- the `Exact staging Brev Launchable` job conclusion to be `success`;
- the job URL and workflow attempt number;
- Launchable E2E identity for the same SHA; and
- cleanup evidence that reports the qualified workspace as `ABSENT`.

Treat a skipped job as missing evidence even when the workflow concludes `success`.
If the plan candidate SHA changes, discard the run and Launchable E2E evidence.
Run full mode again for the new candidate SHA.
No release-note-only delta exception is currently defined.

For every accepted default, explicit, and conditional run, reuse `run-$RUN_ID.json` and `jobs-$RUN_ID.json` returned by `nemoclaw-maintainer-e2e`, and collect the workflow-produced dispatch receipt for that run.
If those files were not returned, collect them once:

```bash
gh api "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID" \
  >"$EVIDENCE_DIR/run-$RUN_ID.json"
gh api --paginate --slurp \
  "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID/jobs?filter=all&per_page=100" \
  >"$EVIDENCE_DIR/jobs-$RUN_ID.json"
ARTIFACT_PAGES="$(gh api --paginate --slurp \
  "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID/artifacts?per_page=100")"
DISPATCH_ARTIFACT_NAME="$(jq -r --arg prefix "e2e-dispatch-$RUN_ID-" \
  '[.[] | .artifacts[] | select(.expired != true and (.name | startswith($prefix)))]
   | sort_by(.created_at) | last | .name // empty' <<<"$ARTIFACT_PAGES")"
test -n "$DISPATCH_ARTIFACT_NAME"
gh run download "$RUN_ID" \
  --repo NVIDIA/NemoClaw \
  --name "$DISPATCH_ARTIFACT_NAME" \
  --dir "$EVIDENCE_DIR/dispatch-$RUN_ID"
```

Use the latest existing receipt artifact, not the run's latest attempt number. A partial rerun can leave `generate-matrix` successful and therefore reuse its earlier receipt; the ledger permits that earlier receipt only when it binds the same run and its attempt does not exceed the run's latest attempt.

Create `manifest.json` in the private evidence directory:

```json
{
  "candidateSha": "<full-plan-sha>",
  "jetsonRunnerOnline": "unknown",
  "runs": [
    {
      "runJson": "run-123.json",
      "jobsJson": "jobs-123.json",
      "dispatchJson": "dispatch-123/dispatch.json"
    },
    {
      "runJson": "run-124.json",
      "jobsJson": "jobs-124.json",
      "dispatchJson": "dispatch-124/dispatch.json"
    }
  ]
}
```

Do not type default-suite claims or selector lists into the manifest. The helper derives them from the workflow-produced receipt and rejects a receipt whose selector fields disagree with its default-suite flag.
Build the ledger with `npm run release:e2e-evidence -- --manifest "$EVIDENCE_DIR/manifest.json"`.
The helper derives the denominator from the workflow, preserves matrix rows as separate semantic identifiers, binds every run and its actual dispatch inputs to the candidate SHA, and keeps an earlier successful attempt green when a later attempt fails.
The manifest and helper cover the workflow-derived test execution ledger only. They do not replace exact Brev Launchable E2E acceptance: keep the raw `dispatch.json`, `launchable-e2e.json`, and `cleanup.json` validation in `nemoclaw-maintainer-e2e`, and carry its validated return beside this ledger or record the required Launchable E2E exception.

Before showing the confirmation prompt, present:

- the candidate SHA;
- the number of tests with green evidence out of the number required by the workflow;
- each required test mapped to a successful run or job URL and attempt; and
- when accepted full-mode exact Brev evidence exists, its workflow URL, `Exact staging Brev Launchable` job URL, attempt, Launchable E2E identity, and cleanup result; and
- a separate itemized maintainer exception for each test without successful evidence, including its test identifier, run links, current result, and rationale; and
- a separate itemized maintainer exception for missing or invalid exact Brev Launchable E2E evidence, including run and job URLs, the current result or missing receipt, and rationale.

Do not ask for the phrase until each test and the exact Brev Launchable E2E job has successful evidence or its own itemized maintainer exception.
Immediately before asking, refresh `origin/main` once and compare its full SHA with the plan. If it moved, discard all prior candidate-bound evidence, regenerate the plan, rerun preflight and every required default, explicit, conditional, and exact Brev Launchable E2E group for the new SHA, capture a new manifest, and rebuild the ledger before requesting confirmation; merges did not need to stop while the earlier evidence ran.

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
- Full-mode E2E waits for protected-environment approval: keep the run pending until a maintainer approves or rejects the job.
- Full-mode E2E ran for another SHA or skipped `Exact staging Brev Launchable`: reject the run and dispatch full mode for the plan candidate SHA.
- Launchable E2E or cleanup evidence is missing or invalid: reject the run. Do not infer Launchable E2E success from the workflow conclusion.
- `origin/main` moved after plan generation: regenerate the plan and ask for the new confirmation phrase.
- Remote semver tag already exists: stop; do not retag unless the maintainer explicitly starts protected-tag remediation.
- `latest` workflow fails or times out: report the workflow/status; do not move `latest` manually.
- `latest` workflow rejects a rollback: keep `latest` unchanged, inspect the plan target commit, and regenerate the plan for the current `origin/main` tip if appropriate.
- `lkg` changed: stop and escalate to a release admin.
- Post-tag housekeeping fails: report the workflow error and list items still carrying the released label. After the failure is fixed, rerun `release-latest-tag.yaml` with `<released-version>` through `workflow_dispatch`; the promotion and retirement steps are idempotent, already-moved items no longer match the source label, and an already-deleted released label is treated as success. Do not run the retirement script outside the workflow.
- Announcement is not published yet: keep Step 7 in progress and return the draft path and suggested title; the tag and housekeeping remain complete.
- Announcement title, category, body, or links are wrong: ask the maintainer to edit the existing Discussion, then verify the same URL again. Do not create a replacement. After three failed verification attempts for the same Discussion, stop and escalate to a release admin.
- Announcement cannot be inspected: report the read failure and ask the maintainer to confirm access or provide a public URL; do not mark Step 8 complete.
