#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022

fixed_origin=https://github.com/NVIDIA/NemoClaw.git
deploy_root=/opt/nemoclaw-jetson-dispatch
releases_directory="$deploy_root/releases"
current_link="$deploy_root/current"
deploy_lock="$deploy_root/deploy.lock"
cleanup_relative=tools/e2e/jetson-dispatch-cleanup.sh
environment_relative=tools/e2e/colossus-jetson-dispatch.environment
unit_relative=tools/e2e/nemoclaw-jetson-dispatch.service
cleanup_executable=/usr/local/libexec/nemoclaw-jetson-cleanup
cleanup_link_target="$current_link/$cleanup_relative"
service_user=nemoclaw-jetson-dispatch
service_group=nemoclaw-jetson-dispatch
service_home=/var/lib/nemoclaw-jetson-dispatch
state_directory="$service_home/state"
device_lock="$state_directory/device.lock"
ssh_identity_file="$service_home/id_ed25519"
ssh_known_hosts_file="$service_home/known_hosts"
node_executable=/usr/bin/node
service_name=nemoclaw-jetson-dispatch.service
environment_file=/etc/nemoclaw-jetson-dispatch/environment
unit_file="/etc/systemd/system/$service_name"
tunnel_service_name=nemoclaw-jetson-tunnel.service
service_port=8787

staging_directory=""
temporary_link=""
cleanup_stage=""
managed_file_stage=""
bootstrap_environment_installed=0
bootstrap_unit_installed=0
bootstrap_daemon_reloaded=0
bootstrap_enable_attempted=0

usage() {
  echo "Usage: nemoclaw-colossus-jetson-dispatch-deploy --commit <full lowercase 40-character SHA>" >&2
}

fail() {
  echo "Colossus Jetson dispatcher deployment failed: $*" >&2
  exit 1
}

effective_uid() {
  /usr/bin/id -u
}

git_exec() {
  /usr/bin/env \
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
    -u GIT_COMMON_DIR \
    -u GIT_CONFIG_PARAMETERS \
    -u GIT_DIR \
    -u GIT_EXEC_PATH \
    -u GIT_OBJECT_DIRECTORY \
    -u GIT_PROXY_COMMAND \
    -u GIT_SSH \
    -u GIT_SSH_COMMAND \
    -u GIT_SSL_NO_VERIFY \
    -u GIT_TEMPLATE_DIR \
    -u GIT_WORK_TREE \
    GIT_CONFIG_COUNT=0 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    HOME=/nonexistent \
    /usr/bin/git \
    -c core.hooksPath=/dev/null \
    -c credential.helper= \
    -c http.sslVerify=true \
    -c protocol.ext.allow=never \
    -c protocol.file.allow=never \
    "$@"
}

systemctl_exec() {
  /usr/bin/systemctl "$@"
}

ss_exec() {
  /usr/bin/ss "$@"
}

curl_exec() {
  /usr/bin/curl "$@"
}

sleep_exec() {
  /usr/bin/sleep "$@"
}

id_exec() {
  /usr/bin/id "$@"
}

ssh_keygen_exec() {
  /usr/bin/ssh-keygen "$@"
}

install_file() {
  /usr/bin/install -o root -g root -m "$3" "$1" "$2"
}

files_match() {
  /usr/bin/cmp -s "$1" "$2"
}

symlink_owner() {
  /usr/bin/stat -c '%u:%g' "$1"
}

install_directory() {
  local path="$1" mode="$2"
  /usr/bin/install -d -o root -g root -m "$mode" "$path"
}

move_replace() {
  /usr/bin/mv -Tf -- "$1" "$2"
}

move_directory() {
  /usr/bin/mv -- "$1" "$2"
}

require_root_owned_directory() {
  local path="$1" expected_mode="$2" metadata
  if [ ! -d "$path" ] || [ -L "$path" ]; then
    fail "$path must be a directory, not a symbolic link"
  fi
  metadata="$(/usr/bin/stat -c '%u:%g:%a' "$path")" || fail "could not inspect $path"
  if [ "$metadata" != "0:0:$expected_mode" ]; then
    fail "$path must be owned by root:root with mode $expected_mode"
  fi
}

require_root_owned_file() {
  local path="$1" expected_mode="$2" metadata
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    fail "$path must be a regular file, not a symbolic link"
  fi
  metadata="$(/usr/bin/stat -c '%u:%g:%a' "$path")" || fail "could not inspect $path"
  if [ "$metadata" != "0:0:$expected_mode" ]; then
    fail "$path must be owned by root:root with mode $expected_mode"
  fi
}

root_owned_file_matches() {
  local path="$1" expected_mode="$2" metadata
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  metadata="$(/usr/bin/stat -c '%u:%g:%a' "$path")" || return 1
  [ "$metadata" = "0:0:$expected_mode" ]
}

require_service_owned_file() {
  local path="$1" expected_mode="$2" uid gid metadata
  uid="$(id_exec -u "$service_user")" || fail "could not inspect the $service_user account"
  gid="$(id_exec -g "$service_user")" || fail "could not inspect the $service_group group"
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    fail "$path must be a regular file, not a symbolic link"
  fi
  metadata="$(/usr/bin/stat -c '%u:%g:%a' "$path")" || fail "could not inspect $path"
  [ "$metadata" = "$uid:$gid:$expected_mode" ] \
    || fail "$path must be owned by $service_user:$service_group with mode $expected_mode"
}

require_service_owned_directory() {
  local path="$1" expected_mode="$2" uid gid metadata
  uid="$(id_exec -u "$service_user")" || fail "could not inspect the $service_user account"
  gid="$(id_exec -g "$service_user")" || fail "could not inspect the $service_group group"
  if [ ! -d "$path" ] || [ -L "$path" ]; then
    fail "$path must be a directory, not a symbolic link"
  fi
  metadata="$(/usr/bin/stat -c '%u:%g:%a' "$path")" || fail "could not inspect $path"
  [ "$metadata" = "$uid:$gid:$expected_mode" ] \
    || fail "$path must be owned by $service_user:$service_group with mode $expected_mode"
}

ssh_identity_is_valid() {
  ssh_keygen_exec -y -P '' -f "$ssh_identity_file" >/dev/null 2>&1
}

known_hosts_has_jetson() {
  ssh_keygen_exec -F 192.168.55.1 -f "$ssh_known_hosts_file" >/dev/null 2>&1
}

node_version_is_supported() {
  "$node_executable" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
  '
}

validate_dispatcher_prerequisites() {
  local uid gid
  uid="$(id_exec -u "$service_user")" || fail "the $service_user account is required"
  gid="$(id_exec -g "$service_user")" || fail "the $service_group group is required"
  [[ "$uid" =~ ^[1-9][0-9]*$ ]] || fail "$service_user must not use UID 0"
  [[ "$gid" =~ ^[1-9][0-9]*$ ]] || fail "$service_group must not use GID 0"

  require_service_owned_directory "$service_home" 700
  require_service_owned_file "$ssh_identity_file" 600
  ssh_identity_is_valid \
    || fail "$ssh_identity_file is not a readable OpenSSH private key"
  require_service_owned_file "$ssh_known_hosts_file" 600
  known_hosts_has_jetson \
    || fail "$ssh_known_hosts_file does not contain the pinned Jetson host key"

  [ -x "$node_executable" ] || fail "$node_executable is required"
  node_version_is_supported || fail "$node_executable must be Node.js 22.19.0 or later"
}

cleanup_temporary_paths() {
  if [ -n "$staging_directory" ] && [[ "$staging_directory" == "$releases_directory"/.* ]]; then
    rm -rf -- "$staging_directory"
  fi
  if [ -n "$temporary_link" ] && [[ "$temporary_link" == "$deploy_root"/.current.* ]]; then
    rm -f -- "$temporary_link"
  fi
  if [ -n "$cleanup_stage" ] && [[ "$cleanup_stage" == "${cleanup_executable%/*}"/.nemoclaw-jetson-cleanup.* ]]; then
    rm -f -- "$cleanup_stage"
  fi
  if [ -n "$managed_file_stage" ]; then
    case "$managed_file_stage" in
      "${environment_file%/*}"/.environment.* | "${unit_file%/*}"/.nemoclaw-jetson-dispatch.service.*)
        rm -f -- "$managed_file_stage"
        ;;
    esac
  fi
}

trap cleanup_temporary_paths EXIT

require_root() {
  [ "$(effective_uid)" = 0 ] || fail "this command requires root"
}

parse_commit() {
  if [ "$#" -ne 2 ] || [ "$1" != "--commit" ] || [[ ! "$2" =~ ^[a-f0-9]{40}$ ]]; then
    usage
    exit 2
  fi
  printf '%s\n' "$2"
}

print_stage() {
  printf '[%s/5] %s\n' "$1" "$2"
}

ensure_layout() {
  install_directory "$deploy_root" 0755
  install_directory "$releases_directory" 0755
  install_directory "${cleanup_executable%/*}" 0755
  install_directory "${environment_file%/*}" 0755
  require_root_owned_directory "$deploy_root" 755
  require_root_owned_directory "$releases_directory" 755
  require_root_owned_directory "${cleanup_executable%/*}" 755
  require_root_owned_directory "${environment_file%/*}" 755
  require_root_owned_directory "${unit_file%/*}" 755
}

acquire_deploy_lock() {
  if [ -e "$deploy_lock" ] || [ -L "$deploy_lock" ]; then
    require_root_owned_file "$deploy_lock" 600
  else
    (umask 077 && : >"$deploy_lock")
    chown root:root "$deploy_lock" || fail "could not set deployment-lock ownership"
    chmod 0600 "$deploy_lock" || fail "could not set deployment-lock permissions"
  fi
  exec 9<>"$deploy_lock"
  /usr/bin/flock -n 9 || fail "another deployment is running"
}

verify_release() {
  local release="$1" sha="$2" observed
  require_root_owned_directory "$release" 755
  if ! observed="$(git_exec -C "$release" config --get remote.origin.url)"; then
    fail "could not read the release origin"
  fi
  [ "$observed" = "$fixed_origin" ] || fail "release origin is not $fixed_origin"
  if ! observed="$(git_exec -C "$release" rev-parse --verify HEAD)"; then
    fail "could not read the release commit"
  fi
  [ "$observed" = "$sha" ] || fail "release commit does not match $sha"
  if ! observed="$(git_exec -C "$release" status --porcelain=v1 --untracked-files=all)"; then
    fail "could not inspect the release checkout"
  fi
  [ -z "$observed" ] || fail "release checkout is modified"
  require_root_owned_file "$release/$cleanup_relative" 755
  require_root_owned_file "$release/$environment_relative" 644
  require_root_owned_file "$release/$unit_relative" 644
}

prepare_release() {
  local sha="$1"
  local release="$releases_directory/$sha"
  if [ -e "$release" ] || [ -L "$release" ]; then
    verify_release "$release" "$sha"
    printf '%s\n' "$release"
    return
  fi

  staging_directory="$(/usr/bin/mktemp -d "$releases_directory/.${sha}.XXXXXX")"
  chmod 0755 "$staging_directory" || fail "could not set release-directory permissions"
  git_exec -C "$staging_directory" init --quiet || fail "could not initialize the release checkout"
  if ! git_exec -C "$staging_directory" remote add origin "$fixed_origin"; then
    fail "could not set the fixed release origin"
  fi
  if ! git_exec -C "$staging_directory" fetch --depth=1 --no-tags origin "$sha"; then
    fail "could not fetch commit $sha from the fixed origin"
  fi
  if ! git_exec -C "$staging_directory" checkout --detach --quiet FETCH_HEAD; then
    fail "could not check out commit $sha"
  fi
  verify_release "$staging_directory" "$sha"
  move_directory "$staging_directory" "$release" || fail "could not install release $sha"
  staging_directory=""
  verify_release "$release" "$sha"
  printf '%s\n' "$release"
}

service_load_state() {
  systemctl_exec show --property=LoadState --value "$service_name"
}

service_active_state() {
  systemctl_exec show --property=ActiveState --value "$service_name"
}

device_lock_is_absent() {
  [ ! -e "$device_lock" ] && [ ! -L "$device_lock" ]
}

require_device_lock_absent() {
  device_lock_is_absent || fail "cleanup left $device_lock; recover cleanup before deployment"
}

stop_installed_service() {
  local active_state
  systemctl_exec stop "$service_name" || fail "could not stop $service_name"
  if ! active_state="$(service_active_state)"; then
    fail "could not inspect $service_name after stop"
  fi
  [ "$active_state" = inactive ] || fail "$service_name has unexpected state after stop: $active_state"
  require_device_lock_absent
}

selected_release() {
  local target sha
  if [ ! -e "$current_link" ] && [ ! -L "$current_link" ]; then
    return 1
  fi
  [ -L "$current_link" ] || fail "$current_link must be a symbolic link"
  target="$(/usr/bin/readlink "$current_link")" || fail "could not read $current_link"
  sha="${target##*/}"
  if [[ ! "$sha" =~ ^[a-f0-9]{40}$ ]] || [ "$target" != "$releases_directory/$sha" ]; then
    fail "$current_link does not select one managed release"
  fi
  verify_release "$target" "$sha"
  printf '%s\n' "$target"
}

cleanup_link_matches() {
  local metadata target
  [ -L "$cleanup_executable" ] || return 1
  target="$(/usr/bin/readlink "$cleanup_executable")" || return 1
  [ "$target" = "$cleanup_link_target" ] || return 1
  metadata="$(symlink_owner "$cleanup_executable")" || return 1
  [ "$metadata" = 0:0 ]
}

validate_prior_cleanup_selection() {
  local previous_release="$1"
  if [ -n "$previous_release" ]; then
    cleanup_link_matches || fail "$cleanup_executable does not select the managed current release"
    return
  fi
  if [ ! -e "$cleanup_executable" ] && [ ! -L "$cleanup_executable" ]; then
    return
  fi
  cleanup_link_matches || fail "$cleanup_executable exists without one managed current release"
}

require_public_ingress_disabled() {
  public_ingress_is_disabled || fail "$public_ingress_error"
}

public_ingress_is_disabled() {
  local load_state active_state unit_file_state
  public_ingress_error=""
  if ! load_state="$(systemctl_exec show --property=LoadState --value "$tunnel_service_name")"; then
    public_ingress_error="could not inspect $tunnel_service_name"
    return 1
  fi
  if [ "$load_state" = not-found ]; then
    return
  fi
  if [ "$load_state" != loaded ]; then
    public_ingress_error="$tunnel_service_name has unsupported load state: $load_state"
    return 1
  fi
  if ! active_state="$(systemctl_exec show --property=ActiveState --value "$tunnel_service_name")"; then
    public_ingress_error="could not inspect $tunnel_service_name activity"
    return 1
  fi
  if ! unit_file_state="$(systemctl_exec show --property=UnitFileState --value "$tunnel_service_name")"; then
    public_ingress_error="could not inspect $tunnel_service_name enablement"
    return 1
  fi
  if [ "$active_state" != inactive ] || [ "$unit_file_state" != disabled ]; then
    public_ingress_error="$tunnel_service_name must be disabled and inactive"
    return 1
  fi
}

require_bootstrap_destinations_absent() {
  if [ -e "$environment_file" ] || [ -L "$environment_file" ]; then
    fail "$environment_file exists while $service_name is not loaded"
  fi
  if [ -e "$unit_file" ] || [ -L "$unit_file" ]; then
    fail "$unit_file exists while $service_name is not loaded"
  fi
}

atomic_install_cleanup_link() {
  cleanup_link_matches && return 0
  if [ -e "$cleanup_executable" ] || [ -L "$cleanup_executable" ]; then
    return 1
  fi
  cleanup_stage="$(/usr/bin/mktemp "${cleanup_executable%/*}/.nemoclaw-jetson-cleanup.XXXXXX")"
  rm -f -- "$cleanup_stage"
  ln -s -- "$cleanup_link_target" "$cleanup_stage" || return 1
  move_replace "$cleanup_stage" "$cleanup_executable" || {
    rm -f -- "$cleanup_stage"
    cleanup_stage=""
    return 1
  }
  cleanup_stage=""
  cleanup_link_matches
}

atomic_select_release() {
  local release="$1"
  temporary_link="$deploy_root/.current.${release##*/}.$$"
  if [ -e "$temporary_link" ] || [ -L "$temporary_link" ]; then
    return 1
  fi
  ln -s -- "$release" "$temporary_link" || {
    temporary_link=""
    return 1
  }
  move_replace "$temporary_link" "$current_link" || {
    rm -f -- "$temporary_link"
    temporary_link=""
    return 1
  }
  temporary_link=""
  [ -L "$current_link" ] && [ "$(/usr/bin/readlink "$current_link")" = "$release" ]
}

install_managed_file() {
  local source="$1" destination="$2" mode="$3" prefix="$4"
  managed_file_stage="$(/usr/bin/mktemp "${destination%/*}/.${prefix}.XXXXXX")" || return 1
  if ! install_file "$source" "$managed_file_stage" "$mode"; then
    rm -f -- "$managed_file_stage"
    managed_file_stage=""
    return 1
  fi
  if ! root_owned_file_matches "$managed_file_stage" "$mode" \
    || ! files_match "$source" "$managed_file_stage" \
    || ! move_replace "$managed_file_stage" "$destination"; then
    rm -f -- "$managed_file_stage"
    managed_file_stage=""
    return 1
  fi
  managed_file_stage=""
  root_owned_file_matches "$destination" "$mode" && files_match "$source" "$destination"
}

install_bootstrap_files() {
  local release="$1"
  install_managed_file "$release/$environment_relative" "$environment_file" 600 environment \
    || return 1
  bootstrap_environment_installed=1
  install_managed_file "$release/$unit_relative" "$unit_file" 644 nemoclaw-jetson-dispatch.service \
    || return 1
  bootstrap_unit_installed=1
}

loopback_service_responds() {
  local listeners http_code
  systemctl_exec is-active --quiet "$service_name" || return 1
  listeners="$(ss_exec -H -ltn "sport = :$service_port")" || return 1
  [ -n "$listeners" ] || return 1
  printf '%s\n' "$listeners" | /usr/bin/awk -v expected="127.0.0.1:$service_port" '
    NF < 4 || $4 != expected { invalid = 1 }
    END { exit invalid || NR == 0 }
  ' || return 1
  http_code="$(
    curl_exec \
      --disable \
      --noproxy '*' \
      --silent \
      --show-error \
      --output /dev/null \
      --write-out '%{http_code}' \
      --max-time 5 \
      --request POST \
      --header 'Content-Type: application/json' \
      --data '{"schemaVersion":1,"target":"jetson-nvmap-gpu","candidateSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workflowRunId":"1","workflowRunAttempt":1}' \
      "http://127.0.0.1:$service_port/v1/jobs"
  )" || return 1
  [ "$http_code" = 401 ]
}

verify_loopback_service() {
  local _
  for _ in {1..20}; do
    loopback_service_responds && return 0
    sleep_exec 0.25
  done
  return 1
}

start_and_verify_service() {
  public_ingress_is_disabled || return 1
  systemctl_exec start "$service_name" || return 1
  if ! public_ingress_is_disabled; then
    stop_unverified_service || return 1
    return 1
  fi
  verify_loopback_service || return 1
  if ! public_ingress_is_disabled; then
    stop_unverified_service || return 1
    return 1
  fi
}

enable_and_verify_initial_service() {
  local load_state
  systemctl_exec daemon-reload || return 1
  bootstrap_daemon_reloaded=1
  load_state="$(service_load_state)" || return 1
  [ "$load_state" = loaded ] || return 1
  public_ingress_is_disabled || return 1
  bootstrap_enable_attempted=1
  systemctl_exec enable --now "$service_name" || return 1
  public_ingress_is_disabled || return 1
  verify_loopback_service || return 1
  public_ingress_is_disabled
}

stop_unverified_service() {
  local active_state
  systemctl_exec stop "$service_name" || return 1
  active_state="$(service_active_state)" || return 1
  [ "$active_state" = inactive ] || return 1
  device_lock_is_absent
}

restore_cleanup_selection() {
  local cleanup_was_present="$1"
  if [ "$cleanup_was_present" = 1 ]; then
    cleanup_link_matches
  else
    rm -f -- "$cleanup_executable"
  fi
}

restore_release_selection() {
  local previous_release="$1"
  if [ -n "$previous_release" ]; then
    atomic_select_release "$previous_release"
    return
  fi
  if [ -L "$current_link" ]; then
    rm -f -- "$current_link"
  elif [ -e "$current_link" ]; then
    return 1
  fi
}

rollback_deployment() {
  local previous_release="$1" cleanup_was_present="$2" service_installed="$3" rollback_failed=0 active_state
  if [ "$service_installed" = 1 ]; then
    systemctl_exec stop "$service_name" || return 1
    active_state="$(service_active_state)" || return 1
    [ "$active_state" = inactive ] || return 1
    device_lock_is_absent || return 1
  fi
  restore_release_selection "$previous_release" || rollback_failed=1
  restore_cleanup_selection "$cleanup_was_present" || rollback_failed=1
  if [ "$service_installed" = 1 ] && [ -n "$previous_release" ]; then
    start_and_verify_service || rollback_failed=1
  fi
  [ "$rollback_failed" = 0 ]
}

rollback_initial_deployment() {
  local previous_release="$1" cleanup_was_present="$2" active_state load_state rollback_failed=0
  if [ "$bootstrap_enable_attempted" = 1 ]; then
    systemctl_exec disable --now "$service_name" || return 1
    active_state="$(service_active_state)" || return 1
    [ "$active_state" = inactive ] || return 1
    device_lock_is_absent || return 1
  fi

  restore_release_selection "$previous_release" || rollback_failed=1
  restore_cleanup_selection "$cleanup_was_present" || rollback_failed=1

  if [ "$bootstrap_unit_installed" = 1 ]; then
    root_owned_file_matches "$unit_file" 644 || return 1
    rm -f -- "$unit_file" || return 1
  fi
  if [ "$bootstrap_environment_installed" = 1 ]; then
    root_owned_file_matches "$environment_file" 600 || return 1
    rm -f -- "$environment_file" || return 1
  fi
  if [ "$bootstrap_daemon_reloaded" = 1 ]; then
    systemctl_exec daemon-reload || return 1
    load_state="$(service_load_state)" || return 1
    [ "$load_state" = not-found ] || return 1
  fi
  [ "$rollback_failed" = 0 ]
}

activate_release() {
  local release="$1"
  atomic_install_cleanup_link || return 1
  atomic_select_release "$release" || return 1
  cleanup_link_matches || return 1
  [ "$(/usr/bin/readlink "$current_link")" = "$release" ] || return 1
}

main() {
  local sha release load_state service_installed=0 previous_release="" cleanup_was_present=0
  require_root
  sha="$(parse_commit "$@")"
  print_stage 1 "Validate request and prepared host"
  validate_dispatcher_prerequisites
  ensure_layout
  acquire_deploy_lock

  load_state="$(service_load_state)" || fail "could not inspect $service_name"
  if [ "$load_state" = loaded ]; then
    service_installed=1
    print_stage 2 "Stop and verify the dispatcher"
    require_public_ingress_disabled
    stop_installed_service
  elif [ "$load_state" != not-found ]; then
    fail "$service_name has unsupported load state: $load_state"
  else
    print_stage 2 "Verify initial deployment state"
    require_device_lock_absent
    require_public_ingress_disabled
    require_bootstrap_destinations_absent
  fi

  if [ -e "$current_link" ] || [ -L "$current_link" ]; then
    previous_release="$(selected_release)" || fail "could not validate $current_link"
  fi
  validate_prior_cleanup_selection "$previous_release"
  [ -n "$previous_release" ] && cleanup_was_present=1
  if [ "$service_installed" = 1 ] && [ -z "$previous_release" ]; then
    fail "$service_name is installed without one managed current release"
  fi
  print_stage 3 "Fetch and verify the release"
  release="$(prepare_release "$sha")"

  print_stage 4 "Select dispatcher and cleanup code"
  if [ "$service_installed" = 1 ]; then
    require_public_ingress_disabled
  fi
  if ! activate_release "$release"; then
    if rollback_deployment "$previous_release" "$cleanup_was_present" "$service_installed"; then
      fail "release $sha activation or verification failed; the previous deployment state was restored"
    fi
    fail "release $sha activation or verification failed, and rollback did not restore a verified service"
  fi

  if [ "$service_installed" = 1 ]; then
    print_stage 5 "Start and verify the dispatcher"
    if ! start_and_verify_service; then
      if rollback_deployment "$previous_release" "$cleanup_was_present" "$service_installed"; then
        fail "release $sha activation or verification failed; the previous deployment state was restored"
      fi
      fail "release $sha activation or verification failed, and rollback did not restore a verified service"
    fi
    echo "Deployed Colossus Jetson dispatcher release $sha and verified its loopback service"
  else
    print_stage 5 "Install, enable, and verify the dispatcher"
    if ! install_bootstrap_files "$release" || ! enable_and_verify_initial_service; then
      if rollback_initial_deployment "$previous_release" "$cleanup_was_present"; then
        fail "release $sha initial deployment failed; the release, unit, and environment were rolled back"
      fi
      fail "release $sha initial deployment failed, and rollback did not restore the prepared host"
    fi
    echo "Deployed Colossus Jetson dispatcher release $sha and verified its loopback service; public ingress remains disabled"
  fi
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
  main "$@"
fi
