#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

die() {
  printf 'BREV_LAUNCHABLE_QUALIFICATION_FAILED: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || die "$name is required"
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
}

validate_common() {
  require_env WORK_DIR
  require_env INSTANCE_NAME
  [[ "$INSTANCE_NAME" =~ ^[a-z][a-z0-9-]{0,62}$ ]] \
    || die "INSTANCE_NAME must be a lowercase Brev workspace name"
  [ -d "$WORK_DIR" ] || die "WORK_DIR must already exist"
  require_tools brev jq timeout
}

workspace_rows() {
  timeout 30s brev ls --json | jq -c '
    if type == "array" then .
    elif type == "object" and (.workspaces | type) == "array" then .workspaces
    else error("unexpected brev ls --json shape")
    end
  '
}

workspace_record() {
  workspace_rows | jq -c --arg name "$INSTANCE_NAME" '
    map(select(((.name // .workspaceName // .instanceName // .Name // "") | tostring) == $name))
    | if length == 0 then empty
      elif length == 1 then .[0]
      else error("workspace name is ambiguous")
      end
  '
}

wait_for_workspace_ready() {
  local deadline=$((SECONDS + ${BREV_READY_TIMEOUT_SECONDS:-1200}))
  local record status shell_status health_status build_status
  while [ "$SECONDS" -lt "$deadline" ]; do
    record="$(workspace_record || true)"
    if [ -n "$record" ]; then
      status="$(jq -r '.status // ""' <<<"$record")"
      shell_status="$(jq -r '.shell_status // .shellStatus // ""' <<<"$record")"
      health_status="$(jq -r '.health_status // .healthStatus // ""' <<<"$record")"
      build_status="$(jq -r '.build_status // .buildStatus // ""' <<<"$record")"
      if [ "$status" = "RUNNING" ] && [ "$shell_status" = "READY" ] \
        && [ "$health_status" = "HEALTHY" ] && [ "$build_status" = "COMPLETED" ]; then
        printf '%s\n' "$record" >"$WORK_DIR/brev-workspace-ready.json"
        return 0
      fi
      case "$status:$build_status" in
        FAILED:* | ERROR:* | *:FAILED | *:ERROR) die "Brev workspace entered terminal failure ($status/$build_status)" ;;
      esac
    fi
    sleep "${BREV_POLL_SECONDS:-15}"
  done
  die "Brev workspace did not become structurally ready before the deadline"
}

deploy() {
  validate_common
  local existing
  require_env BREV_LAUNCHABLE_ID
  [[ "$BREV_LAUNCHABLE_ID" =~ ^env-[A-Za-z0-9]+$ ]] \
    || die "BREV_LAUNCHABLE_ID must be one opaque env-* ID"
  if ! existing="$(workspace_record)"; then
    die "unable to inventory Brev workspaces before deploy"
  fi
  if [ -n "$existing" ]; then
    die "refusing to reuse pre-existing workspace $INSTANCE_NAME"
  fi
  printf '{"schemaVersion":1,"launchableId":%s,"workspaceName":%s,"requestedAt":%s}\n' \
    "$(jq -Rn --arg value "$BREV_LAUNCHABLE_ID" '$value')" \
    "$(jq -Rn --arg value "$INSTANCE_NAME" '$value')" \
    "$(jq -Rn --arg value "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '$value')" \
    >"$WORK_DIR/brev-deploy-request.json"
  timeout "${BREV_CREATE_TIMEOUT_SECONDS:-900}" \
    brev create "$INSTANCE_NAME" --launchable "$BREV_LAUNCHABLE_ID" --detached \
    --timeout "${BREV_CREATE_TIMEOUT_SECONDS:-900}"
  wait_for_workspace_ready
}

host_exec() {
  local command="$1"
  timeout "${BREV_HOST_COMMAND_TIMEOUT_SECONDS:-1800}" \
    brev exec "$INSTANCE_NAME" --host "$command"
}

verify_identity() {
  require_env CANDIDATE_SHA
  [[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "CANDIDATE_SHA must be a lowercase full SHA"
  require_env VALIDATED_MANIFEST
  [ -f "$VALIDATED_MANIFEST" ] || die "VALIDATED_MANIFEST is missing"

  local expected_image expected_image_id expected_self_link repo_sha provision provision_sha disk_json
  expected_image="$(jq -er '.imageName' "$VALIDATED_MANIFEST")"
  expected_image_id="$(jq -er '.imageId' "$VALIDATED_MANIFEST")"
  expected_self_link="$(jq -er '.imageSelfLink' "$VALIDATED_MANIFEST")"

  provision="$(host_exec 'sudo -n cat /etc/nemoclaw/provision.json')"
  jq -e 'type == "object" and (.gitSha | type == "string")' <<<"$provision" >/dev/null \
    || die "the baked provision metadata is missing or malformed"
  printf '%s\n' "$provision" >"$WORK_DIR/brev-provision.json"
  provision_sha="$(jq -r '.gitSha' <<<"$provision")"
  [[ "$provision_sha" =~ ^[0-9a-f]{7,40}$ ]] \
    || die "provision metadata SHA must be a lowercase Git SHA"

  # HOME and repo are intentionally expanded by the remote host shell.
  # shellcheck disable=SC2016
  repo_sha="$(host_exec 'set -e; repo="$HOME/NemoClaw"; test -d "$repo/.git"; git -C "$repo" rev-parse HEAD' | tail -n 1)"
  [ "$repo_sha" = "$CANDIDATE_SHA" ] \
    || die "baked NemoClaw SHA $repo_sha does not match candidate $CANDIDATE_SHA"
  [[ "$CANDIDATE_SHA" == "$provision_sha"* ]] \
    || die "provision metadata SHA $provision_sha does not identify candidate $CANDIDATE_SHA"

  # Metadata variables are intentionally expanded by the remote host shell.
  # shellcheck disable=SC2016
  disk_json="$(host_exec 'set -euo pipefail
    metadata=http://metadata.google.internal/computeMetadata/v1
    header="Metadata-Flavor: Google"
    project=$(curl -fsS -H "$header" "$metadata/project/project-id")
    zone_path=$(curl -fsS -H "$header" "$metadata/instance/zone")
    zone=${zone_path##*/}
    disk=$(curl -fsS -H "$header" "$metadata/instance/disks/0/device-name")
    token=$(curl -fsS -H "$header" "$metadata/instance/service-accounts/default/token" | jq -er .access_token)
    curl -fsS -H "Authorization: Bearer $token" \
      "https://compute.googleapis.com/compute/v1/projects/$project/zones/$zone/disks/$disk" \
      | jq -c "{sourceImage,sourceImageId}"')"
  disk_json="$(tail -n 1 <<<"$disk_json")"
  jq -e --arg image "$expected_self_link" --arg id "$expected_image_id" '
    .sourceImage == $image and ((.sourceImageId | tostring) == $id)
  ' <<<"$disk_json" >/dev/null \
    || die "workspace boot disk does not match accepted image $expected_image ($expected_image_id)"
  printf '%s\n' "$disk_json" >"$WORK_DIR/brev-boot-image.json"

  jq -n \
    --arg candidateSha "$CANDIDATE_SHA" \
    --arg repositorySha "$repo_sha" \
    --arg provisionSha "$provision_sha" \
    --arg imageName "$expected_image" \
    --arg imageId "$expected_image_id" \
    --arg imageSelfLink "$expected_self_link" \
    --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion:1,candidateSha:$candidateSha,repositorySha:$repositorySha,provisionSha:$provisionSha,image:{name:$imageName,id:$imageId,selfLink:$imageSelfLink},verifiedAt:$verifiedAt}' \
    >"$WORK_DIR/brev-identity-evidence.json"
}

run_existing_e2e() {
  require_env NVIDIA_INFERENCE_API_KEY
  local sandbox="${NEMOCLAW_STAGING_SANDBOX_NAME:-e2e-staging}"
  [[ "$sandbox" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || die "invalid staging sandbox name"
  local remote_artifact_dir="/tmp/nemoclaw-launchable-e2e-$INSTANCE_NAME"
  local local_artifact_dir="$WORK_DIR/brev-launchable-cloud-openclaw"
  local quoted_artifact_dir quoted_key quoted_sandbox
  printf -v quoted_artifact_dir '%q' "$remote_artifact_dir"
  printf -v quoted_key '%q' "$NVIDIA_INFERENCE_API_KEY"
  printf -v quoted_sandbox '%q' "$sandbox"

  host_exec "set -euo pipefail
    repo=\$HOME/NemoClaw
    cd \"\$repo\"
    test -x ./node_modules/.bin/vitest
    grep -q 'NEMOCLAW_E2E_SETUP_MODE' test/e2e/live/full-e2e.test.ts \
      || { printf 'candidate full-e2e.test.ts does not support preinstalled Launchable setup\n' >&2; exit 1; }
    grep -q 'brev-launchable-cloud-openclaw' test/e2e/live/full-e2e.test.ts \
      || { printf 'candidate full-e2e.test.ts does not declare the Brev Launchable target\n' >&2; exit 1; }
    rm -rf -- $quoted_artifact_dir
    install -d -m 700 $quoted_artifact_dir
    model=\$(node /usr/local/lib/nemoclaw/launchable-config.mjs /usr/local/share/nemoclaw/launchable-agents.json openclaw cloudModel)
    export CI=true GITHUB_ACTIONS=true
    export E2E_ARTIFACT_DIR=$quoted_artifact_dir
    export E2E_TARGET_ID=brev-launchable-cloud-openclaw
    export NEMOCLAW_CLI_BIN=nemoclaw
    export NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable
    export NEMOCLAW_MODEL=\"\$model\"
    export NEMOCLAW_RUN_LIVE_E2E=1
    export NEMOCLAW_SANDBOX_NAME=$quoted_sandbox
    export NVIDIA_INFERENCE_API_KEY=$quoted_key
    ./node_modules/.bin/vitest run --project e2e-live test/e2e/live/full-e2e.test.ts --silent=false --reporter=default" \
    >"$WORK_DIR/brev-launchable-e2e.log" 2>&1

  mkdir -m 700 "$local_artifact_dir"
  timeout "${BREV_COPY_TIMEOUT_SECONDS:-300}" \
    brev copy "$INSTANCE_NAME:$remote_artifact_dir/" "$local_artifact_dir/" --host

  local target_result
  target_result="$(find "$local_artifact_dir" -type f -name target-result.json -print -quit)"
  [ -n "$target_result" ] || die "the existing full E2E suite did not produce target-result.json"
  jq -e '.id == "brev-launchable-cloud-openclaw" and .status == "passed" and .runner == "vitest"' \
    "$target_result" >/dev/null \
    || die "the existing full E2E suite did not produce passing Launchable evidence"

  jq -n \
    --arg sandbox "$sandbox" \
    --arg target "brev-launchable-cloud-openclaw" \
    --arg testFile "test/e2e/live/full-e2e.test.ts" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion:1,target:$target,testFile:$testFile,setupMode:"preinstalled-launchable",sandbox:$sandbox,completedAt:$completedAt}' \
    >"$WORK_DIR/brev-launchable-e2e-evidence.json"
}

qualify() {
  validate_common
  verify_identity
  run_existing_e2e
}

cleanup() {
  validate_common
  local requested_at verified_at deadline output record status=0 absent_count=0
  requested_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if record="$(workspace_record)"; then
    if [ -n "$record" ]; then
      output="$(timeout 60s brev delete "$INSTANCE_NAME" 2>&1)" || status=$?
      printf '%s\n' "$output"
      [ "$status" -eq 0 ] || printf 'brev delete returned %s; verifying absence before failing\n' "$status" >&2
    fi
  else
    printf 'brev ls failed before cleanup; verifying absence with retries\n' >&2
  fi
  deadline=$((SECONDS + ${BREV_DELETE_TIMEOUT_SECONDS:-600}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if record="$(workspace_record)"; then
      if [ -n "$record" ]; then
        absent_count=0
        timeout 30s brev refresh >/dev/null 2>&1 || true
        sleep "${BREV_POLL_SECONDS:-15}"
        continue
      fi
      absent_count=$((absent_count + 1))
      if [ "$absent_count" -lt "${BREV_ABSENCE_CONFIRMATIONS:-4}" ]; then
        timeout 30s brev refresh >/dev/null 2>&1 || true
        sleep "${BREV_POLL_SECONDS:-15}"
        continue
      fi
      verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      jq -n --arg workspaceName "$INSTANCE_NAME" --arg requestedAt "$requested_at" --arg verifiedAt "$verified_at" \
        '{schemaVersion:1,workspaceName:$workspaceName,deleteRequestedAt:$requestedAt,terminalState:"ABSENT",verifiedAt:$verifiedAt}' \
        >"$WORK_DIR/brev-cleanup-evidence.json"
      return 0
    fi
    printf 'brev ls failed while verifying cleanup; retrying\n' >&2
    timeout 30s brev refresh >/dev/null 2>&1 || true
    sleep "${BREV_POLL_SECONDS:-15}"
  done
  die "Brev workspace still exists after cleanup deadline"
}

case "${1:-}" in
  deploy) deploy ;;
  qualify) qualify ;;
  cleanup) cleanup ;;
  *) die "usage: $0 deploy|qualify|cleanup" ;;
esac
