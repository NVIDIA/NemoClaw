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

[[ "$receipt_path" == /* ]] || fail "cleanup receipt path must be absolute"
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ ]] || fail "cleanup receipt run ID is invalid"
[[ "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || fail "cleanup receipt run attempt is invalid"
[[ -z "$account" || "$account" == "nemoclawq" ]] || fail "cleanup receipt account is invalid"
if [[ -n "$uid" || -n "$gid" ]]; then
  [[ "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ ]] \
    || fail "cleanup receipt account identity is invalid"
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

ownership_marker="/run/nemoclaw-native-runtime-owner-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
home=""
runtime_directory=""
runtime_directory_unit=""
user_manager_unit=""
user_manager_dropin_directory=""
user_manager_dropin=""
storage_config_directory=""
podman_executable=""
helper_directory=""
resource_directory=""
if [[ -n "$uid" ]]; then
  home="/home/nemoclawq"
  runtime_directory="/run/user/${uid}"
  runtime_directory_unit="user-runtime-dir@${uid}.service"
  user_manager_unit="user@${uid}.service"
  user_manager_dropin_directory="/run/systemd/system/${user_manager_unit}.d"
  user_manager_dropin="${user_manager_dropin_directory}/50-nemoclaw-native-runtime.conf"
  storage_config_directory="/run/nemoclaw-native-runtime-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"
  podman_executable="/nemoclaw-native-runtime-podman-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"
  helper_directory="/nemoclaw-native-runtime-helpers-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"
  resource_directory="/var/tmp/nemoclaw-native-runtime-resources-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"
fi

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
  --arg completed "$completed_csv" \
  --arg failedStage "$failed_stage" \
  --arg gid "$gid" \
  --arg helperDirectory "$helper_directory" \
  --arg home "$home" \
  --arg ownershipMarker "$ownership_marker" \
  --arg podmanExecutable "$podman_executable" \
  --arg resourceDirectory "$resource_directory" \
  --arg runAttempt "$GITHUB_RUN_ATTEMPT" \
  --arg runId "$GITHUB_RUN_ID" \
  --arg runtimeDirectory "$runtime_directory" \
  --arg runtimeDirectoryUnit "$runtime_directory_unit" \
  --arg stage "$stage" \
  --arg status "$status" \
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
      storageConfig: (if $storageConfigDirectory == "" then "" else ($storageConfigDirectory + "/storage.conf") end),
      containersConfig: (if $storageConfigDirectory == "" then "" else ($storageConfigDirectory + "/containers.conf") end),
      apparmorProfile: (if $storageConfigDirectory == "" then "" else ($storageConfigDirectory + "/podman.apparmor") end),
      pastaApparmorProfile: (if $storageConfigDirectory == "" then "" else ($storageConfigDirectory + "/pasta.apparmor") end),
      registryAuthDirectory: (if $storageConfigDirectory == "" then "" else ($storageConfigDirectory + "/registry-auth") end),
      registryAuthFile: (if $storageConfigDirectory == "" then "" else ($storageConfigDirectory + "/registry-auth/auth.json") end),
      runnerContract: (if $storageConfigDirectory == "" then "" else ($storageConfigDirectory + "/runner-contract.json") end),
      podmanExecutable: $podmanExecutable,
      helperDirectory: $helperDirectory,
      pastaExecutable: (if $helperDirectory == "" then "" else ($helperDirectory + "/pasta") end),
      resourceDirectory: $resourceDirectory,
      modelDirectory: (if $resourceDirectory == "" then "" else ($resourceDirectory + "/model") end)
    }
  }' >"$temporary_path"
chmod 0600 "$temporary_path"
mv -f -- "$temporary_path" "$receipt_path"
trap - EXIT
