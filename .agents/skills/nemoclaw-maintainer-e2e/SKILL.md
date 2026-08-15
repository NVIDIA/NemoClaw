---
name: nemoclaw-maintainer-e2e
description: Dispatches and verifies trusted GitHub Actions E2E for NemoClaw maintainers, including manual PR E2E for the current PR head commit. Use for requests such as run E2E for PR #123, run the E2E suite, run the Launchable E2E, run the full E2E suite, deploy pre-release full E2E, run pre-tag full E2E, or run release-candidate E2E.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Maintainer E2E

Use `.github/workflows/e2e.yaml` from trusted `main`.
Each push to `main` selects catalogue targets and retained workflow jobs that own changed files.
Each trusted push also selects the CPU-only `jetson-nvmap-gpu` proof.
Push runs skip `llama-cpp-dgx-spark-plan` and `llama-cpp-dgx-spark-qualification` because push events cannot set the required workflow dispatch flag.
Manual Jetson runs remain opt-in through `allow_jetson_dispatch`, which defaults to `false`.
Push runs publish `Relevant E2E` and do not publish `Release qualification`.
Only the full `workflow_dispatch` mode, with or without an administrator-authorized job waiver, publishes `Release qualification`.
Do not substitute local `npm run test:live-e2e` unless the maintainer explicitly requests local execution.

## Manual PR E2E

Use this mode when the maintainer requests E2E for a pull request.
It runs an authorized E2E selection against the current PR head commit while the workflow definition remains on `main`.
It is advisory and does not create a required PR check.

An empty-selector manual run exposes these values to candidate-controlled job processes:

- Long-lived API keys from repository secrets: `NVIDIA_INFERENCE_API_KEY`, `NVIDIA_API_KEY`, and `BRAVE_API_KEY`.
- Long-lived messaging credentials from repository secrets: `TELEGRAM_BOT_TOKEN_REAL`, `DISCORD_BOT_TOKEN_REAL`, `SLACK_BOT_TOKEN_REAL`, and `SLACK_APP_TOKEN_REAL`.
- The job-scoped `GITHUB_TOKEN` in the `token-rotation` and `openshell-gateway-upgrade` jobs. It has `checks: read`, `contents: read`, and `pull-requests: read` access. Candidate code can use it while either job runs. GitHub Actions invalidates it after the job.
- Messaging account and channel identifiers from repository secrets: `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_AUTHORIZED_CHAT_IDS`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CHAT_ID_E2E`, `DISCORD_CHANNEL_ID_E2E`, and `SLACK_CHANNEL_ID_E2E`.

The workflow does not rotate or revoke these API keys or messaging credentials. To remove later access, rotate or revoke every listed credential in the external service that issued it. The workflow cannot erase identifiers copied by candidate code. Review the complete candidate diff before dispatch.
Live targets can create external resources.
After a failure, inspect the artifacts and remove resources that target cleanup did not remove.

`Exact staging Brev Launchable` reads these credentials from repository Actions secrets:

- `BREV_API_KEY` authenticates the Brev CLI for workspace operations in the organization identified by `BREV_ORG_ID`.
- `NEMOCLAW_IMAGE_DISPATCH_TOKEN` is exposed as `GH_TOKEN` only to the trusted host script. It grants Actions read/write access to `brevdev/nemoclaw-image`, which the script uses to dispatch the image workflow, inspect its run, and download its handoff artifact.
- `NVIDIA_INFERENCE_API_KEY` is exported into the Brev guest for the full E2E process. Code in the baked candidate checkout can read and use it.

These credentials remain valid until they expire or an administrator revokes them in their issuing services. If cleanup fails, remove the recorded Brev workspace. Rotate or revoke each credential to remove later access.
This Brev credential boundary applies only to trusted Launchable or full manual dispatches against `main`. It does not apply to `main` pushes or manual PR runs.

For `managed-image-protected-runtime`, the workflow supplies the long-lived `NVIDIA_API_KEY` repository secret only to the trusted qualification step. Trusted host code uses it for NGC login and passes it as `NGC_API_KEY` and `NIM_NGC_API_KEY` to the temporary NIM container. Candidate managed sandboxes receive generated local route tokens instead of this key. The live fixture removes the temporary NIM container only if its exact ID, name, requested image, immutable image ID, cohort owner, and provider kind match the recorded authority. The test fails if evidence is missing or ambiguous, a name is reused, authority drifts, removal is indeterminate, or the exact ID or name remains. A cleanup refusal can leave the container and its API key in place until runner teardown. The final workflow step removes the job's isolated Docker credential directory and fails if that removal does not complete. The workflow does not revoke the NVIDIA API key. Revoke it, or rotate it and disable the old value, in the issuing NVIDIA service. Verify that the exposed key is no longer valid.

Resolve the current PR and trusted workflow identities:

```bash
set -euo pipefail
PR_NUMBER=123
git fetch --prune origin main
WORKFLOW_SHA="$(git rev-parse origin/main)"
PR_JSON="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$PR_JSON")" = open
HEAD_SHA="$(jq -r .head.sha <<<"$PR_JSON")"
BASE_SHA="$(jq -r .base.sha <<<"$PR_JSON")"
HEAD_REPOSITORY="$(jq -r .head.repo.full_name <<<"$PR_JSON")"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]
```

Require a review reason containing 10 to 500 printable characters.

Choose exactly one mode:

- For a PR revision run, leave `E2E_JOBS` empty. The run selects:
  - every default-selected free-standing workflow E2E except `Exact staging Brev Launchable`;
  - every shared credential-free test; and
  - these controller-selected registry targets: `ubuntu-policy-custom-missing-presets-negative`, `ubuntu-repo-cloud-langchain-deepagents-code`, `ubuntu-repo-cloud-openclaw`, and `ubuntu-repo-docker-post-reboot-recovery`.
  The run skips `jetson-nvmap-gpu` unless `allow_jetson_dispatch` is `true`.
  It skips `llama-cpp-dgx-spark-plan` and `llama-cpp-dgx-spark-qualification` unless their runner-queue flag is `true`.
- For protected managed-image runtime qualification, set `E2E_JOBS=managed-image-protected-runtime`. The exact candidate must contain `ci/protected-managed-image-multiarch-activation-v1.json` and `ci/protected-managed-image-runtime-activation-v1.json`.

Leave `targets` empty and keep Launchable disabled:

```bash
E2E_JOBS="${E2E_JOBS:-}"
case "$E2E_JOBS" in
  "" | managed-image-protected-runtime) ;;
  *) echo "Unsupported manual PR E2E job selector" >&2; exit 1 ;;
esac
REVIEW_REASON='Reviewed the PR head commit for credentialed E2E.'
CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
INFERENCE_MODE=mock
ALLOW_JETSON_DISPATCH=false
ALLOW_DGX_SPARK_RUNNER_QUEUE=false
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f "jobs=${E2E_JOBS}" \
  -f "inference_mode=${INFERENCE_MODE}" \
  -f include_staging_brev_launchable=false \
  -f "allow_jetson_dispatch=${ALLOW_JETSON_DISPATCH}" \
  -f "allow_dgx_spark_runner_queue=${ALLOW_DGX_SPARK_RUNNER_QUEUE}" \
  -f "pr_number=${PR_NUMBER}" \
  -f "checkout_sha=${HEAD_SHA}" \
  -f "checkout_repository=${HEAD_REPOSITORY}" \
  -f "base_sha=${BASE_SHA}" \
  -f "workflow_sha=${WORKFLOW_SHA}" \
  -f "review_reason=${REVIEW_REASON}" \
  -f "correlation_id=${CORRELATION_ID}"
```

The trusted pre-checkout step requires current `maintain` or `admin` permission.
It validates the actor, open PR, repository, head SHA, base SHA, workflow SHA, review reason, and allowed jobs, targets, and Launchable combination.
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
CURRENT_PR="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$CURRENT_PR")" = open
test "$(jq -r .head.sha <<<"$CURRENT_PR")" = "$HEAD_SHA"
test "$(jq -r .base.sha <<<"$CURRENT_PR")" = "$BASE_SHA"
test "$(jq -r .head.repo.full_name <<<"$CURRENT_PR")" = "$HEAD_REPOSITORY"
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
| “run pre-tag E2E with an administrator job waiver” | Administrator-waived full | empty | `true` |

A generic E2E request must not authorize the Brev Launchable path.
Do not infer full mode from words such as “all” or “complete.”
Ask for clarification only when the request contains conflicting mode phrases.

Ordinary mode selects every default-selected workflow E2E except `Exact staging Brev Launchable`.
Launchable mode runs only `Exact staging Brev Launchable`.
Full mode adds `Exact staging Brev Launchable` to the default E2E selection in the same workflow run.
Administrator-waived full mode runs the full suite but omits the approved execution jobs from release qualification.
Every waived job still runs.
Use this mode only when a repository administrator explicitly authorizes the job IDs and supplies the reason.
The documented invocations for all four modes keep the Jetson dispatch and DGX Spark runner-queue flags set to `false`.

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
  -f allow_jetson_dispatch=false \
  -f allow_dgx_spark_runner_queue=false \
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
  -f allow_jetson_dispatch=false \
  -f allow_dgx_spark_runner_queue=false \
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
  -f allow_jetson_dispatch=false \
  -f allow_dgx_spark_runner_queue=false \
  -f "correlation_id=${CORRELATION_ID}"
```

For administrator-waived full mode, set the approved job IDs and a reason.
The reason must begin with an ASCII letter or digit and contain 10-500 characters chosen from ASCII letters, digits, spaces, and `.,:;/_()'-`.

```bash
RELEASE_QUALIFICATION_WAIVED_JOBS='staging-brev-launchable'
RELEASE_QUALIFICATION_WAIVER_REASON='Repository administrator waived Brev qualification while a Brev administrator replaces an expired credential.'
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs= \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=true \
  -f "release_qualification_waived_jobs=${RELEASE_QUALIFICATION_WAIVED_JOBS}" \
  -f "release_qualification_waiver_reason=${RELEASE_QUALIFICATION_WAIVER_REASON}" \
  -f allow_jetson_dispatch=false \
  -f allow_dgx_spark_runner_queue=false \
  -f "correlation_id=${CORRELATION_ID}"
```

Do not set `jobs=staging-brev-launchable` for full mode.
Empty `jobs` and `targets` select every default-selected workflow E2E except `Exact staging Brev Launchable`.
The `include_staging_brev_launchable` input adds the Launchable E2E job to that same run.
The trusted `main` workflow verifies that the dispatching and rerunning actors have
repository `maintain` or `admin` permission before the Launchable path's source
checkout. That role check is the authorization.
For administrator-waived full mode, both `github.actor` and `github.triggering_actor` must have repository `admin` permission.
Both waiver inputs must be nonempty, or both inputs must be empty.
The trusted planner validates the comma-separated IDs against the release-required E2E execution jobs.
It rejects unknown, duplicate, and non-release-required IDs.
Trusted controller jobs cannot be waived.
The planner removes only the approved IDs from `release_required_jobs` and emits canonical waived-job JSON.
The `generate-matrix` dispatch receipt is written after waiver authorization and before that job's source checkout.
It records the requested job IDs, reason, both actor identities, and candidate SHA.
After trusted planner validation, the `Release qualification` summary and waiver artifact record the canonical job IDs and each waived job's completed outcome.
A user permitted to dispatch this workflow may set `allow_jetson_dispatch=true`
to add `jetson-nvmap-gpu` to an empty-selector manual run or enable its explicit
selection. Set it only after the operator-owned service is available and
compatible with HTTP contract
version `1.0.0`, and `JETSON_DISPATCH_URL` contains its verified HTTPS origin.
See [Jetson Dispatch Controller](../../../test/e2e/docs/jetson-dispatch.md).
Require the uploaded Jetson receipt to report `cleanup: "succeeded"`.
A permitted dispatcher may set `allow_dgx_spark_runner_queue=true` to add
`llama-cpp-dgx-spark-plan` and `llama-cpp-dgx-spark-qualification` to an
empty-selector manual run or enable explicit qualification selection. Set it
only after a repository administrator confirms an online DGX Spark runner in
the authoritative runner inventory.
If GitHub pauses the qualification job for the `approve-dgx-spark-image-qualification` environment, an authorized environment reviewer must approve it before qualification starts.
`Exact staging Brev Launchable` does not require environment approval.

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
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw
```

Launchable and full modes can wait in the non-cancelling Launchable concurrency queue.
Queued, waiting, or accepted dispatch state is not success.
Classify the completed workflow and `Release qualification` job with the checks below.

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

Require `run-$RUN_ID.json` to report:

- `head_sha` equal to `CANDIDATE_SHA`;
- `status` equal to `completed`.

For ordinary, Launchable, and unwaived full modes, require `conclusion` equal to `success`.
For administrator-waived full mode, permit `conclusion` equal to `success` or `failure`.
A `failure` conclusion is acceptable only when one completed, successful `Release qualification` job and a valid exact-run waiver artifact with at least one canonical waived job failure both exist.

For Launchable mode, also require `jobs-latest-$RUN_ID.json` to contain one completed, successful
`Exact staging Brev Launchable` job. Return the workflow and job URLs.

For a full run, with or without a job waiver, require `jobs-latest-$RUN_ID.json` to contain one completed, successful
`Release qualification` job. Return its job URL with the workflow URL.
In full mode, that job waits for every default-required E2E result, including `Exact staging Brev Launchable`.
The Launchable job directly verifies the candidate checkout, in-guest full E2E result, and workspace cleanup before it succeeds.
Its `launchable-e2e.json`, `full-e2e.log`, and `cleanup.json` artifacts remain available for diagnosis.
A skipped, cancelled, queued, or failed `Release qualification` job is not evidence.
A Launchable-only run is not full-mode or pre-tag release evidence.

For administrator-waived full mode, the job waits for every unwaived release-required result.
A waived execution job may fail without failing `Release qualification`.
For a failed workflow, require the waiver artifact to bind at least one canonical waived job failure to the candidate SHA, run ID and attempt, actors, and reason.
Return the canonical waived-job IDs, their outcomes, reason, both actor identities, and candidate SHA with the workflow and job URLs.

## Bind Release Evidence

If no release plan exists, label a full run with a successful `Release qualification` job against `origin/main` as provisional release evidence.
Return:

- candidate SHA;
- workflow run URL and conclusion;
- `Release qualification` job URL; and
- workflow run attempt.

If the release candidate SHA changes, discard the earlier pre-tag run and dispatch the authorized mode for the new SHA.
No release-note-only delta exception is currently defined.

When `nemoclaw-maintainer-cut-release-tag` invokes this skill, return the exact-SHA workflow and `Release qualification` job URLs.
The stable check is provisional pre-tag E2E evidence until `scripts/release-cut-tag.sh` verifies the canonical GitHub job at the planned commit.
Do not build a second general status ledger from artifacts.
The waiver artifact is narrow binding evidence for a failed workflow, not a replacement for the `Release qualification` result.
Do not ask for the release confirmation phrase in this skill.

## Access Failures

Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).
Stop on authentication, authorization, remote-access, or permission failures.
