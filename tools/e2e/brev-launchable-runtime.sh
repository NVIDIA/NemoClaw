#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

die() {
  printf 'BREV_LAUNCHABLE_E2E_FAILED: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || die "$name is required"
}

validate_common() {
  require_env WORK_DIR
  require_env INSTANCE_NAME
  [[ "$INSTANCE_NAME" =~ ^[a-z][a-z0-9-]{0,62}$ ]] \
    || die "INSTANCE_NAME must be a lowercase Brev workspace name"
  [ -d "$WORK_DIR" ] || die "WORK_DIR must already exist"
  command -v brev >/dev/null 2>&1 || die "brev is required"
  command -v jq >/dev/null 2>&1 || die "jq is required"
  command -v timeout >/dev/null 2>&1 || die "timeout is required"
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
  die "Brev workspace did not become ready before the deadline"
}

deploy() {
  validate_common
  require_env BREV_LAUNCHABLE_ID
  [[ "$BREV_LAUNCHABLE_ID" =~ ^env-[A-Za-z0-9]+$ ]] \
    || die "BREV_LAUNCHABLE_ID must be one opaque env-* ID"
  local existing
  existing="$(workspace_record)" || die "unable to inventory Brev workspaces before deploy"
  [ -z "$existing" ] || die "refusing to reuse pre-existing workspace $INSTANCE_NAME"

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
  [[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || die "CANDIDATE_SHA must be a lowercase full SHA"

  local provision repo_sha identity
  provision="$(host_exec 'sudo -n cat /etc/nemoclaw/provision.json')"
  provision="$(tail -n 1 <<<"$provision")"
  jq -e 'type == "object" and (.gitSha | type == "string")' <<<"$provision" >/dev/null \
    || die "the baked provision metadata is missing or malformed"
  printf '%s\n' "$provision" >"$WORK_DIR/brev-provision.json"

  # HOME is expanded by the remote host shell.
  # shellcheck disable=SC2016
  repo_sha="$(host_exec 'set -euo pipefail
    repo="$HOME/NemoClaw"
    test -d "$repo/.git"
    git -C "$repo" diff --quiet --no-ext-diff HEAD --
    git -C "$repo" diff --cached --quiet --no-ext-diff HEAD --
    git -C "$repo" rev-parse HEAD' | tail -n 1)"
  [ "$repo_sha" = "$CANDIDATE_SHA" ] \
    || die "baked NemoClaw SHA $repo_sha does not match candidate $CANDIDATE_SHA"
  [[ "$CANDIDATE_SHA" == "$(jq -r '.gitSha' <<<"$provision")"* ]] \
    || die "provision metadata does not identify candidate $CANDIDATE_SHA"

  # Metadata variables are expanded by the remote host shell. The image labels
  # are the producer contract; the disk and image API responses are independent
  # observations of what the Launchable actually booted.
  # shellcheck disable=SC2016
  identity="$(host_exec 'set -euo pipefail
    metadata=http://metadata.google.internal/computeMetadata/v1
    header="Metadata-Flavor: Google"
    project=$(curl -fsS -H "$header" "$metadata/project/project-id")
    zone_path=$(curl -fsS -H "$header" "$metadata/instance/zone")
    zone=${zone_path##*/}
    disk=$(curl -fsS -H "$header" "$metadata/instance/disks/0/device-name")
    token=$(curl -fsS -H "$header" "$metadata/instance/service-accounts/default/token" | jq -er .access_token)
    disk_json=$(curl -fsS -H "Authorization: Bearer $token" \
      "https://compute.googleapis.com/compute/v1/projects/$project/zones/$zone/disks/$disk")
    image_url=$(jq -er .sourceImage <<<"$disk_json")
    image_json=$(curl -fsS -H "Authorization: Bearer $token" "$image_url")
    jq -cn --argjson disk "$disk_json" --argjson image "$image_json" \
      "{disk:{sourceImage:\$disk.sourceImage,sourceImageId:(\$disk.sourceImageId|tostring)},image:{name:\$image.name,id:(\$image.id|tostring),selfLink:\$image.selfLink,status:\$image.status,labels:\$image.labels}}"' | tail -n 1)"
  jq -e --arg sha "$CANDIDATE_SHA" '
    .disk.sourceImage == .image.selfLink
    and .disk.sourceImageId == .image.id
    and .image.status == "READY"
    and .image.labels["nemoclaw-sha"] == $sha
    and .image.labels.channel == "staging"
    and .image.labels.variant == "cpu"
  ' <<<"$identity" >/dev/null \
    || die "workspace boot image does not match the exact staging image for $CANDIDATE_SHA"
  printf '%s\n' "$identity" >"$WORK_DIR/brev-boot-image.json"

  jq -n \
    --arg candidateSha "$CANDIDATE_SHA" \
    --arg repositorySha "$repo_sha" \
    --argjson bootImage "$identity" \
    --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion:1,candidateSha:$candidateSha,repositorySha:$repositorySha,bootImage:$bootImage,verifiedAt:$verifiedAt}' \
    >"$WORK_DIR/brev-identity-evidence.json"
}

run_existing_e2e() {
  require_env NVIDIA_INFERENCE_API_KEY
  local sandbox="${NEMOCLAW_STAGING_SANDBOX_NAME:-e2e-staging}"
  [[ "$sandbox" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || die "invalid staging sandbox name"
  local remote_artifact_dir="/tmp/nemoclaw-launchable-e2e-$INSTANCE_NAME"
  local local_artifact_dir="$WORK_DIR/brev-launchable-cloud-openclaw"
  local result_relative="brev-launchable-cloud-openclaw-onboard-inference-cli-operations-and-cleanup/target-result.json"
  local quoted_artifact_dir quoted_key quoted_sandbox
  printf -v quoted_artifact_dir '%q' "$remote_artifact_dir"
  printf -v quoted_key '%q' "$NVIDIA_INFERENCE_API_KEY"
  printf -v quoted_sandbox '%q' "$sandbox"

  # Escaped values and model checks are evaluated by the remote host shell.
  # shellcheck disable=SC1083,SC2140
  host_exec "set -euo pipefail
    cd \"\$HOME/NemoClaw\"
    test -x ./node_modules/.bin/vitest
    rm -rf -- $quoted_artifact_dir
    install -d -m 700 $quoted_artifact_dir
    model=\$(node /usr/local/lib/nemoclaw/launchable-config.mjs /usr/local/share/nemoclaw/launchable-agents.json openclaw cloudModel)
    case \"\$model\" in
      [A-Za-z0-9]* ) ;;
      * ) printf 'Launchable cloud model is not a safe model ID\n' >&2; exit 1 ;;
    esac
    case \"\$model\" in
      *[!A-Za-z0-9._:/-]* ) printf 'Launchable cloud model is not a safe model ID\n' >&2; exit 1 ;;
    esac
    export CI=true GITHUB_ACTIONS=true
    export E2E_ARTIFACT_DIR=$quoted_artifact_dir
    export E2E_TARGET_ID=brev-launchable-cloud-openclaw
    export NEMOCLAW_CLI_BIN=nemoclaw
    export NEMOCLAW_E2E_SECURITY_POSTURE=1
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
  local result="$local_artifact_dir/$result_relative"
  [ -f "$result" ] && [ ! -L "$result" ] || die "full E2E result is missing"
  jq -e '
    .id == "brev-launchable-cloud-openclaw"
    and .runner == "vitest"
    and .status == "passed"
    and .firstAgentTurn.status == "passed"
    and .securityPosture.configureGuard == true
    and .securityPosture.hostNonRoot == true
    and .securityPosture.rcFilesLocked == true
    and .securityPosture.runtimeProxyEnvLocked == true
    and .securityPosture.startupLogClean == true
  ' "$result" >/dev/null || die "full E2E result did not pass"

  jq -n \
    --arg target "brev-launchable-cloud-openclaw" \
    --arg testFile "test/e2e/live/full-e2e.test.ts" \
    --arg targetResultSha256 "$(sha256sum "$result" | awk '{print $1}')" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion:1,target:$target,testFile:$testFile,setupMode:"preinstalled-launchable",targetResultSha256:$targetResultSha256,completedAt:$completedAt}' \
    >"$WORK_DIR/brev-launchable-e2e-evidence.json"
}

run_e2e() {
  validate_common
  verify_identity
  run_existing_e2e
}

cleanup() {
  validate_common
  local requested_at deadline record absent_count=0
  requested_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  record="$(workspace_record || true)"
  if [ -n "$record" ]; then
    timeout 60s brev delete "$INSTANCE_NAME" || true
  fi

  deadline=$((SECONDS + ${BREV_DELETE_TIMEOUT_SECONDS:-600}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if record="$(workspace_record)"; then
      if [ -z "$record" ]; then
        absent_count=$((absent_count + 1))
        if [ "$absent_count" -ge "${BREV_ABSENCE_CONFIRMATIONS:-2}" ]; then
          jq -n \
            --arg workspaceName "$INSTANCE_NAME" \
            --arg requestedAt "$requested_at" \
            --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '{schemaVersion:1,workspaceName:$workspaceName,deleteRequestedAt:$requestedAt,terminalState:"ABSENT",verifiedAt:$verifiedAt}' \
            >"$WORK_DIR/brev-cleanup-evidence.json"
          return 0
        fi
      else
        absent_count=0
      fi
    fi
    timeout 30s brev refresh >/dev/null 2>&1 || true
    sleep "${BREV_POLL_SECONDS:-15}"
  done
  die "Brev workspace still exists after cleanup deadline"
}

case "${1:-}" in
  deploy) deploy ;;
  run) run_e2e ;;
  cleanup) cleanup ;;
  *) die "usage: $0 deploy|run|cleanup" ;;
esac
