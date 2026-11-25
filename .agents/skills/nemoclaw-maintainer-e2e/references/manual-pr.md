<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Manual PR E2E

Use this mode when the task authorizes E2E for a pull request, including continued qualification
after in-scope upgrade repairs. Apply [execution authorization](../SKILL.md#carry-execution-authorization-through-the-task);
do not require a new request after each run ends. The trusted workflow stays on
`main` and first checks out the latest commit of an open PR. It rejects an arbitrary or historical
commit SHA. Replay the same selector against the exact PR base only after a candidate failure remains
unresolved. The result is advisory and does not create a required PR check.

Manual PR E2E accepts only source branches in `NVIDIA/NemoClaw`, including for base replay.
Review and adopt fork contributions onto a repository branch before dispatch.
Repository writers are trusted to populate the compiled cache before their changes merge.

## Credential Boundary

Before dispatch, read [Push and Manual PR E2E](../../../../test/e2e/README.md#push-and-manual-pr-e2e)
for the selected jobs' credential locations, access, lifetimes, and removal or cleanup boundaries.

An empty-selector same-repository PR run can expose these values to candidate-controlled jobs:

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

`Exact staging Brev Launchable` is available only when the source is a branch in
`NVIDIA/NemoClaw`. Its trusted host receives the Brev API key and image-dispatch token. The guest
receives the NVIDIA inference API key. The protected managed-image and native-runtime qualification
jobs define narrower trusted-host boundaries in the workflow.

## Resolve the Revision and Recheck Execution Scope

```bash
set -euo pipefail
PR_NUMBER=123
WORKFLOW_SHA="$(gh api repos/NVIDIA/NemoClaw/git/ref/heads/main --jq '.object.sha')"
git fetch --no-tags git@github.com:NVIDIA/NemoClaw.git +refs/heads/main:refs/remotes/origin/main
test "$(git rev-parse --verify origin/main)" = "$WORKFLOW_SHA"
PR_JSON="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$PR_JSON")" = open
test "$(jq -r .base.repo.full_name <<<"$PR_JSON")" = NVIDIA/NemoClaw
test "$(jq -r .base.ref <<<"$PR_JSON")" = main
HEAD_SHA="$(jq -r .head.sha <<<"$PR_JSON")"
BASE_SHA="$(jq -r .base.sha <<<"$PR_JSON")"
HEAD_REPOSITORY="$(jq -r .head.repo.full_name <<<"$PR_JSON")"
test "$HEAD_REPOSITORY" = NVIDIA/NemoClaw
BASE_REPOSITORY="$(jq -r .base.repo.full_name <<<"$PR_JSON")"
HEAD_OWNER="$(jq -r .head.repo.owner.login <<<"$PR_JSON")"
HEAD_OWNER_TYPE="$(jq -r .head.repo.owner.type <<<"$PR_JSON")"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]
```

A same-repository PR can use the full candidate plan and credential profiles.
The controller runs default-enabled jobs for empty selectors. This procedure requires an explicit, authorized job or target selector.

Jetson and Launchable runs require a branch in `NVIDIA/NemoClaw`. Jetson also requires
`allow_jetson_dispatch=true` and the reviewed service configuration in
[Jetson Dispatch Controller](../../../../test/e2e/docs/jetson-dispatch.md).

Before dispatch, inspect the trusted controller's required image-publication and execution gates.
Verify those gates against the candidate; unrelated advisory reviews may continue in parallel.
Record active candidate and baseline runs in the task record. Reuse an existing matching run instead of dispatching a duplicate.
Candidate and baseline runs use separate concurrency groups. A candidate retry cannot cancel the baseline.
Baseline groups also include jobs and targets, so different selections cannot replace each other's pending runs.
Baseline replay also disables active-run cancellation; retain its run ID through completion or explicit cancellation.
For timing comparisons, avoid overlapping work on shared resources when it would confound the measurement.

Before either candidate dispatch or base replay:

1. Read the shared task record with `node tools/task-continuation/checkpoint.mts resume "$TASK_RECORD"`.
2. Compare the requested PR, jobs, targets, credential flags, cost bounds, and cleanup obligations with its recorded authorization.
3. Check expiry, remaining run and comparison budgets, spent retries, and active matching runs.
4. Stop before dispatch if authorization is absent, mismatched, expired, exhausted, or cannot be established from the record.
5. Reuse a matching active run. Reconcile pending operations before another dispatch.
6. Persist dispatch intent and its budget consumption through the shared task-continuation procedure before the external write.

Run these functions in the same Bash session as both dispatch procedures.
They update the existing checkpoint; they do not create a second record or grant authorization.
The intent consumes the recorded budget before the GitHub write. The result records a discovered run before waiting for completion.

The lifecycle owner must first store each accepted dispatch grant as JSON in
`identities["manualE2E.authorization." + budgetKey]`. Each value uses the fields in `action` below,
except `correlationId`, which is generated for each dispatch. Obtain those values from the accepted
task authorization, including its budget key, source, selectors, credential flags, cost and cleanup
bounds. Do not derive this authorization record from the environment being checked.
Existing grants are immutable. For a newly authorized candidate or comparison, append authorization
evidence and add its grant under its distinct budget key. Preserve previous grants and spent budgets.
Older phase-keyed grants remain readable but must be copied into budget-keyed entries before dispatch.
The recipe compares the entire context with that record before saving intent or calling GitHub.

```bash
set -euo pipefail
observe_dispatch() {
  local seconds="$1" reference="$2"
  shift 2
  python3 - "$seconds" "$reference" "$E2E_CLEANUP_OWNER" "$E2E_CLEANUP_OBLIGATION" "$@" <<'PY'
import math
import subprocess
import sys

seconds = float(sys.argv[1])
if not math.isfinite(seconds) or seconds <= 0:
    sys.exit("Observation deadline must be a positive finite number of seconds")
reference, owner, cleanup = sys.argv[2:5]
command = ["gh", *sys.argv[5:]]
try:
    result = subprocess.run(command, timeout=seconds, check=False)
except subprocess.TimeoutExpired:
    print(f"Observation timed out after {seconds:g}s for {reference}. "
          f"Inspect the existing run and task record; do not dispatch again. "
          f"Cleanup owner: {owner}; obligation: {cleanup}", file=sys.stderr)
    sys.exit(124)
# A completed failed workflow makes gh run watch return 1. Verify its terminal receipt next.
if command[1:3] == ["run", "watch"] and result.returncode == 1:
    sys.exit(0)
sys.exit(result.returncode if result.returncode >= 0 else 1)
PY
}

save_dispatch_intent() {
  local phase="$1" correlation="$2" budget="$3" checkout="$4" repository="$5" jetson="$6"
  local view revision action next
  view="$(node tools/task-continuation/checkpoint.mts resume "$TASK_RECORD")"
  revision="$(jq -er .revision <<<"$view")"
  action="$(jq -cn --arg phase "$phase" --arg pr "$PR_NUMBER" \
    --arg checkout "$checkout" --arg repository "$repository" \
    --arg base "$BASE_SHA" --arg workflow "$WORKFLOW_SHA" \
    --arg jobs "$E2E_JOBS" --arg targets "$E2E_TARGETS" \
    --arg correlation "$correlation" --arg budget "$budget" \
    --arg owner "$E2E_CLEANUP_OWNER" --arg cleanup "$E2E_CLEANUP_OBLIGATION" \
    --arg cost "$E2E_COST_BOUNDS" --argjson jetson "$jetson" \
    --argjson launchable "$INCLUDE_STAGING_BREV_LAUNCHABLE" \
    '{phase:$phase,prNumber:$pr,checkoutSha:$checkout,repository:$repository,
      baseSha:$base,workflowSha:$workflow,jobs:$jobs,targets:$targets,
      correlationId:$correlation,budgetKey:$budget,cleanupOwner:$owner,
      cleanupObligation:$cleanup,costBounds:$cost,inferenceMode:"mock",
      allowJetsonDispatch:$jetson,includeStagingBrevLaunchable:$launchable}')"
  jq -e --arg key "manualE2E.authorization.${budget}" --argjson action "$action" '
    (.identities[$key] | fromjson) == ($action | del(.correlationId))
  ' <<<"$view" >/dev/null || {
    echo "Dispatch context differs from recorded authorization; stop before dispatch" >&2
    return 1
  }
  if [[ "$phase" = base ]]; then
    jq -e --arg key "manualE2E.authorization.${E2E_CANDIDATE_BUDGET:?Use the authorized candidate budget key}" \
      --argjson action "$action" '
      (.identities[$key] | fromjson) as $candidate |
      $candidate.jobs == $action.jobs and $candidate.targets == $action.targets
    ' <<<"$view" >/dev/null || {
      echo "Base selectors differ from recorded candidate authorization; stop before replay" >&2
      return 1
    }
  fi
  next="$(jq --arg phase "$phase" --arg id "$correlation" \
    --arg budget "$budget" --arg action "$action" '
    del(.checkpoint,.usage,.staleEvidence,.resumeAction,.pendingOperationIds) |
    .revision += 1 |
    .operations += [{id:$id,action:$action,budget:$budget,state:"pending",observation:""}] |
    .identities["manualE2E."+$phase+".operationId"] = $id |
    .nextAction = ("Reconcile E2E dispatch correlation "+$id+" before another dispatch")
  ' <<<"$view")"
  printf '%s\n' "$next" | node tools/task-continuation/checkpoint.mts \
    save "$TASK_RECORD" "$revision" "$TASK_OWNER"
}

save_dispatch_result() {
  local phase="$1" correlation="$2" run="$3" url="$4"
  local view revision observation next
  view="$(node tools/task-continuation/checkpoint.mts resume "$TASK_RECORD")"
  revision="$(jq -er .revision <<<"$view")"
  jq -e --arg id "$correlation" --arg phase "$phase" '
    any(.operations[]; .id == $id and .state == "pending" and
      ((.action | fromjson).phase == $phase))
  ' <<<"$view" >/dev/null
  observation="$(jq -cn --arg run "$run" --arg url "$url" \
    --arg correlation "$correlation" '{runId:$run,url:$url,correlationId:$correlation}')"
  next="$(jq --arg phase "$phase" --arg id "$correlation" \
    --arg run "$run" --arg observation "$observation" '
    del(.checkpoint,.usage,.staleEvidence,.resumeAction,.pendingOperationIds) |
    .revision += 1 |
    .operations |= map(if .id == $id then
      .state = "observed" | .observation = $observation else . end) |
    .identities["manualE2E."+$phase+".runId"] = $run |
    .nextAction = ("Watch E2E run "+$run+"; verify its receipt and cleanup obligation")
  ' <<<"$view")"
  printf '%s\n' "$next" | node tools/task-continuation/checkpoint.mts \
    save "$TASK_RECORD" "$revision" "$TASK_OWNER"
}

find_dispatch_run() {
  local title="E2E PR #${PR_NUMBER} ($1)" matches='[]' runs poll
  for poll in $(seq 1 30); do
    runs="$(observe_dispatch 30 "$title" run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
      --event workflow_dispatch --branch main --limit 50 \
      --json databaseId,displayTitle)"
    matches="$(jq -c --arg title "$title" \
      '[.[] | select(.displayTitle == $title)]' <<<"$runs")"
    test "$(jq 'length' <<<"$matches")" -le 1
    test "$(jq 'length' <<<"$matches")" -eq 0 || break
    sleep 10
  done
  test "$(jq 'length' <<<"$matches")" -eq 1
  RUN_ID="$(jq -er '.[0].databaseId | numbers' <<<"$matches")"
  [[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]]
  RUN_URL="https://github.com/NVIDIA/NemoClaw/actions/runs/${RUN_ID}"
}
```

Use the values verified against that record. Set an unused selector explicitly to an empty string;
at least one selector must be nonempty. Enumerate authorized jobs for a full run instead of using controller defaults.
Do not populate missing authorization from environment values or from this recipe.
Retain these values for base replay; recheck its separate authorization and remaining comparison budget before dispatch:

```bash
set -euo pipefail
TASK_RECORD="${TASK_RECORD:?Read the existing task record before dispatch}"
node tools/task-continuation/checkpoint.mts resume "$TASK_RECORD"
TASK_OWNER="${TASK_OWNER:?Use the recorded writer identity}"
E2E_CLEANUP_OWNER="${E2E_CLEANUP_OWNER:?Use the recorded cleanup owner}"
E2E_CLEANUP_OBLIGATION="${E2E_CLEANUP_OBLIGATION:?Use the recorded cleanup obligation}"
E2E_COST_BOUNDS="${E2E_COST_BOUNDS:?Use the recorded cost bounds}"
E2E_JOBS="${E2E_JOBS?Set the jobs verified against recorded authorization}"
E2E_TARGETS="${E2E_TARGETS?Set the targets verified against recorded authorization}"
test -n "${E2E_JOBS//[[:space:]]/}${E2E_TARGETS//[[:space:]]/}"
ALLOW_JETSON_DISPATCH="${ALLOW_JETSON_DISPATCH:?Set the recorded credential flag}"
INCLUDE_STAGING_BREV_LAUNCHABLE="${INCLUDE_STAGING_BREV_LAUNCHABLE:?Set the recorded credential flag}"
[[ "$ALLOW_JETSON_DISPATCH" = true || "$ALLOW_JETSON_DISPATCH" = false ]]
[[ "$INCLUDE_STAGING_BREV_LAUNCHABLE" = true || "$INCLUDE_STAGING_BREV_LAUNCHABLE" = false ]]
HEAD_CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
save_dispatch_intent candidate "$HEAD_CORRELATION_ID" \
  "${E2E_CANDIDATE_BUDGET:?Use the authorized candidate budget key}" \
  "$HEAD_SHA" "$HEAD_REPOSITORY" "$ALLOW_JETSON_DISPATCH"
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f "targets=${E2E_TARGETS}" \
  -f "jobs=${E2E_JOBS}" \
  -f inference_mode=mock \
  -f "include_staging_brev_launchable=${INCLUDE_STAGING_BREV_LAUNCHABLE}" \
  -f "allow_jetson_dispatch=${ALLOW_JETSON_DISPATCH}" \
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
find_dispatch_run "$HEAD_CORRELATION_ID"
save_dispatch_result candidate "$HEAD_CORRELATION_ID" "$RUN_ID" "$RUN_URL"
observe_dispatch "${E2E_WATCH_TIMEOUT_SECONDS:-3600}" "$RUN_ID" \
  run watch "$RUN_ID" --repo NVIDIA/NemoClaw --exit-status
RUN_JSON="$(observe_dispatch 30 "$RUN_ID" api "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}")"
jq -e --arg sha "$WORKFLOW_SHA" '
  .run_attempt >= 1 and .head_sha == $sha and
  .status == "completed" and (.conclusion | type == "string")
' <<<"$RUN_JSON" >/dev/null
HEAD_RUN_ID="$RUN_ID"
HEAD_RUN_URL="$(jq -r .html_url <<<"$RUN_JSON")"
HEAD_CONCLUSION="$(jq -r .conclusion <<<"$RUN_JSON")"
CURRENT_PR="$(observe_dispatch 30 "$RUN_ID" api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$CURRENT_PR")" = open
test "$(jq -r .head.sha <<<"$CURRENT_PR")" = "$HEAD_SHA"
test "$(jq -r .base.sha <<<"$CURRENT_PR")" = "$BASE_SHA"
test "$(jq -r .head.repo.full_name <<<"$CURRENT_PR")" = "$HEAD_REPOSITORY"
test "$(jq -r .head.repo.owner.login <<<"$CURRENT_PR")" = "$HEAD_OWNER"
test "$(jq -r .head.repo.owner.type <<<"$CURRENT_PR")" = "$HEAD_OWNER_TYPE"
```

If the run is not visible after bounded polling, do not dispatch again. Inspect GitHub Actions for
the correlation ID. Clean up resources from any matching run.

Observation requests have a 30-second deadline. Each watch has a one-hour deadline; set
`E2E_WATCH_TIMEOUT_SECONDS` to a positive number of seconds for a different observation window.
A timeout stops local observation with status 124 and retains the checkpoint's run ID and cleanup
obligation. It does not cancel the remote run. Inspect that run and its resources before resuming;
do not dispatch a replacement or base replay merely because observation timed out.

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

node tools/task-continuation/checkpoint.mts resume "${TASK_RECORD:?Read the existing task record before replay}"
test -n "${E2E_JOBS//[[:space:]]/}${E2E_TARGETS//[[:space:]]/}"
BASE_CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
save_dispatch_intent base "$BASE_CORRELATION_ID" \
  "${E2E_BASE_BUDGET:?Use the separately authorized comparison budget key}" \
  "$BASE_SHA" "$BASE_REPOSITORY" false
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f "targets=${E2E_TARGETS}" \
  -f "jobs=${E2E_JOBS}" \
  -f inference_mode=mock \
  -f "include_staging_brev_launchable=${INCLUDE_STAGING_BREV_LAUNCHABLE}" \
  -f allow_jetson_dispatch=false \
  -f "pr_number=${PR_NUMBER}" \
  -f "checkout_sha=${BASE_SHA}" \
  -f "checkout_repository=${BASE_REPOSITORY}" \
  -f "base_sha=${BASE_SHA}" \
  -f "workflow_sha=${WORKFLOW_SHA}" \
  -f "correlation_id=${BASE_CORRELATION_ID}"
```

Find and record the base run before waiting. Then verify its workflow and PR identities:

```bash
set -euo pipefail
find_dispatch_run "$BASE_CORRELATION_ID"
save_dispatch_result base "$BASE_CORRELATION_ID" "$RUN_ID" "$RUN_URL"
observe_dispatch "${E2E_WATCH_TIMEOUT_SECONDS:-3600}" "$RUN_ID" \
  run watch "$RUN_ID" --repo NVIDIA/NemoClaw --exit-status
RUN_JSON="$(observe_dispatch 30 "$RUN_ID" api "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}")"
jq -e --arg sha "$WORKFLOW_SHA" '
  .run_attempt >= 1 and .head_sha == $sha and
  .status == "completed" and (.conclusion | type == "string")
' <<<"$RUN_JSON" >/dev/null
BASE_RUN_ID="$RUN_ID"
BASE_RUN_URL="$(jq -r .html_url <<<"$RUN_JSON")"
BASE_CONCLUSION="$(jq -r .conclusion <<<"$RUN_JSON")"
CURRENT_PR="$(observe_dispatch 30 "$RUN_ID" api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$CURRENT_PR")" = open
test "$(jq -r .head.sha <<<"$CURRENT_PR")" = "$HEAD_SHA"
test "$(jq -r .base.sha <<<"$CURRENT_PR")" = "$BASE_SHA"
test "$(jq -r .head.repo.full_name <<<"$CURRENT_PR")" = "$HEAD_REPOSITORY"
test "$(jq -r .base.repo.full_name <<<"$CURRENT_PR")" = "$BASE_REPOSITORY"
test "$(jq -r .head.repo.owner.login <<<"$CURRENT_PR")" = "$HEAD_OWNER"
test "$(jq -r .head.repo.owner.type <<<"$CURRENT_PR")" = "$HEAD_OWNER_TYPE"
```

Classify a failed base job with the same read-only CI classification skill when available.

Report exactly one outcome:

- `candidate regression`: the candidate shows a product failure absent on the base, with evidence tying it to the changed contract.
- `base already broken`: both runs show the same reproducible product failure.
- `infrastructure`: the read-only classifier identifies a known infrastructure failure in either
  run.
- `unresolved`: the base run fails differently, a run or identity is incomplete, or the available
  evidence does not support one of the outcomes above.

A timeout on the candidate and a pass on the base establish different outcomes, not their cause.
Compare the reached assertions, phase durations, effective budgets, image identities, caches, and available resource-pressure evidence.
Matching runner labels do not establish equivalent execution conditions. Keep causal classification unresolved when material differences remain uncontrolled.
Report the dominant measured delay separately from any proven candidate overhead.

The report must include both workflow URLs, `HEAD_SHA`, `BASE_SHA`, `WORKFLOW_SHA`, the identical
selectors, and the classifier result. Dispatch a base comparison only within the user's existing execution authorization and the audit's diagnostic procedure.
When that authority is established, continue without requesting routine confirmation.
Do not automatically retry either run or publish a custom commit status. Preserve separate candidate retry and comparison trial counts.

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
