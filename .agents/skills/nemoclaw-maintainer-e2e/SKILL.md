---
name: nemoclaw-maintainer-e2e
description: Dispatches and verifies trusted GitHub Actions E2E for NemoClaw maintainers, including exact-revision manual PR E2E. Use for requests such as run E2E for PR #123, run the E2E suite, run the Launchable E2E, run the full E2E suite, deploy pre-release full E2E, run pre-tag full E2E, or run release-candidate E2E.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Maintainer E2E

Use `.github/workflows/e2e.yaml` from trusted `main`.
Do not substitute local `npm run test:live-e2e` unless the maintainer explicitly requests local execution.

## Manual PR E2E

Use this mode when the maintainer requests live E2E for a pull request.
It runs the default suite against the current exact PR head while the workflow definition remains on `main`.
It is advisory and does not create a required PR check.

The default suite exposes these values to candidate-controlled job processes:

- Long-lived API keys from repository secrets: `NVIDIA_INFERENCE_API_KEY`, `NVIDIA_API_KEY`, and `BRAVE_API_KEY`.
- Long-lived messaging credentials from repository secrets: `TELEGRAM_BOT_TOKEN_REAL`, `DISCORD_BOT_TOKEN_REAL`, `SLACK_BOT_TOKEN_REAL`, and `SLACK_APP_TOKEN_REAL`.
- The job-scoped `GITHUB_TOKEN` in the `token-rotation` and `openshell-gateway-upgrade` jobs. It has `checks: read`, `contents: read`, and `pull-requests: read` access. Candidate code can use it while either job runs. GitHub Actions invalidates it after the job.
- Messaging account and channel identifiers from repository secrets: `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_AUTHORIZED_CHAT_IDS`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CHAT_ID_E2E`, `DISCORD_CHANNEL_ID_E2E`, and `SLACK_CHANNEL_ID_E2E`.

The workflow does not rotate or revoke these API keys or messaging credentials. To remove later access, rotate or revoke every listed credential in the external service that issued it. The workflow cannot erase identifiers copied by candidate code. Review the complete candidate diff before dispatch.
Live targets can create external resources.
After a failure, inspect the artifacts and remove resources that target cleanup did not remove.

Resolve the current PR and trusted workflow identities:

```bash
set -euo pipefail
PR_NUMBER=123
git fetch --prune origin main
WORKFLOW_SHA="$(git rev-parse origin/main)"
PR_JSON="$(gh pr view "$PR_NUMBER" --repo NVIDIA/NemoClaw \
  --json number,state,headRefOid,baseRefOid,headRepository)"
test "$(jq -r .state <<<"$PR_JSON")" = OPEN
HEAD_SHA="$(jq -r .headRefOid <<<"$PR_JSON")"
BASE_SHA="$(jq -r .baseRefOid <<<"$PR_JSON")"
HEAD_REPOSITORY="$(jq -r .headRepository.nameWithOwner <<<"$PR_JSON")"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]
```

Require a review reason containing 10 to 500 printable characters.
Leave `jobs` and `targets` empty and keep Launchable disabled:

```bash
REVIEW_REASON='Reviewed the exact PR revision for credentialed live E2E.'
CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs= \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f "pr_number=${PR_NUMBER}" \
  -f "checkout_sha=${HEAD_SHA}" \
  -f "checkout_repository=${HEAD_REPOSITORY}" \
  -f "base_sha=${BASE_SHA}" \
  -f "workflow_sha=${WORKFLOW_SHA}" \
  -f "review_reason=${REVIEW_REASON}" \
  -f "correlation_id=${CORRELATION_ID}"
```

The trusted pre-checkout step requires current `maintain` or `admin` permission and validates the open PR, repository, head SHA, base SHA, workflow SHA, review reason, and empty selectors.
A second validation after checkout rejects a changed PR identity before preparation.

Find and verify the correlated run with bounded GitHub reads:

```bash
RUN_TITLE="E2E PR #${PR_NUMBER} (${CORRELATION_ID})"
MATCHES='[]'
for POLL_INDEX in $(seq 1 30); do
  RUNS="$(gh run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
    --event workflow_dispatch --branch main --limit 50 \
    --json databaseId,displayTitle,url)"
  MATCHES="$(jq -c --arg title "$RUN_TITLE" \
    '[.[] | select(.displayTitle == $title)]' <<<"$RUNS")"
  test "$(jq 'length' <<<"$MATCHES")" -le 1
  test "$(jq 'length' <<<"$MATCHES")" -eq 0 || break
  sleep 10
done
if test "$(jq 'length' <<<"$MATCHES")" -ne 1; then
  echo 'The dispatched run was not visible after bounded polling. Do not dispatch again. Inspect the E2E Actions runs for the recorded correlation ID and clean up any resources from a matching run.' >&2
  exit 1
fi
RUN_ID="$(jq -r '.[0].databaseId' <<<"$MATCHES")
RUN_URL="$(jq -r '.[0].url' <<<"$MATCHES")"
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw --exit-status
RUN_JSON="$(gh api "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}")"
jq -e --arg sha "$WORKFLOW_SHA" '
  .run_attempt == 1 and
  .head_sha == $sha and
  .status == "completed" and
  .conclusion == "success"
' <<<"$RUN_JSON" >/dev/null
CURRENT_PR="$(gh pr view "$PR_NUMBER" --repo NVIDIA/NemoClaw \
  --json state,headRefOid,baseRefOid,headRepository)"
test "$(jq -r .state <<<"$CURRENT_PR")" = OPEN
test "$(jq -r .headRefOid <<<"$CURRENT_PR")" = "$HEAD_SHA"
test "$(jq -r .baseRefOid <<<"$CURRENT_PR")" = "$BASE_SHA"
test "$(jq -r .headRepository.nameWithOwner <<<"$CURRENT_PR")" = "$HEAD_REPOSITORY"
```

Return the PR number, head repository, head SHA, base SHA, workflow SHA, correlation ID, workflow URL, and result.
A changed head repository, head SHA, or base SHA invalidates the evidence and requires a new run.

## Select the Main Mode

| Request | Mode | `jobs` | `include_staging_brev_launchable` |
|---|---|---|---|
| “Run the E2E suite” | Ordinary | empty | `false` |
| “Run the Launchable E2E” | Launchable | `staging-brev-launchable` | `false` |
| “Run the full E2E suite” | Full | empty | `true` |
| “deploy pre-release full E2E” | Full | empty | `true` |
| “run pre-tag full E2E” | Full | empty | `true` |
| “run release-candidate E2E” | Full | empty | `true` |

A generic E2E request must not authorize the Brev Launchable path.
Do not infer full mode from words such as “all” or “complete.”
Ask for clarification only when the request contains conflicting mode phrases.

Ordinary mode runs the default-enabled GitHub Actions suite.
Launchable mode runs only `Exact staging Brev Launchable`.
Full mode runs the default-enabled suite and `Exact staging Brev Launchable` in the same workflow run.

## Resolve the Candidate

Run from a trusted NemoClaw checkout:

```bash
gh auth status
git fetch --prune origin main
CANDIDATE_SHA="$(git rev-parse origin/main)"
```

For a pre-tag request, use the full candidate SHA from the generated release plan.
Require that SHA to equal `origin/main` before dispatch.
Stop and regenerate the release plan when they differ.

Record `CANDIDATE_SHA` for every dispatch.
Do not use a relative revision in the evidence report.

## Dispatch One Trusted Run

Generate a unique correlation ID:

```bash
CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
```

For ordinary mode:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs= \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f "correlation_id=${CORRELATION_ID}"
```

For Launchable mode:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs=staging-brev-launchable \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f "correlation_id=${CORRELATION_ID}"
```

For full mode:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs= \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=true \
  -f "correlation_id=${CORRELATION_ID}"
```

Do not set `jobs=staging-brev-launchable` for full mode.
Empty `jobs` and `targets` select the default suite.
The boolean input adds the Launchable E2E job to that same run.
The trusted `main` workflow verifies that the dispatching and rerunning actors have
repository `maintain` or `admin` permission before the Launchable path's source
checkout. That role check is the authorization.
Launchable and full runs do not require separate environment approval.

### Release Coverage Dispatch Group

Use this subsection only when `nemoclaw-maintainer-cut-release-tag` supplies a release E2E preflight.
It coordinates independent workflow runs; it does not change the meaning of ordinary or full mode above.

Read `dispatches` from the preflight.
Create a different correlation ID for each run.
Dispatch the `defaultSuite` run first, using ordinary or full mode exactly as reported.
Without waiting for it, dispatch the non-empty `parallelExplicit.jobs` value:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f "jobs=${EXPLICIT_JOBS}" \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f "correlation_id=${EXPLICIT_CORRELATION_ID}"
```

Do not add `staging-brev-launchable` to that selector list.
Do not dispatch a conditional Jetson lane unless the authoritative repository runner inventory was confirmed online.
After that confirmation, use a separate run and opt into queueing explicitly:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs=jetson-nvmap-gpu \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f allow_jetson_runner_queue=true \
  -f "correlation_id=${JETSON_CORRELATION_ID}"
```

Find all correlation IDs with one bounded `gh run list` query.
Require exactly one run per correlation ID and the candidate SHA on every match.
Dispatch the whole group before watching any member; do not serialize independent runs.
Watch the group with batched status snapshots and collect results after all members are terminal.

Find the run by its unique title:

```bash
RUN_TITLE="E2E main (${CORRELATION_ID})"
for POLL_INDEX in $(seq 1 30); do
  RUNS="$(gh run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
    --event workflow_dispatch --branch main --limit 50 \
    --json databaseId,displayTitle,headSha,status,url)"
  MATCHES="$(jq -c --arg title "$RUN_TITLE" \
    '[.[] | select(.displayTitle == $title)]' <<<"$RUNS")"
  [ "$(jq 'length' <<<"$MATCHES")" -le 1 ] || {
    echo "Correlation matched more than one E2E run" >&2
    exit 1
  }
  RUN_ID="$(jq -r '.[0].databaseId // empty' <<<"$MATCHES")"
  [ -z "$RUN_ID" ] || break
  sleep 10
done
test -n "${RUN_ID:-}"
RUN_SHA="$(jq -r '.[0].headSha' <<<"$MATCHES")"
test "$RUN_SHA" = "$CANDIDATE_SHA"
```

Reject a run for another SHA.
Do not reuse it as evidence.

Wait for completion:

```bash
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw --exit-status
```

Launchable and full modes can wait in the non-cancelling Launchable concurrency queue.
Queued, waiting, or accepted dispatch state is not success.

## Verify the Result

Create a private temporary evidence directory:

```bash
EVIDENCE_DIR="$(mktemp -d)"
chmod 700 "$EVIDENCE_DIR"
trap 'rm -rf "$EVIDENCE_DIR"' EXIT
gh api "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID" >"$EVIDENCE_DIR/run-$RUN_ID.json"
gh api "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID/jobs?filter=latest&per_page=100" \
  >"$EVIDENCE_DIR/jobs-latest-$RUN_ID.json"
```

For a release coverage group, also collect every attempt for the matrix-preserving ledger:

```bash
gh api --paginate --slurp \
  "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID/jobs?filter=all&per_page=100" \
  >"$EVIDENCE_DIR/jobs-$RUN_ID.json"
```

Reuse `run-$RUN_ID.json` and `jobs-$RUN_ID.json` as the `nemoclaw-maintainer-cut-release-tag` manifest inputs.
Do not fetch the same run again.
`jobs-latest-$RUN_ID.json` is only the validator input for the latest full-mode attempt.

For ordinary and Launchable modes, require `run-$RUN_ID.json` to report:

- `head_sha` equal to `CANDIDATE_SHA`;
- `status` equal to `completed`; and
- `conclusion` equal to `success`.

For Launchable mode, also require `jobs-latest-$RUN_ID.json` to contain one completed, successful
`Exact staging Brev Launchable` job. Return the workflow and job URLs.

For full mode, download the Launchable E2E evidence:

```bash
gh run download "$RUN_ID" --repo NVIDIA/NemoClaw \
  --name "staging-brev-launchable-${CANDIDATE_SHA}-${RUN_ID}" \
  --dir "$EVIDENCE_DIR"
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-e2e/scripts/validate-full-e2e-evidence.mts \
  --candidate-sha "$CANDIDATE_SHA" \
  --run-json "$EVIDENCE_DIR/run-$RUN_ID.json" \
  --jobs-json "$EVIDENCE_DIR/jobs-latest-$RUN_ID.json" \
  --dispatch-json "$EVIDENCE_DIR/dispatch.json" \
  --launchable-e2e-json "$EVIDENCE_DIR/launchable-e2e.json" \
  --cleanup-json "$EVIDENCE_DIR/cleanup.json"
```

The validator requires:

- the workflow run to succeed for the selected SHA;
- `dispatch.json` to bind the run and attempt to empty selectors and `include_staging_brev_launchable=true`;
- `Exact staging Brev Launchable` to conclude `success` in the reported attempt;
- `launchable-e2e.json` to identify the selected SHA in the repository and provision records;
- the booted repository to be unmodified;
- the in-guest full E2E to pass; and
- `cleanup.json` to report the same workspace as `ABSENT`.

A skipped, cancelled, queued, or failed Launchable E2E job is not evidence.
A Launchable-mode run is not full-mode or pre-tag release evidence.
A missing, mismatched, or failed cleanup receipt is not evidence.

## Bind Release Evidence

If no release plan exists, label a successful full run against `origin/main` as provisional release evidence.
Return:

- candidate SHA;
- workflow run URL and conclusion;
- `Exact staging Brev Launchable` job URL;
- workflow attempt number;
- Launchable E2E identity; and
- cleanup result.

If the release candidate SHA changes, discard the earlier run group and rerun every required release coverage group for the new SHA.
No release-note-only delta exception is currently defined.

When `nemoclaw-maintainer-cut-release-tag` invokes this skill, return the validated fields for its pre-tag E2E evidence ledger.
The trusted `dispatch.json` receipt proves that full mode selected the default suite.
The release evidence ledger proves the result of each default-suite execution.
Do not ask for the release confirmation phrase in this skill.

## Access Failures

Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).
Stop on authentication, authorization, remote-access, or permission failures.
