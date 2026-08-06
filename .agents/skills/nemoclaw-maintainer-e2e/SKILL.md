---
name: nemoclaw-maintainer-e2e
description: Dispatches and verifies trusted advisory GitHub Actions E2E for NemoClaw maintainers, including exact-revision manual PR E2E and per-main-push overnight diagnosis. Use for requests such as run E2E for PR #123, run the E2E suite, diagnose post-merge E2E, selectively rerun failures, or validate a release candidate without gating its tag.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Maintainer E2E

Use `.github/workflows/e2e.yaml` from trusted `main`.
Do not substitute local `npm run test:live-e2e` unless the maintainer explicitly requests local execution.

## Manual PR E2E

Use this mode when the maintainer requests live E2E for a pull request.
It runs either the default suite or the protected managed-image runtime qualification against the current exact PR head while the workflow definition remains on `main`.
It is advisory and does not create a required PR check.

The default suite exposes these values to candidate-controlled job processes:

- Long-lived API keys from repository secrets: `NVIDIA_INFERENCE_API_KEY`, `NVIDIA_API_KEY`, and `BRAVE_API_KEY`.
- Long-lived messaging credentials from repository secrets: `TELEGRAM_BOT_TOKEN_REAL`, `DISCORD_BOT_TOKEN_REAL`, `SLACK_BOT_TOKEN_REAL`, and `SLACK_APP_TOKEN_REAL`.
- The job-scoped `GITHUB_TOKEN` in the `token-rotation` and `openshell-gateway-upgrade` jobs. It has `checks: read`, `contents: read`, and `pull-requests: read` access. Candidate code can use it while either job runs. GitHub Actions invalidates it after the job.
- Messaging account and channel identifiers from repository secrets: `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_AUTHORIZED_CHAT_IDS`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CHAT_ID_E2E`, `DISCORD_CHANNEL_ID_E2E`, and `SLACK_CHANNEL_ID_E2E`.

The workflow does not rotate or revoke these API keys or messaging credentials. To remove later access, rotate or revoke every listed credential in the external service that issued it. The workflow cannot erase identifiers copied by candidate code. Review the complete candidate diff before dispatch.
Live targets can create external resources.
After a failure, inspect the artifacts and remove resources that target cleanup did not remove.

For `managed-image-protected-runtime`, the workflow supplies the long-lived `NVIDIA_API_KEY` repository secret only to the trusted qualification step. Trusted host code uses it for NGC login and passes it as `NGC_API_KEY` and `NIM_NGC_API_KEY` to the temporary NIM container. Candidate managed sandboxes receive generated local route tokens instead of this key. The live fixture attempts to stop and remove `nemoclaw-managed-image-nim-e2e`, but Docker stop or removal errors do not fail the test. A surviving container can retain the API key until runner teardown. The final workflow step removes the job's isolated Docker credential directory and fails if that removal does not complete. The workflow does not revoke the NVIDIA API key. Rotate or revoke it in the issuing NVIDIA service to remove later access.

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

Choose exactly one mode:

- For the default suite, leave `E2E_JOBS` empty.
- For protected managed-image runtime qualification, set `E2E_JOBS=managed-image-protected-runtime`. The exact candidate must contain `ci/protected-managed-image-multiarch-activation-v1.json` and `ci/protected-managed-image-runtime-activation-v1.json`.

Leave `targets` empty and keep Launchable disabled:

```bash
E2E_JOBS="${E2E_JOBS:-}"
case "$E2E_JOBS" in
  "" | managed-image-protected-runtime) ;;
  *) echo "Unsupported manual PR E2E job selector" >&2; exit 1 ;;
esac
REVIEW_REASON='Reviewed the exact PR revision for credentialed live E2E.'
CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f "jobs=${E2E_JOBS}" \
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

The trusted pre-checkout step requires current `maintain` or `admin` permission and validates the open PR, repository, head SHA, base SHA, workflow SHA, review reason, and selected mode.
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
| “diagnose post-merge E2E” | Main-push inspection | n/a | n/a |
| “run release-candidate E2E” | Full | empty | `true` |

A generic E2E request must not authorize the Brev Launchable path.
Do not infer full mode from words such as “all” or “complete.”
Ask for clarification only when the request contains conflicting mode phrases.

Ordinary mode runs the default-enabled GitHub Actions suite.
Launchable mode runs only `Exact staging Brev Launchable`.
Full mode runs the default-enabled suite and `Exact staging Brev Launchable` in the same workflow run.

## Inspect the Edition's Main-Push Runs

For overnight diagnosis, start from the trusted frozen plan. Every push to `main` already starts its own immutable E2E run, so do not dispatch a duplicate full run merely to begin the overnight loop:

```bash
export PLAN_PATH=/path/to/downloaded-release-edition-plan/plan.json
FROZEN_CANDIDATE_SHA="$(node -p "require(process.env.PLAN_PATH).candidateCommit")"
export EDITION_CUTOFF_AT="$(node -p "require(process.env.PLAN_PATH).authorization.cutoffAt")"
CUTOFF_SECONDS="$(node -p "Date.parse(process.env.EDITION_CUTOFF_AT) / 1000")"
WINDOW_START_SECONDS="$((CUTOFF_SECONDS - 8 * 60 * 60))"
RUNS="$(gh run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
  --event push --branch main --limit 200 \
  --json databaseId,createdAt,headSha,status,conclusion,url)"
MATCHES="$(jq -c --argjson start "$WINDOW_START_SECONDS" --argjson end "$CUTOFF_SECONDS" \
  '[.[] | select((.createdAt | fromdateiso8601) >= $start and
                 (.createdAt | fromdateiso8601) <= $end)] | sort_by(.createdAt)' <<<"$RUNS")"
jq -e 'length >= 1' <<<"$MATCHES" >/dev/null
jq -e 'all(.[]; (.headSha // "") | test("^[0-9a-f]{40}$"))' <<<"$MATCHES" >/dev/null
```

The inventory covers the 8:00 AM–4:00 PM merge window ending at the plan's exact cutoff. More than one run is expected. Fetch `origin/main` and require every selected `headSha` to be an ancestor of `FROZEN_CANDIDATE_SHA`; exclude and report any unrelated run instead of silently treating it as edition evidence. If a merge's push run is not visible yet, report it as pending and poll. Do not silently substitute full mode.

Each run is keyed to its own `headSha`; a later push does not cancel an earlier main-push run. `.github/workflows/e2e-main-retry.yaml` may rerun failed jobs from a non-superseded main-push run up to two times. Keep the source run ID, attempt, SHA, job conclusion, artifacts, and retry evidence together. The tag remains bound only to the frozen plan.

Watch and inspect each selected run even when it fails:

```bash
gh run watch "<run-id>" --repo NVIDIA/NemoClaw
gh run view "<run-id>" --repo NVIDIA/NemoClaw \
  --json status,conclusion,headSha,jobs,url
gh run view "<run-id>" --repo NVIDIA/NemoClaw --log-failed
```

Classify failures before choosing selective reruns. Dispatch full mode only for an explicit full or release-candidate rerun request.

## Operate the Overnight Loop

For the frozen edition, keep one agent session active from 4:00 PM through the 8:00 AM handoff. Do not start competing agents over the same failure set. Repeat this sequence until the handoff boundary:

1. inspect newly completed main-push, automatic-retry, or selective E2E jobs and exact-SHA post-merge advisor findings;
2. choose the highest-impact unresolved failure that is not already owned by a prepared fix;
3. classify it as a product regression, flaky test, infrastructure failure, or stale test;
4. prepare the smallest focused fix or justified test cleanup and run its deterministic checks;
5. open or update a fix PR without merging it during the freeze;
6. dispatch only the selective rerun needed to test the diagnosis; and
7. update the shared handoff state, then immediately choose the next actionable item.

Do not wait idly for an unrelated rerun when another unresolved failure can be diagnosed. Continue across the 4:00 AM tag without changing the frozen candidate or treating the tag as E2E success. At 8:00 AM, stop the loop and hand over every unresolved failure, rerun, and prepared PR. If the active agent cannot continue before then, transfer the same state to one replacement agent.

## Resolve the Candidate

Run from a trusted NemoClaw checkout:

```bash
gh auth status
git fetch --prune origin main
CANDIDATE_SHA="$(git rev-parse origin/main)"
```

For a frozen-edition request, read `FROZEN_CANDIDATE_SHA` from the generated release plan and compare it with `CANDIDATE_SHA`, which is the current trusted `origin/main` dispatch ref. When they match, the rerun is also bound to the frozen candidate. If `main` advanced after the cutoff, keep the plan frozen and describe new dispatches as current-main or next-edition validation; the current direct-main workflow does not dispatch an older ancestor. Do not use manual PR checkout inputs to bypass that boundary.

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
A Launchable-mode run is not full-mode evidence.
A missing, mismatched, or failed cleanup receipt is not evidence.

## Bind Advisory Evidence

If no release plan exists, label a successful full run against `origin/main` as advisory E2E evidence.
Return:

- candidate SHA;
- workflow run URL and conclusion;
- `Exact staging Brev Launchable` job URL;
- workflow attempt number;
- Launchable E2E identity; and
- cleanup result.

Bind every result to the tested SHA. For the frozen edition, classify failures and prepare fixes for the next merge window.
Return the trusted dispatch, test, Launchable, and cleanup receipts needed for diagnosis.
Never treat success as tag authorization or failure as a reason to delay the 4 AM tag.

## Access Failures

Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).
Stop on authentication, authorization, remote-access, or permission failures.
