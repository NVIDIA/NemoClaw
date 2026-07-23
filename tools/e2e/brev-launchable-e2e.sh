#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

IMAGE_REPOSITORY=brevdev/nemoclaw-image
IMAGE_WORKFLOW=build-qualification-image.yml
cleanup_required=0

log() {
  printf '%s\n' "$*" | tee -a "$WORK_DIR/lane.log"
}

die() {
  log "FAILED: $*" >&2
  exit 1
}

require() {
  local name="$1"
  [ -n "${!name:-}" ] || die "$name is required"
}

workspace_rows() {
  timeout 30s brev ls --json | jq -c '
    if type == "array" then .
    elif type == "object" and has("workspaces") and .workspaces == null then []
    elif type == "object" and (.workspaces | type) == "array" then .workspaces
    else error("unexpected brev ls --json shape") end'
}

workspace() {
  workspace_rows | jq -c --arg name "$INSTANCE_NAME" '
    map(select(((.name // .workspaceName // .instanceName // "") | tostring) == $name))
    | if length == 0 then empty elif length == 1 then .[0]
      else error("workspace name is ambiguous") end'
}

cleanup() {
  local record deadline absent=0 workspace_id=""
  record="$(workspace || true)"
  workspace_id="$(jq -r '.id // ""' <<<"${record:-null}")"
  [ -z "$record" ] || timeout 60s brev delete "$INSTANCE_NAME" || true
  deadline=$((SECONDS + ${BREV_DELETE_TIMEOUT_SECONDS:-600}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if record="$(workspace)" && [ -z "$record" ]; then
      absent=$((absent + 1))
      if [ "$absent" -ge 2 ]; then
        jq -n --arg workspaceName "$INSTANCE_NAME" --arg workspaceId "$workspace_id" \
          --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '{workspaceName:$workspaceName,workspaceId:$workspaceId,status:"ABSENT",verifiedAt:$verifiedAt}' \
          >"$WORK_DIR/cleanup.json"
        log "Workspace $INSTANCE_NAME is absent"
        return 0
      fi
    else
      absent=0
    fi
    timeout 30s brev refresh >/dev/null 2>&1 || true
    sleep "${POLL_SECONDS:-15}"
  done
  log "FAILED: workspace $INSTANCE_NAME still exists after deletion" >&2
  return 1
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$cleanup_required" -eq 1 ] && ! cleanup; then status=1; fi
  exit "$status"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

CORRELATION_ID="${CORRELATION_ID:-$(tr '[:upper:]' '[:lower:]' </proc/sys/kernel/random/uuid)}"
for name in WORK_DIR CANDIDATE_SHA CORRELATION_ID GH_TOKEN GITHUB_RUN_ID \
  GITHUB_RUN_ATTEMPT BREV_LAUNCHABLE_ID INSTANCE_NAME NVIDIA_INFERENCE_API_KEY; do
  require "$name"
done
for tool in brev gh jq python3 sed ssh timeout; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "candidate SHA is not canonical"
[[ "$CORRELATION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || die "correlation ID is not a UUIDv4"
[[ "$INSTANCE_NAME" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || die "workspace name is unsafe"
[[ "$BREV_LAUNCHABLE_ID" =~ ^env-[A-Za-z0-9]+$ ]] || die "Launchable ID is unsafe"
: >"$WORK_DIR/lane.log"
log "Candidate $CANDIDATE_SHA"

# Dispatch #80 once, then bind the uniquely correlated producer run.
requested_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
title="Qualify NemoClaw $CANDIDATE_SHA ($CORRELATION_ID)"
gh api --method POST "repos/$IMAGE_REPOSITORY/actions/workflows/$IMAGE_WORKFLOW/dispatches" \
  -f ref=main -f "inputs[nemoclaw_sha]=$CANDIDATE_SHA" \
  -f "inputs[correlation_id]=$CORRELATION_ID" \
  -f "inputs[requester_workflow_run_id]=$GITHUB_RUN_ID" \
  -f "inputs[requester_workflow_run_attempt]=$GITHUB_RUN_ATTEMPT"
deadline=$((SECONDS + 300))
producer_run=""
while [ "$SECONDS" -lt "$deadline" ]; do
  runs="$(gh api --method GET "repos/$IMAGE_REPOSITORY/actions/workflows/$IMAGE_WORKFLOW/runs" \
    -f branch=main -f event=workflow_dispatch -f per_page=50)"
  matches="$(jq -c --arg title "$title" --arg since "$requested_at" \
    '[.workflow_runs[] | select(.display_title == $title and .head_branch == "main" and .created_at >= $since)]' \
    <<<"$runs")" || die "producer run inventory is malformed"
  [ "$(jq 'length' <<<"$matches")" -le 1 ] || die "correlation matched multiple producer runs"
  producer_run="$(jq -r '.[0].id // empty | tostring' <<<"$matches")"
  [ -z "$producer_run" ] || break
  sleep "${POLL_SECONDS:-15}"
done
[ -n "$producer_run" ] || die "producer run was not found"
log "Producer run $producer_run"

deadline=$((SECONDS + ${IMAGE_BUILD_TIMEOUT_SECONDS:-3600}))
while [ "$SECONDS" -lt "$deadline" ]; do
  run="$(gh api "repos/$IMAGE_REPOSITORY/actions/runs/$producer_run")"
  status="$(jq -r '.status // ""' <<<"$run")"
  if [ "$status" = completed ]; then
    [ "$(jq -r '.conclusion // ""' <<<"$run")" = success ] \
      || die "producer run $producer_run failed"
    break
  fi
  sleep "${POLL_SECONDS:-15}"
done
[ "${status:-}" = completed ] || die "producer run $producer_run timed out"
artifact="nemoclaw-image-handoff-v1-${producer_run}-1"
mkdir -m 700 "$WORK_DIR/handoff"
gh run download "$producer_run" --repo "$IMAGE_REPOSITORY" --name "$artifact" \
  --dir "$WORK_DIR/handoff"
manifest="$WORK_DIR/handoff/nemoclaw-image-manifest.v1.json"
[ -f "$manifest" ] || die "producer receipt is missing"
jq -e --arg sha "$CANDIDATE_SHA" --arg correlation "$CORRELATION_ID" \
  --arg requester "$GITHUB_RUN_ID" --argjson attempt "$GITHUB_RUN_ATTEMPT" --arg run "$producer_run" '
  .kind == "nemoclaw-exact-image-manifest" and .nemoclawSha == $sha and
  .correlationId == $correlation and .requesterWorkflowRunId == $requester and
  .requesterWorkflowRunAttempt == $attempt and .imageRepository == "brevdev/nemoclaw-image" and
  .producerWorkflow == ".github/workflows/build-qualification-image.yml" and
  .workflowRunId == $run and .workflowRunAttempt == 1 and .status == "READY" and
  .channel == "staging" and .variant == "cpu" and
  .observedFamily == "nemoclaw-brev-staging-cpu"' \
  "$manifest" >/dev/null || die "producer receipt does not match the candidate"
rm -rf "$WORK_DIR/handoff"

# The standing Launchable resolves the staging family; the guest must contain the exact clean candidate.
existing="$(workspace)" || die "Brev workspace inventory failed"
[ -z "$existing" ] || die "workspace name already exists"
cleanup_required=1
timeout 900s brev create "$INSTANCE_NAME" --launchable "$BREV_LAUNCHABLE_ID" --detached --timeout 900
deadline=$((SECONDS + ${BREV_READY_TIMEOUT_SECONDS:-1200}))
ready=""
while [ "$SECONDS" -lt "$deadline" ]; do
  ready="$(workspace || true)"
  if jq -e '.status == "RUNNING" and (.shell_status // .shellStatus) == "READY" and
    (.build_status // .buildStatus) == "COMPLETED"' <<<"${ready:-null}" >/dev/null; then break; fi
  state="$(jq -r '(.status // "") + ":" + (.build_status // .buildStatus // "")' <<<"${ready:-null}")"
  [[ "$state" =~ FAILURE|FAILED|ERROR|CREATE_FAILED ]] && die "workspace entered $state"
  sleep "${POLL_SECONDS:-15}"
done
jq -e '.status == "RUNNING" and (.shell_status // .shellStatus) == "READY" and
  (.build_status // .buildStatus) == "COMPLETED"' \
  <<<"${ready:-null}" >/dev/null || die "workspace readiness timed out"
workspace_id="$(jq -r '.id // ""' <<<"$ready")"
log "Workspace $INSTANCE_NAME ($workspace_id) is ready"

# qualification-identity: return only the baked SHA and clean-checkout verdict.
# The remote shell expands the single-quoted command.
# shellcheck disable=SC2016
identity="$(timeout 300s brev exec "$INSTANCE_NAME" 'set -euo pipefail
  repo_sha=$(git -C "$HOME/NemoClaw" rev-parse HEAD)
  provision_sha=$(sudo -n jq -er .gitSha /etc/nemoclaw/provision.json)
  if [ -z "$(git -C "$HOME/NemoClaw" status --porcelain --untracked-files=normal)" ]; then
    repo_clean=true
  else
    repo_clean=false
  fi
  printf "NEMOCLAW_IDENTITY="
  jq -cn --arg repoSha "$repo_sha" --arg provisionSha "$provision_sha" \
    --argjson repoClean "$repo_clean" \
    "{repoSha:\$repoSha,provisionSha:\$provisionSha,repoClean:\$repoClean}"' --host \
  | sed -n 's/^NEMOCLAW_IDENTITY=//p' | tail -n 1)"
jq -e --arg sha "$CANDIDATE_SHA" '
  .repoSha == $sha and .provisionSha == $sha and .repoClean == true' \
  <<<"$identity" >/dev/null || die "booted checkout does not match candidate"

jq -n --arg candidateSha "$CANDIDATE_SHA" --arg producerRun "$producer_run" \
  --argjson boot "$identity" --arg workspaceName "$INSTANCE_NAME" --arg workspaceId "$workspace_id" \
  '{candidateSha:$candidateSha,producer:{runId:$producerRun,status:"success"},boot:$boot,workspace:{name:$workspaceName,id:$workspaceId},fullE2e:"pending"}' \
  >"$WORK_DIR/qualification.json"

# Run the existing suite from the baked checkout; no source copy, install, or rebuild.
raw_log="${RUNNER_TEMP:-/tmp}/brev-launchable-e2e-${GITHUB_RUN_ID}.raw"
set +e
{
  printf 'export NVIDIA_INFERENCE_API_KEY=%q\n' "$NVIDIA_INFERENCE_API_KEY"
  cat <<'REMOTE'
set -euo pipefail
cd "$HOME/NemoClaw"
test -x ./node_modules/.bin/vitest
export CI=true GITHUB_ACTIONS=true E2E_TARGET_ID=staging-brev-launchable
export NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable NEMOCLAW_RUN_LIVE_E2E=1
export NEMOCLAW_MODEL="$(node /usr/local/lib/nemoclaw/launchable-config.mjs /usr/local/share/nemoclaw/launchable-agents.json openclaw cloudModel)"
export NEMOCLAW_SANDBOX_NAME=e2e-staging
./node_modules/.bin/vitest run --project e2e-live test/e2e/live/full-e2e.test.ts --silent=false --reporter=default
printf 'NEMOCLAW_FULL_E2E_PASSED\n'
REMOTE
} | timeout "${FULL_E2E_TIMEOUT_SECONDS:-3000}" ssh -T -o ConnectTimeout=10 -o LogLevel=ERROR \
  "${INSTANCE_NAME}-host" 'bash -s' >"$raw_log" 2>&1
e2e_status=$?
set -e
python3 - "$raw_log" "$WORK_DIR/full-e2e.log" "$NVIDIA_INFERENCE_API_KEY" <<'PY'
import sys
from pathlib import Path
source, target, secret = sys.argv[1:]
Path(target).write_bytes(Path(source).read_bytes().replace(secret.encode(), b"[REDACTED]"))
Path(source).unlink(missing_ok=True)
PY
if [ "$e2e_status" -ne 0 ] || ! grep -q '^NEMOCLAW_FULL_E2E_PASSED$' "$WORK_DIR/full-e2e.log"; then
  die "full E2E failed"
fi
jq '.fullE2e = "passed"' "$WORK_DIR/qualification.json" >"$WORK_DIR/qualification.tmp"
mv "$WORK_DIR/qualification.tmp" "$WORK_DIR/qualification.json"
log "Full E2E passed"
