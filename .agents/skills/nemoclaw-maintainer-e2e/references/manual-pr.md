<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Manual PR E2E

Use this mode when a maintainer requests E2E for a pull request. The trusted workflow stays on
`main` and first checks out the latest PR commit. Replay the same selector against the exact PR base
only after a candidate failure remains unresolved. The result is advisory and does not create a
required PR check.

## Credential Boundary

Before dispatch, read [Push and Manual PR E2E](../../../../test/e2e/README.md#push-and-manual-pr-e2e)
for the selected jobs' credential locations, access, lifetimes, and removal or cleanup boundaries.

An empty-selector NVIDIA-owned PR run can expose these values to candidate-controlled jobs:

- long-lived NVIDIA inference and Brave Search API keys;
- Docker Hub credentials through the job's temporary Docker configuration;
- long-lived Telegram, Discord, and Slack credentials;
- a read-only job-scoped `GITHUB_TOKEN` in jobs that need repository access; and
- messaging account and channel identifiers.

The workflow does not revoke long-lived credentials or erase identifiers copied by candidate code.
GitHub invalidates the job-scoped token after the job ends.

Before dispatch, review the complete candidate diff. After a failure:

- inspect artifacts;
- remove resources that cleanup left behind; and
- rotate or revoke exposed credentials when necessary.

`Staging Brev Launchable` is available only when the source is an NVIDIA-owned branch in
`NVIDIA/NemoClaw`. Its trusted host receives the Brev API key and image-dispatch token. The guest
receives the NVIDIA inference API key. The protected managed-image and native-runtime qualification
jobs define narrower trusted-host boundaries in the workflow.

## Resolve and Authorize the Revision

```bash
set -euo pipefail
PR_NUMBER=123
git fetch --prune origin main
WORKFLOW_SHA="$(git rev-parse origin/main)"
PR_JSON="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$PR_JSON")" = open
test "$(jq -r .base.repo.full_name <<<"$PR_JSON")" = NVIDIA/NemoClaw
test "$(jq -r .base.ref <<<"$PR_JSON")" = main
HEAD_SHA="$(jq -r .head.sha <<<"$PR_JSON")"
BASE_SHA="$(jq -r .base.sha <<<"$PR_JSON")"
HEAD_REPOSITORY="$(jq -r .head.repo.full_name <<<"$PR_JSON")"
BASE_REPOSITORY="$(jq -r .base.repo.full_name <<<"$PR_JSON")"
HEAD_OWNER="$(jq -r .head.repo.owner.login <<<"$PR_JSON")"
HEAD_OWNER_TYPE="$(jq -r .head.repo.owner.type <<<"$PR_JSON")"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]
```

Choose the selection from the source owner:

- An NVIDIA-owned PR can use the full candidate plan and credential profiles. Empty selectors run
  every default-enabled E2E. Any supported job or target selector is allowed.
- An external PR keeps the credential-free controller selection. Empty selectors run the trusted
  default PR selection. The controller also permits `jobs=inference-routing`,
  `jobs=managed-image-protected-runtime`, `jobs=native-runtime-qualification-producer`, or the
  documented credential-free target selectors.

Jetson and Launchable runs require a branch in `NVIDIA/NemoClaw`. Jetson also requires
`allow_jetson_dispatch=true` and the reviewed service configuration in
[Jetson Dispatch Controller](../../../../test/e2e/docs/jetson-dispatch.md).

Set the requested selectors and flags, or leave them empty. Record them once so an exact-base replay
cannot silently change the selected behavior:

```bash
E2E_JOBS="${E2E_JOBS:-}"
E2E_TARGETS="${E2E_TARGETS:-}"
ALLOW_JETSON_DISPATCH="${ALLOW_JETSON_DISPATCH:-false}"
INCLUDE_STAGING_BREV_LAUNCHABLE="${INCLUDE_STAGING_BREV_LAUNCHABLE:-false}"
HEAD_CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f "targets=${E2E_TARGETS}" \
  -f "jobs=${E2E_JOBS}" \
  -f inference_mode=mock \
  -f "include_staging_brev_launchable=${INCLUDE_STAGING_BREV_LAUNCHABLE}" \
  -f "allow_jetson_dispatch=${ALLOW_JETSON_DISPATCH}" \
  -f allow_dgx_spark_runner_queue=false \
  -f "pr_number=${PR_NUMBER}" \
  -f "checkout_sha=${HEAD_SHA}" \
  -f "checkout_repository=${HEAD_REPOSITORY}" \
  -f "base_sha=${BASE_SHA}" \
  -f "workflow_sha=${WORKFLOW_SHA}" \
  -f "correlation_id=${HEAD_CORRELATION_ID}"
```

GitHub's permission to dispatch the workflow authorizes the actor. The workflow does not repeat that
repository-role check. The trusted pre-checkout step validates:

- the open PR;
- the target repository and branch;
- the source repository and owner;
- the selected latest PR commit or exact PR base SHA;
- the base SHA;
- the workflow SHA; and
- whether the source can receive the selected jobs and credentials.

It then records and uploads the immutable `nemoclaw-e2e-dispatch-v2` receipt before candidate
execution. The matrix planner and its dependencies come from the trusted workflow commit. A second
validation after checkout rejects changed PR identity or ownership.

## Find and Verify the Head Run

```bash
set -euo pipefail
RUN_TITLE="E2E PR #${PR_NUMBER} (${HEAD_CORRELATION_ID})"
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
test "$(jq 'length' <<<"$MATCHES")" -eq 1
RUN_ID="$(jq -r '.[0].databaseId' <<<"$MATCHES")"
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw --exit-status || true
RUN_JSON="$(gh api "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}")"
jq -e --arg sha "$WORKFLOW_SHA" '
  .run_attempt >= 1 and .head_sha == $sha and
  .status == "completed" and (.conclusion | type == "string")
' <<<"$RUN_JSON" >/dev/null
HEAD_RUN_ID="$RUN_ID"
HEAD_RUN_URL="$(jq -r .html_url <<<"$RUN_JSON")"
HEAD_CONCLUSION="$(jq -r .conclusion <<<"$RUN_JSON")"
CURRENT_PR="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$CURRENT_PR")" = open
test "$(jq -r .head.sha <<<"$CURRENT_PR")" = "$HEAD_SHA"
test "$(jq -r .base.sha <<<"$CURRENT_PR")" = "$BASE_SHA"
test "$(jq -r .head.repo.full_name <<<"$CURRENT_PR")" = "$HEAD_REPOSITORY"
test "$(jq -r .head.repo.owner.login <<<"$CURRENT_PR")" = "$HEAD_OWNER"
test "$(jq -r .head.repo.owner.type <<<"$CURRENT_PR")" = "$HEAD_OWNER_TYPE"
```

If the run is not visible after bounded polling, do not dispatch again. Inspect GitHub Actions for
the correlation ID. Clean up resources from any matching run.

If the head run succeeds, report it and stop. If it fails, inspect the failed job with the read-only
`nemoclaw-maintainer-classify-ci-failure` skill when that skill is available. Pass the workflow and
job evidence the skill requests. Do not recreate its signature list or classification logic here.
If it classifies a known infrastructure failure, report `infrastructure` and stop without a base
replay. If the skill is unavailable or returns `unclassified`, the candidate failure remains
unresolved and may proceed to the exact-base replay below.

## Replay an Unresolved Failure Against the Exact Base

Before dispatch, prove that the PR still has the head and base captured for the failed head run.
Use the same trusted workflow SHA, eligible jobs and targets, and inference mode. The selected source
changes from the PR head repository and SHA to the PR base repository and SHA.

Do not use an exact-base replay for Jetson or DGX Spark. Those selectors need dedicated hardware and
cannot provide a trustworthy base comparison with their opt-in flags disabled.

```bash
set -euo pipefail
CURRENT_PR="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$CURRENT_PR")" = open
test "$(jq -r .head.sha <<<"$CURRENT_PR")" = "$HEAD_SHA"
test "$(jq -r .base.sha <<<"$CURRENT_PR")" = "$BASE_SHA"
test "$(jq -r .head.repo.full_name <<<"$CURRENT_PR")" = "$HEAD_REPOSITORY"
test "$(jq -r .base.repo.full_name <<<"$CURRENT_PR")" = "$BASE_REPOSITORY"
test "$BASE_REPOSITORY" = NVIDIA/NemoClaw

BASE_CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f "targets=${E2E_TARGETS}" \
  -f "jobs=${E2E_JOBS}" \
  -f inference_mode=mock \
  -f "include_staging_brev_launchable=${INCLUDE_STAGING_BREV_LAUNCHABLE}" \
  -f allow_jetson_dispatch=false \
  -f allow_dgx_spark_runner_queue=false \
  -f "pr_number=${PR_NUMBER}" \
  -f "checkout_sha=${BASE_SHA}" \
  -f "checkout_repository=${BASE_REPOSITORY}" \
  -f "base_sha=${BASE_SHA}" \
  -f "workflow_sha=${WORKFLOW_SHA}" \
  -f "correlation_id=${BASE_CORRELATION_ID}"
```

Find the base run with the same bounded lookup used above and this exact title:

```bash
RUN_TITLE="E2E PR #${PR_NUMBER} (${BASE_CORRELATION_ID})"
```

Verify that its Actions run `head_sha` is the same `WORKFLOW_SHA`. Record its run ID, URL, and
conclusion as `BASE_RUN_ID`, `BASE_RUN_URL`, and `BASE_CONCLUSION`. Re-read the PR and require that
its state, head SHA, base SHA, head repository, and base repository still match the captured values.
Classify a failed base job with the same read-only CI classification skill when available.

Report exactly one outcome:

- `candidate regression`: the unresolved head run failed and the exact-base run passed.
- `base already broken`: both runs show the same reproducible product failure.
- `infrastructure`: the read-only classifier identifies a known infrastructure failure in either
  run.
- `unresolved`: the base run fails differently, a run or identity is incomplete, or the available
  evidence does not support one of the outcomes above.

The report must include both workflow URLs, `HEAD_SHA`, `BASE_SHA`, `WORKFLOW_SHA`, the identical
selectors, and the classifier result. Do not automatically dispatch the base run, retry either run,
or publish a custom commit status.

Return:

- the PR number;
- the source repository;
- the source repository owner;
- the tested head and, when replayed, base commit SHAs;
- the base SHA;
- the workflow SHA;
- the head and, when replayed, base correlation IDs;
- the selectors;
- the head and, when replayed, base workflow URLs; and
- the result or comparison outcome.

A changed source repository, owner, latest PR commit SHA, or base SHA invalidates the run claim.
