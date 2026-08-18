<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Manual PR E2E

Use this mode when a maintainer requests E2E for a pull request. The trusted workflow stays on
`main` and checks out the latest PR commit. The result is advisory and does not create a required PR
check.

## Credential Boundary

Before dispatch, read [Push and Manual PR E2E](../../../../test/e2e/README.md#push-and-manual-pr-e2e)
for the selected jobs' credential locations, access, lifetimes, and removal or cleanup boundaries.

Depending on its selection, a manual PR run can expose long-lived inference, Brave Search, and
messaging credentials to candidate-controlled jobs. Some jobs also expose a read-only job-scoped
`GITHUB_TOKEN`, messaging identifiers, or external resources.

Before dispatch, review the complete candidate diff. After a failure:

- inspect artifacts;
- remove resources that cleanup left behind; and
- rotate or revoke exposed credentials when necessary.

`Exact staging Brev Launchable` is not available to manual PR runs. The checked-in workflow jobs
define narrower trusted-host boundaries for protected managed-image and native-runtime qualification.

## Resolve and Authorize the Revision

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

Require a review reason containing 10 to 500 printable characters. Choose one allowed selection:

- Empty jobs and targets: the trusted default PR selection.
- `jobs=inference-routing`.
- `jobs=managed-image-protected-runtime`. The candidate must contain `ci/protected-managed-image-multiarch-activation-v1.json` and `ci/protected-managed-image-runtime-activation-v1.json`.
- `jobs=native-runtime-qualification-producer` for a same-repository PR and first workflow attempt. The workflow SHA and PR base SHA must match. Set `NATIVE_RUNTIME_EPHEMERAL_RUNNER_POOL=enabled` and `NATIVE_RUNTIME_ARM64_GPU_RUNNER_LABEL` to the reviewed runner label. The candidate must contain `test/e2e/live/native-runtime-qualification-case.test.ts`.
- `targets=jetson-nvmap-gpu` with `allow_jetson_dispatch=true`, only after the operator confirms that
  the service is available and compatible with HTTP contract version `1.0.0` and that
  `JETSON_DISPATCH_URL` is set to the verified HTTPS origin. See
  [Jetson Dispatch Controller](../../../../test/e2e/docs/jetson-dispatch.md).

Do not rerun the same native-runtime workflow attempt.

Set one selector and its required flag, or leave all of them empty:

```bash
E2E_JOBS="${E2E_JOBS:-}"
E2E_TARGETS="${E2E_TARGETS:-}"
ALLOW_JETSON_DISPATCH="${ALLOW_JETSON_DISPATCH:-false}"
case "${E2E_JOBS}:${E2E_TARGETS}:${ALLOW_JETSON_DISPATCH}" in
  ::false | inference-routing::false | managed-image-protected-runtime::false | native-runtime-qualification-producer::false | :jetson-nvmap-gpu:true) ;;
  *) echo "Unsupported manual PR E2E selection" >&2; exit 1 ;;
esac

REVIEW_REASON='Reviewed the latest PR commit and selected E2E boundary.'
CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f "targets=${E2E_TARGETS}" \
  -f "jobs=${E2E_JOBS}" \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f "allow_jetson_dispatch=${ALLOW_JETSON_DISPATCH}" \
  -f allow_dgx_spark_runner_queue=false \
  -f "pr_number=${PR_NUMBER}" \
  -f "checkout_sha=${HEAD_SHA}" \
  -f "checkout_repository=${HEAD_REPOSITORY}" \
  -f "base_sha=${BASE_SHA}" \
  -f "workflow_sha=${WORKFLOW_SHA}" \
  -f "review_reason=${REVIEW_REASON}" \
  -f "correlation_id=${CORRELATION_ID}"
```

The trusted pre-checkout step requires the actor to have repository `maintain` or `admin` permission
at dispatch time. It validates:

- the actor;
- the open PR;
- the source repository;
- the latest PR commit SHA;
- the base SHA;
- the workflow SHA;
- the review reason; and
- the selector combination.

It then records and uploads the immutable `nemoclaw-e2e-dispatch-v2` receipt before candidate
execution. A second validation after checkout rejects changed PR identity.

## Find and Verify the Run

```bash
set -euo pipefail
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
test "$(jq 'length' <<<"$MATCHES")" -eq 1
RUN_ID="$(jq -r '.[0].databaseId' <<<"$MATCHES")"
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw --exit-status
RUN_JSON="$(gh api "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}")"
jq -e --arg sha "$WORKFLOW_SHA" '
  .run_attempt == 1 and .head_sha == $sha and
  .status == "completed" and .conclusion == "success"
' <<<"$RUN_JSON" >/dev/null
CURRENT_PR="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$CURRENT_PR")" = open
test "$(jq -r .head.sha <<<"$CURRENT_PR")" = "$HEAD_SHA"
test "$(jq -r .base.sha <<<"$CURRENT_PR")" = "$BASE_SHA"
test "$(jq -r .head.repo.full_name <<<"$CURRENT_PR")" = "$HEAD_REPOSITORY"
```

If the run is not visible after bounded polling, do not dispatch again. Inspect GitHub Actions for
the correlation ID. Clean up resources from any matching run.

Return:

- the PR number;
- the source repository;
- the latest PR commit SHA;
- the base SHA;
- the workflow SHA;
- the correlation ID;
- the selectors;
- the workflow URL; and
- the result.

A changed source repository, latest PR commit SHA, or base SHA invalidates the run claim.
