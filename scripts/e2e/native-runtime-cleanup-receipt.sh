#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

receipt_path="${CLEANUP_RECEIPT_PATH:-}"
status="${CLEANUP_STATUS:-}"
stage="${CLEANUP_STAGE:-}"
failed_stage="${FIRST_FAILED_STAGE:-}"
completed_csv="${COMPLETED_STAGES:-}"
account="${ACCOUNT:-}"
uid="${ACCOUNT_UID:-}"
gid="${ACCOUNT_GID:-}"
ownership_marker="${OWNERSHIP_MARKER:-}"
home="${ACCOUNT_HOME:-}"
runtime_directory="${RUNTIME_DIRECTORY:-}"
runtime_directory_unit="${RUNTIME_DIRECTORY_UNIT:-}"
user_manager_unit="${USER_MANAGER_UNIT:-}"
user_manager_dropin_directory="${USER_MANAGER_DROPIN_DIRECTORY:-}"
user_manager_dropin="${USER_MANAGER_DROPIN:-}"
storage_config_directory="${STORAGE_CONFIG_DIRECTORY:-}"
storage_config="${STORAGE_CONFIG:-}"
containers_config="${CONTAINERS_CONFIG:-}"
apparmor_profile="${APPARMOR_PROFILE:-}"
pasta_apparmor_profile="${PASTA_APPARMOR_PROFILE:-}"
registry_auth_directory="${REGISTRY_AUTH_DIRECTORY:-}"
registry_auth_file="${REGISTRY_AUTH_FILE:-}"
runner_contract="${RUNNER_CONTRACT:-}"
podman_executable="${PODMAN_EXECUTABLE:-}"
helper_directory="${HELPER_DIRECTORY:-}"
pasta_executable="${PASTA_EXECUTABLE:-}"
resource_directory="${RESOURCE_DIRECTORY:-}"
model_directory="${MODEL_DIRECTORY:-}"

validate_path() {
  local label="$1"
  local value="$2"
  [[ "$value" == /* && "$value" != *$'\n'* && "$value" != *"/../"* &&
    "$value" != *"/./"* && "$value" != */.. && "$value" != */. ]] \
    || fail "$label must be a normalized absolute path"
}

validate_optional_path() {
  [[ -z "$2" ]] || validate_path "$1" "$2"
}

validate_unit() {
  [[ -z "$2" || "$2" =~ ^[A-Za-z0-9_.@-]+$ ]] \
    || fail "$1 must be a systemd unit name"
}

[[ "$receipt_path" == /* ]] || fail "cleanup receipt path must be absolute"
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ ]] || fail "cleanup receipt run ID is invalid"
[[ "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || fail "cleanup receipt run attempt is invalid"
[[ -z "$account" || "$account" == "nemoclawq" ]] || fail "cleanup receipt account is invalid"
if [[ -n "$uid" || -n "$gid" ]]; then
  [[ "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ ]] \
    || fail "cleanup receipt account identity is invalid"
fi
validate_path "cleanup receipt ownership marker" "$ownership_marker"
for path_name in \
  home \
  runtime_directory \
  user_manager_dropin_directory \
  user_manager_dropin \
  storage_config_directory \
  storage_config \
  containers_config \
  apparmor_profile \
  pasta_apparmor_profile \
  registry_auth_directory \
  registry_auth_file \
  runner_contract \
  podman_executable \
  helper_directory \
  pasta_executable \
  resource_directory \
  model_directory; do
  validate_optional_path "cleanup receipt ${path_name//_/-}" "${!path_name}"
  if [[ -n "$uid" && -z "${!path_name}" ]]; then
    fail "cleanup receipt ${path_name//_/-} is required for an identified account"
  fi
done
validate_unit "cleanup receipt runtime-directory unit" "$runtime_directory_unit"
validate_unit "cleanup receipt user-manager unit" "$user_manager_unit"
if [[ -n "$uid" && (-z "$runtime_directory_unit" || -z "$user_manager_unit") ]]; then
  fail "cleanup receipt systemd units are required for an identified account"
fi
[[ "$stage" =~ ^[a-z][a-z0-9-]*$ ]] || fail "cleanup receipt stage is invalid"
case "$status" in
  failed)
    [[ "$failed_stage" == "$stage" ]] \
      || fail "failed cleanup receipt must identify its current stage"
    ;;
  in-progress | success)
    [[ -z "$failed_stage" ]] || fail "non-failed cleanup receipt cannot name a failed stage"
    ;;
  *) fail "cleanup receipt status is invalid" ;;
esac

seen_stages=","
remaining_stages="$completed_csv"
while [[ -n "$remaining_stages" ]]; do
  if [[ "$remaining_stages" == *,* ]]; then
    completed_stage="${remaining_stages%%,*}"
    remaining_stages="${remaining_stages#*,}"
  else
    completed_stage="$remaining_stages"
    remaining_stages=""
  fi
  [[ -n "$completed_stage" ]] || fail "completed cleanup receipt stage is invalid"
  [[ "$completed_stage" =~ ^[a-z][a-z0-9-]*$ ]] \
    || fail "completed cleanup receipt stage is invalid"
  [[ "$seen_stages" != *",${completed_stage},"* ]] \
    || fail "cleanup receipt contains a duplicate completed stage"
  seen_stages+="${completed_stage},"
done

receipt_directory="$(dirname "$receipt_path")"
install -d -m 0700 "$receipt_directory"
[[ -d "$receipt_directory" && ! -L "$receipt_directory" ]] \
  || fail "cleanup receipt directory is invalid"
[[ ! -L "$receipt_path" ]] || fail "cleanup receipt target must not be a symbolic link"
temporary_path="${receipt_path}.tmp.$$"
[[ ! -e "$temporary_path" && ! -L "$temporary_path" ]] \
  || fail "cleanup receipt temporary target already exists"
trap 'rm -f -- "$temporary_path"' EXIT
umask 077
jq -n \
  --arg account "$account" \
  --arg apparmorProfile "$apparmor_profile" \
  --arg completed "$completed_csv" \
  --arg containersConfig "$containers_config" \
  --arg failedStage "$failed_stage" \
  --arg gid "$gid" \
  --arg helperDirectory "$helper_directory" \
  --arg home "$home" \
  --arg ownershipMarker "$ownership_marker" \
  --arg modelDirectory "$model_directory" \
  --arg pastaApparmorProfile "$pasta_apparmor_profile" \
  --arg pastaExecutable "$pasta_executable" \
  --arg podmanExecutable "$podman_executable" \
  --arg registryAuthDirectory "$registry_auth_directory" \
  --arg registryAuthFile "$registry_auth_file" \
  --arg resourceDirectory "$resource_directory" \
  --arg runnerContract "$runner_contract" \
  --arg runAttempt "$GITHUB_RUN_ATTEMPT" \
  --arg runId "$GITHUB_RUN_ID" \
  --arg runtimeDirectory "$runtime_directory" \
  --arg runtimeDirectoryUnit "$runtime_directory_unit" \
  --arg stage "$stage" \
  --arg status "$status" \
  --arg storageConfig "$storage_config" \
  --arg storageConfigDirectory "$storage_config_directory" \
  --arg uid "$uid" \
  --arg userManagerDropin "$user_manager_dropin" \
  --arg userManagerDropinDirectory "$user_manager_dropin_directory" \
  --arg userManagerUnit "$user_manager_unit" \
  '{
    kind: "nemoclaw-native-runtime-cleanup-receipt-v1",
    run: {id: $runId, attempt: ($runAttempt | tonumber)},
    account: {
      name: (if $account == "" then null else $account end),
      uid: (if $uid == "" then null else ($uid | tonumber) end),
      gid: (if $gid == "" then null else ($gid | tonumber) end)
    },
    cleanup: {
      status: $status,
      currentStage: $stage,
      completedStages: ($completed | split(",") | map(select(length > 0))),
      firstFailedStage: (if $failedStage == "" then null else $failedStage end)
    },
    targets: {
      ownershipMarker: $ownershipMarker,
      home: $home,
      runtimeDirectory: $runtimeDirectory,
      runtimeDirectoryUnit: $runtimeDirectoryUnit,
      userManagerUnit: $userManagerUnit,
      userManagerDropinDirectory: $userManagerDropinDirectory,
      userManagerDropin: $userManagerDropin,
      storageConfigDirectory: $storageConfigDirectory,
      storageConfig: $storageConfig,
      containersConfig: $containersConfig,
      apparmorProfile: $apparmorProfile,
      pastaApparmorProfile: $pastaApparmorProfile,
      registryAuthDirectory: $registryAuthDirectory,
      registryAuthFile: $registryAuthFile,
      runnerContract: $runnerContract,
      podmanExecutable: $podmanExecutable,
      helperDirectory: $helperDirectory,
      pastaExecutable: $pastaExecutable,
      resourceDirectory: $resourceDirectory,
      modelDirectory: $modelDirectory
    }
  }' >"$temporary_path"
chmod 0600 "$temporary_path"
mv -f -- "$temporary_path" "$receipt_path"
trap - EXIT
