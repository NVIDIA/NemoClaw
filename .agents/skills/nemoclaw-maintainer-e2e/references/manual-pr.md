<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Manual PR E2E

Use this mode when a maintainer requests E2E for a pull request. The trusted workflow stays on
`main` and checks out either the latest PR commit or, after an unresolved candidate failure, the
exact PR base. The result is advisory and does not create a required PR check.

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
  `jobs=managed-image-protected-runtime`, or the documented credential-free target selectors.

`jobs=native-runtime-qualification-producer` requires an NVIDIA-owned branch in
`NVIDIA/NemoClaw`; it is not available for external PRs.

Jetson and Launchable runs require a branch in `NVIDIA/NemoClaw`. Jetson also requires
`allow_jetson_dispatch=true` and the reviewed service configuration in
[Jetson Dispatch Controller](../../../../test/e2e/docs/jetson-dispatch.md).

Set the requested selectors and flags, or leave them empty:

```bash
E2E_JOBS="${E2E_JOBS:-}"
E2E_TARGETS="${E2E_TARGETS:-}"
E2E_GATEWAY_RUNTIMES="${E2E_GATEWAY_RUNTIMES:-docker}"
ALLOW_JETSON_DISPATCH="${ALLOW_JETSON_DISPATCH:-false}"
INCLUDE_STAGING_BREV_LAUNCHABLE="${INCLUDE_STAGING_BREV_LAUNCHABLE:-false}"
CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f "targets=${E2E_TARGETS}" \
  -f "jobs=${E2E_JOBS}" \
  -f "gateway_runtimes=${E2E_GATEWAY_RUNTIMES}" \
  -f inference_mode=mock \
  -f "include_staging_brev_launchable=${INCLUDE_STAGING_BREV_LAUNCHABLE}" \
  -f "allow_jetson_dispatch=${ALLOW_JETSON_DISPATCH}" \
  -f allow_dgx_spark_runner_queue=false \
  -f "pr_number=${PR_NUMBER}" \
  -f revision=candidate \
  -f "checkout_sha=${HEAD_SHA}" \
  -f "checkout_repository=${HEAD_REPOSITORY}" \
  -f "base_sha=${BASE_SHA}" \
  -f "workflow_sha=${WORKFLOW_SHA}" \
  -f "correlation_id=${CORRELATION_ID}"
```

GitHub's permission to dispatch the workflow authorizes the actor. The workflow does not repeat that
repository-role check. The trusted pre-checkout step validates:

- the open PR;
- the target repository and branch;
- the source repository and owner;
- the latest PR commit SHA;
- the base SHA;
- the workflow SHA; and
- whether the source can receive the selected jobs and credentials.

It then records and uploads the immutable `nemoclaw-e2e-dispatch-v2` receipt before candidate
execution. The matrix planner and its dependencies come from the trusted workflow commit. A second
validation after checkout rejects changed PR identity or ownership.

## Find and Verify the Run

```bash
set -euo pipefail
RUN_TITLE="E2E PR #${PR_NUMBER} candidate (${CORRELATION_ID})"
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

If `HEAD_CONCLUSION` is `success`, return:

- the PR number;
- the source repository;
- the source repository owner;
- the latest PR commit SHA;
- the base SHA;
- the workflow SHA;
- the correlation ID;
- the selectors;
- `HEAD_RUN_URL`; and
- the result.

Then stop. A changed source repository, owner, latest PR commit SHA, or base SHA invalidates the run
claim.

## Compare an Unresolved Candidate Failure

First inspect the failed candidate run with the read-only CI classifier. If it matches a known
runner, service, capacity, or network failure, report an infrastructure failure and do not spend a
second E2E run on the base.

For any remaining candidate failure, dispatch the exact same selector against the exact PR base.
At least one of `jobs` and `targets` must be nonempty. The PR must use a same-repository
`NVIDIA/NemoClaw` branch.
Keep the same inference and gateway inputs. Use a new correlation ID, set `revision=base`,
`checkout_sha=$BASE_SHA`, and `checkout_repository=NVIDIA/NemoClaw`. Base comparison does not allow
Launchable, Jetson, DGX Spark, or the candidate-only native-runtime evidence producer.

```bash
test -n "$E2E_JOBS" || test -n "$E2E_TARGETS"
test "$HEAD_REPOSITORY" = NVIDIA/NemoClaw
BASE_CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f "targets=${E2E_TARGETS}" \
  -f "jobs=${E2E_JOBS}" \
  -f "gateway_runtimes=${E2E_GATEWAY_RUNTIMES}" \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f allow_jetson_dispatch=false \
  -f allow_dgx_spark_runner_queue=false \
  -f "pr_number=${PR_NUMBER}" \
  -f revision=base \
  -f "checkout_sha=${BASE_SHA}" \
  -f checkout_repository=NVIDIA/NemoClaw \
  -f "base_sha=${BASE_SHA}" \
  -f "workflow_sha=${WORKFLOW_SHA}" \
  -f "correlation_id=${BASE_CORRELATION_ID}"
```

Find the base run with the same bounded lookup used above and this exact title:

```bash
RUN_TITLE="E2E PR #${PR_NUMBER} base (${BASE_CORRELATION_ID})"
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
BASE_RUN_ID="$(jq -r '.[0].databaseId' <<<"$MATCHES")"
gh run watch "$BASE_RUN_ID" --repo NVIDIA/NemoClaw --exit-status || true
BASE_RUN_JSON="$(gh api "repos/NVIDIA/NemoClaw/actions/runs/${BASE_RUN_ID}")"
jq -e --arg sha "$WORKFLOW_SHA" '
  .run_attempt >= 1 and .head_sha == $sha and
  .status == "completed" and (.conclusion | type == "string")
' <<<"$BASE_RUN_JSON" >/dev/null
BASE_RUN_URL="$(jq -r .html_url <<<"$BASE_RUN_JSON")"
BASE_CONCLUSION="$(jq -r .conclusion <<<"$BASE_RUN_JSON")"
CURRENT_PR="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$CURRENT_PR")" = open
test "$(jq -r .head.sha <<<"$CURRENT_PR")" = "$HEAD_SHA"
test "$(jq -r .base.sha <<<"$CURRENT_PR")" = "$BASE_SHA"
test "$(jq -r .head.repo.full_name <<<"$CURRENT_PR")" = "$HEAD_REPOSITORY"
```

The workflow re-reads the open PR before and after checkout. It requires the tested commit to equal
the current PR base, preserves the current PR head in the dispatch receipt, and uses the same trusted
workflow revision as the candidate run. Candidate and base have separate concurrency keys, so both
GitHub run records remain available.

Classify the two runs without writing to the PR. Report exactly one outcome:

- Candidate passes: no base run is needed.
- Candidate has a known infrastructure failure: `infrastructure failure`.
- Candidate fails and the identical base selector passes: `candidate regression`.
- Candidate and base fail with the same product signature: `base already broken`.
- Evidence is missing, signatures differ, or attribution remains unclear: `unresolved`.

Report the candidate and base tested SHAs, selectors, conclusions, and GitHub run URLs. GitHub runs
are the evidence record; do not create a second receipt, status, publication, or automatic replay
system.
