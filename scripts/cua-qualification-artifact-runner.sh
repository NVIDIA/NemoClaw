#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly ARTIFACT_USER="nemoclaw-cua-artifact"
readonly TRUSTED_RUNNER_PATH="/usr/local/libexec/nemoclaw-cua-qualification-artifact-runner"
readonly SERVICE_RUNNER_PATH="/run/nemoclaw-cua-control/runner"
readonly LOCK_DIRECTORY="/run/nemoclaw-cua-artifact-lock"
readonly MAX_ARTIFACT_BYTES=67108864
readonly MAX_TASK_INPUT_BYTES=65536
readonly MAX_STDIN_BYTES=1048576
readonly MAX_OUTPUT_BYTES=16384
readonly OUTPUT_FILE_LIMIT_BYTES=16385
readonly SERVICE_WALL_SECONDS=30
readonly TARGET_SOCKET_SOURCE="/run/nemoclaw/cua-qualification-target.sock"
readonly TARGET_SOCKET_PATH="/run/nemoclaw-cua-artifact/target.sock"
readonly TASK_INPUT_PATH="/run/nemoclaw-cua-artifact/task-input"
readonly START_GATE_PATH="/run/nemoclaw-cua-control/start"
readonly CGROUP_ROOT="/sys/fs/cgroup"
readonly SYSTEMD_UNIT_PREFIX="nemoclaw-cua-artifact"
readonly SYSTEMD_DESCRIPTION="NemoClaw CUA qualification artifact"
readonly TRUSTED_PATH="/usr/bin:/bin"
readonly CHMOD=/usr/bin/chmod
readonly CMP=/usr/bin/cmp
readonly DD=/usr/bin/dd
readonly FLOCK=/usr/bin/flock
readonly GETENT=/usr/bin/getent
readonly ID=/usr/bin/id
readonly INSTALL=/usr/bin/install
readonly LN=/usr/bin/ln
readonly MKNOD=/usr/bin/mknod
readonly MOUNT=/usr/bin/mount
readonly MKTEMP=/usr/bin/mktemp
readonly READLINK=/usr/bin/readlink
readonly RM=/usr/bin/rm
readonly SHA256SUM=/usr/bin/sha256sum
readonly SLEEP=/usr/bin/sleep
readonly STAT=/usr/bin/stat
readonly SUDO=/usr/bin/sudo
readonly SYSTEMCTL=/usr/bin/systemctl
readonly SYSTEMD_RUN=/usr/bin/systemd-run
readonly TIMEOUT=/usr/bin/timeout
readonly UMOUNT=/usr/bin/umount
readonly UNSHARE=/usr/bin/unshare

export PATH="$TRUSTED_PATH"
export LC_ALL=C
umask 077

fail() {
  printf 'cua-qualification-artifact-runner: %s\n' "$1" >&2
  exit 126
}

read_status_value() {
  local key="$1"
  local status_path="$2"
  local status_key status_value _rest
  while read -r status_key status_value _rest; do
    if [[ "$status_key" == "$key:" ]]; then
      printf '%s\n' "$status_value"
      return 0
    fi
  done <"$status_path"
  return 1
}

# This copy is installed root-only inside the per-invocation RootDirectory.
# systemd has already applied its seccomp and address-family filters before
# the fixed unshare launcher reaches this stage.
if [[ "${1:-}" == "--service-stage" ]]; then
  [[ "$EUID" == "0" && "$0" == "$SERVICE_RUNNER_PATH" ]] \
    || fail "service stage authority is invalid"
  service_identity="$($STAT -Lc '%u:%g:%a:%h:%F' -- "$0")" \
    || fail "service stage identity is unavailable"
  [[ "$service_identity" == "0:0:500:1:regular file" ]] \
    || fail "service stage identity is invalid"
  shift
  [[ "$#" -ge 5 && "$1" =~ ^[1-9][0-9]*$ && "$2" =~ ^[1-9][0-9]*$ ]] \
    || fail "service stage account is invalid"
  service_uid="$1"
  service_gid="$2"
  service_mode="$3"
  shift 3
  [[ "$1" == "--" && "$#" -ge 2 ]] || fail "service stage command is invalid"
  shift
  case "$service_mode" in
    --require-target-channel | --no-target-channel) ;;
    *) fail "service stage channel mode is invalid" ;;
  esac

  "$MOUNT" -o remount,nosuid,nodev,noexec,hidepid=2,subset=pid /proc \
    || fail "private procfs could not be hardened"
  [[ "$(read_status_value Seccomp /proc/self/status)" == "2" ]] \
    || fail "service seccomp filter is unavailable"
  [[ "$(read_status_value NoNewPrivs /proc/self/status)" == "1" ]] \
    || fail "service no-new-privileges boundary is unavailable"
  for undeclared_path in /sys /usr/local /opt /home /run/host /run/systemd; do
    [[ ! -e "$undeclared_path" ]] || fail "an undeclared host runtime channel is exposed"
  done
  start_released=0
  for _gate_attempt in {1..1000}; do
    if [[ -f "$START_GATE_PATH" && ! -L "$START_GATE_PATH" ]]; then
      start_released=1
      break
    fi
    "$SLEEP" 0.01
  done
  ((start_released == 1)) || fail "service start gate was not released"
  if [[ "$service_mode" == "--require-target-channel" ]]; then
    [[ -S "$TARGET_SOCKET_PATH" ]] || fail "isolated qualification target socket is unavailable"
  else
    [[ ! -e "$TARGET_SOCKET_PATH" ]] || fail "no-target mode exposed a qualification target socket"
  fi

  artifact_environment=(
    HOME=/run/nemoclaw-cua-artifact/home
    LANG=C
    LC_ALL=C
    PATH=/usr/bin:/bin
    TEMP=/run/nemoclaw-cua-artifact/tmp
    TMP=/run/nemoclaw-cua-artifact/tmp
    TMPDIR=/run/nemoclaw-cua-artifact/tmp
    XDG_RUNTIME_DIR="/run/user/$service_uid"
  )
  if [[ "$service_mode" == "--require-target-channel" ]]; then
    artifact_environment+=(
      NEMOCLAW_CUA_QUALIFICATION_TARGET_SOCKET="$TARGET_SOCKET_PATH"
    )
  fi
  ulimit -c 0
  ulimit -n 64
  ulimit -t 20
  exec /usr/bin/setpriv \
    --reuid="$service_uid" \
    --regid="$service_gid" \
    --clear-groups \
    --bounding-set=-all \
    --inh-caps=-all \
    --ambient-caps=-all \
    --no-new-privs \
    --pdeathsig=KILL \
    -- \
    /usr/bin/env -i "${artifact_environment[@]}" "$@"
fi

[[ "$#" -ge 1 ]] || fail "one channel mode and one artifact command are required"
[[ -x "$READLINK" && ! -L "$READLINK" ]] || fail "bootstrap authority is unavailable"
runner="$($READLINK -f -- "$0")" || fail "runner authority is unavailable"
[[ "$runner" == "$TRUSTED_RUNNER_PATH" ]] || fail "runner authority is invalid"

bootstrap_assert() {
  local bootstrap_path="$1"
  local bootstrap_canonical bootstrap_identity bootstrap_mode bootstrap_mode_value
  local bootstrap_parent bootstrap_parent_identity bootstrap_parent_mode
  bootstrap_canonical="$($READLINK -f -- "$bootstrap_path")" \
    || fail "bootstrap authority is unavailable"
  [[ "$bootstrap_canonical" == "$bootstrap_path" && ! -L "$bootstrap_path" ]] \
    || fail "bootstrap authority is invalid"
  bootstrap_identity="$($STAT -Lc '%u:%g:%a:%h:%F' -- "$bootstrap_path")" \
    || fail "bootstrap identity is unavailable"
  [[ "$bootstrap_identity" =~ ^0:0:[0-7]{3,4}:1:regular\ file$ ]] \
    || fail "bootstrap identity is invalid"
  bootstrap_mode="${bootstrap_identity#0:0:}"
  bootstrap_mode="${bootstrap_mode%%:*}"
  bootstrap_mode_value=$((8#$bootstrap_mode))
  (((bootstrap_mode_value & 0022) == 0 && (bootstrap_mode_value & 0111) != 0)) \
    || fail "bootstrap mode is unsafe"
  bootstrap_parent="${bootstrap_path%/*}"
  while :; do
    bootstrap_parent_identity="$($STAT -Lc '%u:%g:%a:%F' -- "$bootstrap_parent")" \
      || fail "bootstrap parent authority is unavailable"
    [[ "$bootstrap_parent_identity" =~ ^0:0:[0-7]{3,4}:directory$ ]] \
      || fail "bootstrap parent authority is invalid"
    bootstrap_parent_mode="${bootstrap_parent_identity#0:0:}"
    bootstrap_parent_mode="${bootstrap_parent_mode%%:*}"
    bootstrap_mode_value=$((8#$bootstrap_parent_mode))
    (((bootstrap_mode_value & 0022) == 0)) || fail "bootstrap parent authority is writable"
    [[ "$bootstrap_parent" == "/" ]] && break
    bootstrap_parent="${bootstrap_parent%/*}"
    [[ -n "$bootstrap_parent" ]] || bootstrap_parent="/"
  done
}
for bootstrap_path in "$READLINK" "$STAT" "$SUDO" "$runner"; do
  bootstrap_assert "$bootstrap_path"
done

if ((EUID != 0)); then
  exec "$SUDO" -n -- "$runner" --root-caller "$EUID" "$EGID" -- "$@"
fi

caller_uid=0
caller_gid=0
if [[ "${1:-}" == "--root-caller" ]]; then
  shift
  [[ "$#" -ge 5 && "$1" =~ ^[1-9][0-9]*$ && "$2" =~ ^[1-9][0-9]*$ && "$3" == "--" ]] \
    || fail "root caller identity is invalid"
  [[ "${SUDO_UID:-}" == "$1" && "${SUDO_GID:-}" == "$2" ]] \
    || fail "root caller identity does not match sudo authority"
  caller_uid="$1"
  caller_gid="$2"
  shift 3
fi

assert_root_directory_chain() {
  local candidate="$1"
  local identity owner_uid owner_gid mode file_type mode_value
  while :; do
    identity="$($STAT -Lc '%u:%g:%a:%F' -- "$candidate")" \
      || fail "trusted path authority is unavailable"
    IFS=: read -r owner_uid owner_gid mode file_type <<<"$identity"
    [[ "$owner_uid" == "0" && "$owner_gid" == "0" && "$mode" =~ ^[0-7]{3,4}$ &&
      "$file_type" == "directory" ]] || fail "trusted path authority is invalid"
    mode_value=$((8#$mode))
    (((mode_value & 0022) == 0)) || fail "trusted path authority is writable"
    [[ "$candidate" == "/" ]] && break
    candidate="${candidate%/*}"
    [[ -n "$candidate" ]] || candidate="/"
  done
}

assert_trusted_executable() {
  local helper="$1"
  local canonical identity owner_uid owner_gid mode links file_type mode_value
  canonical="$($READLINK -f -- "$helper")" || fail "trusted helper authority is unavailable"
  [[ "$canonical" == "$helper" && -f "$helper" && ! -L "$helper" && -x "$helper" ]] \
    || fail "trusted helper authority is invalid"
  identity="$($STAT -Lc '%u:%g:%a:%h:%F' -- "$helper")" \
    || fail "trusted helper identity is unavailable"
  IFS=: read -r owner_uid owner_gid mode links file_type <<<"$identity"
  [[ "$owner_uid" == "0" && "$owner_gid" == "0" && "$mode" =~ ^[0-7]{3,4}$ &&
    "$links" == "1" && "$file_type" == "regular file" ]] \
    || fail "trusted helper identity is invalid"
  mode_value=$((8#$mode))
  (((mode_value & 0022) == 0 && (mode_value & 0111) != 0)) \
    || fail "trusted helper mode is unsafe"
  assert_root_directory_chain "${helper%/*}"
}

for trusted_helper in \
  /usr/bin/bash \
  "$CHMOD" \
  "$CMP" \
  "$DD" \
  /usr/bin/env \
  "$FLOCK" \
  "$GETENT" \
  "$ID" \
  "$INSTALL" \
  "$LN" \
  "$MKNOD" \
  "$MOUNT" \
  "$MKTEMP" \
  "$READLINK" \
  "$RM" \
  /usr/bin/setpriv \
  "$SHA256SUM" \
  "$SLEEP" \
  "$STAT" \
  "$SUDO" \
  "$SYSTEMCTL" \
  "$SYSTEMD_RUN" \
  "$TIMEOUT" \
  "$UMOUNT" \
  "$UNSHARE"; do
  assert_trusted_executable "$trusted_helper"
done
[[ "$($READLINK -f -- /bin/bash)" == "/usr/bin/bash" ]] \
  || fail "fixed bash authority is invalid"
assert_trusted_executable "$runner"

[[ -d /run/systemd/system && -r "$CGROUP_ROOT/cgroup.controllers" ]] \
  || fail "systemd cgroup-v2 authority is unavailable"
read -r -a cgroup_controllers <"$CGROUP_ROOT/cgroup.controllers"
for required_controller in cpu memory pids; do
  controller_present=0
  for controller in "${cgroup_controllers[@]}"; do
    [[ "$controller" == "$required_controller" ]] && controller_present=1
  done
  ((controller_present == 1)) || fail "required cgroup-v2 controller is unavailable"
done
read -r systemd_name systemd_version _rest < <("$SYSTEMD_RUN" --version)
[[ "$systemd_name" == "systemd" && "$systemd_version" =~ ^[0-9]+$ &&
  "$systemd_version" -ge 255 ]] || fail "systemd 255 or newer is required"

case "$1" in
  --require-target-channel)
    channel_mode="$1"
    ;;
  --no-target-channel)
    channel_mode="$1"
    ;;
  *) fail "artifact target channel mode is invalid" ;;
esac
shift

ingress_task_input=""
ingress_task_input_sha256=""
artifact_sha256=""
while [[ "$#" -gt 0 && "$1" != "--" ]]; do
  case "$1" in
    --artifact-sha256)
      [[ -z "$artifact_sha256" && "$#" -ge 2 && "$2" =~ ^[0-9a-f]{64}$ ]] \
        || fail "artifact digest authority is invalid"
      artifact_sha256="$2"
      shift 2
      ;;
    --ingress-task-input)
      [[ -z "$ingress_task_input" && "$#" -ge 2 ]] || fail "task-input ingress is invalid"
      ingress_task_input="$2"
      shift 2
      ;;
    --ingress-task-input-sha256)
      [[ -z "$ingress_task_input_sha256" && "$#" -ge 2 ]] \
        || fail "task-input digest ingress is invalid"
      ingress_task_input_sha256="$2"
      shift 2
      ;;
    *) fail "artifact runner option is invalid" ;;
  esac
done
[[ "$#" -ge 2 && "$1" == "--" ]] || fail "artifact command separator is required"
shift
artifact="$1"
shift
[[ "$artifact_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "artifact digest authority is required"

if [[ "$channel_mode" == "--no-target-channel" ]]; then
  [[ -z "$ingress_task_input" && -z "$ingress_task_input_sha256" ]] \
    || fail "task-input ingress requires the target channel"
else
  [[ (-z "$ingress_task_input" && -z "$ingress_task_input_sha256") ||
    (-n "$ingress_task_input" && "$ingress_task_input_sha256" =~ ^[0-9a-f]{64}$) ]] \
    || fail "task-input ingress fields must be supplied together"
fi

"$INSTALL" -d -o root -g root -m 0700 -- "$LOCK_DIRECTORY" \
  || fail "global artifact lock directory could not be prepared"
lock_identity="$($STAT -Lc '%u:%g:%a:%h:%F' -- "$LOCK_DIRECTORY")" \
  || fail "global artifact lock authority is unavailable"
[[ "$lock_identity" == "0:0:700:2:directory" ]] \
  || fail "global artifact lock authority is invalid"
exec 9>"$LOCK_DIRECTORY/lock"
"$CHMOD" 0600 "$LOCK_DIRECTORY/lock"
"$FLOCK" -n 9 || fail "another qualification artifact invocation is active"

passwd_entry="$($GETENT passwd "$ARTIFACT_USER")" \
  || fail "dedicated artifact account is unavailable"
[[ -n "$passwd_entry" && "$passwd_entry" != *$'\n'* ]] \
  || fail "dedicated artifact account is invalid"
IFS=: read -r account_name _password account_uid account_gid _gecos account_home account_shell \
  <<<"$passwd_entry"
[[ "$account_name" == "$ARTIFACT_USER" && "$account_uid" =~ ^[1-9][0-9]*$ &&
  "$account_gid" =~ ^[1-9][0-9]*$ && "$account_home" == "/nonexistent" &&
  ("$account_shell" == "/usr/sbin/nologin" || "$account_shell" == "/bin/false") ]] \
  || fail "dedicated artifact account is invalid"
[[ "$account_uid" != "$caller_uid" && "$account_gid" != "$caller_gid" ]] \
  || fail "dedicated artifact account overlaps the caller"
[[ "$($ID -G "$ARTIFACT_USER")" == "$account_gid" ]] \
  || fail "dedicated artifact account has supplementary groups"

account_uid_count=0
account_primary_gid_count=0
while IFS=: read -r _passwd_name _passwd passwd_uid passwd_gid _tail; do
  [[ "$passwd_uid" == "$account_uid" ]] && ((account_uid_count += 1))
  [[ "$passwd_gid" == "$account_gid" ]] && ((account_primary_gid_count += 1))
done < <("$GETENT" passwd)
[[ "$account_uid_count" == "1" && "$account_primary_gid_count" == "1" ]] \
  || fail "dedicated artifact account identity is shared"

artifact_group_count=0
group_membership_count=0
while IFS=: read -r group_name _group_password group_gid group_members; do
  if [[ "$group_gid" == "$account_gid" ]]; then
    ((artifact_group_count += 1))
    [[ "$group_name" == "$ARTIFACT_USER" && -z "$group_members" ]] \
      || fail "dedicated artifact group is shared"
  fi
  [[ ",$group_members," == *",$ARTIFACT_USER,"* ]] && ((group_membership_count += 1))
done < <("$GETENT" group)
[[ "$artifact_group_count" == "1" && "$group_membership_count" == "0" ]] \
  || fail "dedicated artifact group membership is invalid"

for process_status in /proc/[0-9]*/status; do
  [[ -r "$process_status" ]] || continue
  process_uids=""
  process_gids=""
  process_groups=""
  while read -r process_key process_values; do
    [[ "$process_key" == "Uid:" ]] && process_uids="$process_values"
    [[ "$process_key" == "Gid:" ]] && process_gids="$process_values"
    [[ "$process_key" == "Groups:" ]] && process_groups="$process_values"
  done <"$process_status"
  if [[ -n "$process_uids" ]]; then
    read -r real_uid effective_uid saved_uid filesystem_uid _rest <<<"$process_uids"
    [[ "$real_uid" =~ ^[0-9]+$ && "$effective_uid" =~ ^[0-9]+$ &&
      "$saved_uid" =~ ^[0-9]+$ && "$filesystem_uid" =~ ^[0-9]+$ ]] \
      || fail "process UID state is invalid"
    for process_uid in "$real_uid" "$effective_uid" "$saved_uid" "$filesystem_uid"; do
      [[ "$process_uid" != "$account_uid" ]] \
        || fail "dedicated artifact account is not quiescent"
    done
  fi
  if [[ -n "$process_gids" ]]; then
    read -r real_gid effective_gid saved_gid filesystem_gid _rest <<<"$process_gids"
    [[ "$real_gid" =~ ^[0-9]+$ && "$effective_gid" =~ ^[0-9]+$ &&
      "$saved_gid" =~ ^[0-9]+$ && "$filesystem_gid" =~ ^[0-9]+$ ]] \
      || fail "process GID state is invalid"
    for process_gid in "$real_gid" "$effective_gid" "$saved_gid" "$filesystem_gid"; do
      [[ "$process_gid" != "$account_gid" ]] \
        || fail "dedicated artifact group is not quiescent"
    done
  fi
  for process_group in $process_groups; do
    [[ "$process_group" =~ ^[0-9]+$ ]] || fail "process group state is invalid"
    [[ "$process_group" != "$account_gid" ]] \
      || fail "dedicated artifact group is active in another process"
  done
done

assert_artifact_source_file() {
  local source_path="$1"
  local expected_executable="$2"
  local canonical identity owner_uid owner_gid mode links size file_type mode_value
  local parent_identity parent_uid parent_gid parent_mode parent_type parent_mode_value
  [[ "$source_path" == /* && "$source_path" != *[$'\n\r\t ']* ]] \
    || fail "artifact path must be absolute"
  canonical="$($READLINK -f -- "$source_path")" || fail "artifact authority is unavailable"
  [[ "$canonical" == "$source_path" && -f "$source_path" && ! -L "$source_path" ]] \
    || fail "artifact authority is invalid"
  identity="$($STAT -Lc '%u:%g:%a:%h:%s:%F' -- "$source_path")" \
    || fail "artifact identity is unavailable"
  IFS=: read -r owner_uid owner_gid mode links size file_type <<<"$identity"
  [[ "$mode" =~ ^[0-7]{3,4}$ && "$links" == "1" && "$size" =~ ^[1-9][0-9]*$ &&
    "$file_type" == "regular file" ]] \
    || fail "artifact identity is invalid"
  ((10#$size <= MAX_ARTIFACT_BYTES)) || fail "artifact exceeds its bounded size"
  mode_value=$((8#$mode))
  (((mode_value & 0022) == 0)) || fail "artifact mode is unsafe"
  if [[ "$expected_executable" == "yes" ]]; then
    (((mode_value & 0111) != 0)) || fail "artifact is not executable"
  fi
  if [[ "$owner_uid" == "0" && "$owner_gid" == "0" ]]; then
    assert_root_directory_chain "${source_path%/*}"
  elif [[ "$owner_uid" == "$caller_uid" && "$owner_gid" == "$caller_gid" ]]; then
    parent_identity="$($STAT -Lc '%u:%g:%a:%F' -- "${source_path%/*}")" \
      || fail "caller artifact directory authority is unavailable"
    IFS=: read -r parent_uid parent_gid parent_mode parent_type <<<"$parent_identity"
    [[ "$parent_uid" == "$caller_uid" && "$parent_gid" == "$caller_gid" &&
      "$parent_mode" =~ ^[0-7]{3,4}$ && "$parent_type" == "directory" ]] \
      || fail "caller artifact directory authority is invalid"
    parent_mode_value=$((8#$parent_mode))
    (((parent_mode_value & 0022) == 0)) || fail "caller artifact directory is group/world writable"
  else
    fail "artifact owner is not trusted"
  fi
}

assert_artifact_source_file "$artifact" yes
artifact_identity_before="$($STAT -Lc '%d:%i:%f:%h:%u:%g:%a:%s:%y:%z:%F' -- "$artifact")" \
  || fail "artifact identity is unavailable"

task_input_identity_before=""
if [[ -n "$ingress_task_input" ]]; then
  [[ "$ingress_task_input" == /* && "$ingress_task_input" != *[$'\n\r\t ']* ]] \
    || fail "task-input path must be absolute"
  canonical_task_input="$($READLINK -f -- "$ingress_task_input")" \
    || fail "task-input authority is unavailable"
  [[ "$canonical_task_input" == "$ingress_task_input" && -f "$ingress_task_input" &&
    ! -L "$ingress_task_input" ]] || fail "task-input authority is invalid"
  task_input_identity_before="$($STAT -Lc '%d|%i|%f|%h|%u|%g|%a|%s|%y|%z|%F' -- "$ingress_task_input")" \
    || fail "task-input identity is unavailable"
  IFS='|' read -r _device _inode _flags input_links input_uid input_gid input_mode input_size \
    _mtime _ctime input_type <<<"$task_input_identity_before"
  [[ "$input_links" == "1" && "$input_uid" == "$caller_uid" && "$input_gid" == "$caller_gid" &&
    "$input_mode" == "400" && "$input_size" =~ ^[1-9][0-9]*$ &&
    "$input_type" == "regular file" ]] || fail "task-input identity is invalid"
  input_parent_identity="$($STAT -Lc '%u:%g:%a:%F' -- "${ingress_task_input%/*}")" \
    || fail "task-input parent authority is unavailable"
  [[ "$input_parent_identity" == "$caller_uid:$caller_gid:500:directory" ]] \
    || fail "task-input parent authority is invalid"
  ((10#$input_size <= MAX_TASK_INPUT_BYTES)) || fail "task-input exceeds its bounded size"
  observed_input_sha256="$($SHA256SUM -- "$ingress_task_input")" \
    || fail "task-input digest is unavailable"
  observed_input_sha256="${observed_input_sha256%% *}"
  [[ "$observed_input_sha256" == "$ingress_task_input_sha256" ]] \
    || fail "task-input digest does not match"
fi

scratch="$($MKTEMP -d /run/nemoclaw-cua-artifact.XXXXXXXX)" \
  || fail "private artifact root could not be reserved"
root_directory="$scratch/root"
unit="${SYSTEMD_UNIT_PREFIX}-${scratch##*.}.service"
manager_pid=""
service_monitor_pid=""
control_group=""
cgroup_observed=0
mounted_paths=()
cleanup_complete=0
cleanup_in_progress=0

kill_service_cgroup() {
  local discovered_group cgroup_path events_key events_value populated
  if [[ -n "$unit" ]]; then
    discovered_group="$($SYSTEMCTL show "$unit" --property=ControlGroup --value 2>/dev/null || true)"
    if [[ "$discovered_group" == "/system.slice/${unit}" ]]; then
      control_group="$discovered_group"
    fi
    "$SYSTEMCTL" kill --kill-whom=all --signal=KILL "$unit" >/dev/null 2>&1 || true
  fi
  [[ -n "$control_group" ]] || return 1
  cgroup_path="$CGROUP_ROOT$control_group"
  if [[ ! -d "$cgroup_path" ]]; then
    ((cgroup_observed == 1))
    return
  fi
  if [[ -w "$cgroup_path/cgroup.kill" ]]; then
    printf '1\n' >"$cgroup_path/cgroup.kill" || true
  fi
  for _attempt in {1..100}; do
    populated=""
    if [[ -r "$cgroup_path/cgroup.events" ]]; then
      while read -r events_key events_value; do
        [[ "$events_key" == "populated" ]] && populated="$events_value"
      done <"$cgroup_path/cgroup.events"
    fi
    [[ "$populated" == "0" ]] && return 0
    "$SLEEP" 0.02
  done
  return 1
}

observe_service_cgroup() {
  local discovered_group cgroup_path events_key events_value populated
  local pids_max memory_max memory_swap_max memory_oom_group cpu_max
  for _attempt in {1..1000}; do
    discovered_group="$($SYSTEMCTL show "$unit" --property=ControlGroup --value 2>/dev/null || true)"
    if [[ "$discovered_group" == "/system.slice/$unit" &&
      -d "$CGROUP_ROOT$discovered_group" ]]; then
      control_group="$discovered_group"
      break
    fi
    "$SLEEP" 0.01
  done
  [[ -n "$control_group" ]] || return 1
  cgroup_path="$CGROUP_ROOT$control_group"
  [[ -r "$cgroup_path/pids.max" && -r "$cgroup_path/memory.max" &&
    -r "$cgroup_path/memory.swap.max" && -r "$cgroup_path/memory.oom.group" &&
    -r "$cgroup_path/cpu.max" && -r "$cgroup_path/cgroup.events" &&
    -w "$cgroup_path/cgroup.kill" ]] || return 1
  read -r pids_max <"$cgroup_path/pids.max"
  read -r memory_max <"$cgroup_path/memory.max"
  read -r memory_swap_max <"$cgroup_path/memory.swap.max"
  read -r memory_oom_group <"$cgroup_path/memory.oom.group"
  read -r cpu_max <"$cgroup_path/cpu.max"
  [[ "$pids_max" == "32" && "$memory_max" == "268435456" &&
    "$memory_swap_max" == "0" && "$memory_oom_group" == "1" &&
    "$cpu_max" == "50000 100000" ]] || return 1
  populated=""
  while read -r events_key events_value; do
    [[ "$events_key" == "populated" ]] && populated="$events_value"
  done <"$cgroup_path/cgroup.events"
  [[ "$populated" == "1" ]] || return 1
  cgroup_observed=1
}

cleanup_root() {
  local cleanup_status=0 load_state mount_index
  local -a remaining_mounts=()
  ((cleanup_complete == 0)) || return 0
  ((cleanup_in_progress == 0)) || return 1
  cleanup_in_progress=1
  if [[ -n "$manager_pid" ]]; then
    kill "$manager_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$service_monitor_pid" ]]; then
    kill "$service_monitor_pid" >/dev/null 2>&1 || true
  fi
  kill_service_cgroup || ((cgroup_observed == 0)) || cleanup_status=1
  "$SYSTEMCTL" stop "$unit" >/dev/null 2>&1 || true
  kill_service_cgroup || ((cgroup_observed == 0)) || cleanup_status=1
  "$SYSTEMCTL" reset-failed "$unit" >/dev/null 2>&1 || true
  for ((mount_index = ${#mounted_paths[@]} - 1; mount_index >= 0; mount_index -= 1)); do
    if ! "$UMOUNT" -- "${mounted_paths[$mount_index]}" >/dev/null 2>&1; then
      remaining_mounts=("${mounted_paths[$mount_index]}" "${remaining_mounts[@]}")
      cleanup_status=1
    fi
  done
  mounted_paths=("${remaining_mounts[@]}")
  if ((${#mounted_paths[@]} == 0)); then
    if [[ ! -e "$scratch" && ! -L "$scratch" ]]; then
      :
    elif [[ "$scratch" =~ ^/run/nemoclaw-cua-artifact\.[A-Za-z0-9]{8}$ && -d "$scratch" &&
      ! -L "$scratch" ]]; then
      "$RM" -rf --one-file-system -- "$scratch" || cleanup_status=1
    else
      cleanup_status=1
    fi
  else
    cleanup_status=1
  fi
  for _attempt in {1..100}; do
    load_state="$($SYSTEMCTL show "$unit" --property=LoadState --value 2>/dev/null || true)"
    [[ "$load_state" == "not-found" ]] && break
    "$SLEEP" 0.02
  done
  [[ "$load_state" == "not-found" ]] || cleanup_status=1
  ((cleanup_status == 0)) && cleanup_complete=1
  cleanup_in_progress=0
  return "$cleanup_status"
}

interrupted=0
# shellcheck disable=SC2329 # Invoked by the signal trap below.
handle_signal() {
  interrupted=1
  ((cleanup_in_progress == 0)) || return 0
  trap - HUP INT QUIT TERM
  kill_service_cgroup || true
  [[ -z "$manager_pid" ]] || kill "$manager_pid" >/dev/null 2>&1 || true
  [[ -z "$service_monitor_pid" ]] || kill "$service_monitor_pid" >/dev/null 2>&1 || true
  printf 'cua-qualification-artifact-runner: artifact execution was interrupted\n' >&2
  exit 126
}
trap handle_signal HUP INT QUIT TERM
trap 'cleanup_root || cleanup_root || true' EXIT

stdin_source="$scratch/stdin"
"$TIMEOUT" --signal=KILL 5 "$DD" bs=1048577 count=1 iflag=fullblock \
  of="$stdin_source" oflag=excl,nofollow status=none || fail "artifact stdin was not closed"
stdin_size="$($STAT -Lc '%s' -- "$stdin_source")" || fail "artifact stdin size is unavailable"
[[ "$stdin_size" =~ ^[0-9]+$ ]] || fail "artifact stdin size is invalid"
((10#$stdin_size <= MAX_STDIN_BYTES)) || fail "artifact stdin exceeded its bounded size"
"$CHMOD" 0400 "$stdin_source"

"$INSTALL" -d -o root -g root -m 0755 -- "$root_directory"
"$MOUNT" -t tmpfs -o nosuid,mode=0755,size=256M,nr_inodes=4096 \
  nemoclaw-cua-artifact-root "$root_directory" || fail "private artifact root could not be mounted"
mounted_paths+=("$root_directory")

"$INSTALL" -d -o root -g root -m 0755 -- \
  "$root_directory/usr" \
  "$root_directory/usr/bin" \
  "$root_directory/usr/lib" \
  "$root_directory/etc" \
  "$root_directory/proc" \
  "$root_directory/run" \
  "$root_directory/run/user" \
  "$root_directory/tmp" \
  "$root_directory/var" \
  "$root_directory/var/tmp" \
  "$root_directory/dev"
"$CHMOD" 01777 "$root_directory/tmp" "$root_directory/var/tmp"
if [[ -d /usr/lib64 && ! -L /usr/lib64 ]]; then
  "$INSTALL" -d -o root -g root -m 0755 -- "$root_directory/usr/lib64"
fi
"$LN" -s usr/bin "$root_directory/bin"
"$LN" -s usr/lib "$root_directory/lib"
if [[ -d "$root_directory/usr/lib64" ]]; then
  "$LN" -s usr/lib64 "$root_directory/lib64"
fi

"$MOUNT" -t tmpfs -o nosuid,mode=0755,size=1M,nr_inodes=64 \
  nemoclaw-cua-artifact-dev "$root_directory/dev" || fail "private device root could not be mounted"
mounted_paths+=("$root_directory/dev")
"$MKNOD" -m 0666 "$root_directory/dev/null" c 1 3
"$MKNOD" -m 0666 "$root_directory/dev/zero" c 1 5
"$MKNOD" -m 0444 "$root_directory/dev/random" c 1 8
"$MKNOD" -m 0444 "$root_directory/dev/urandom" c 1 9
"$INSTALL" -d -o root -g root -m 01777 -- "$root_directory/dev/shm"
"$MOUNT" -t tmpfs -o nodev,nosuid,noexec,mode=1777,size=16M,nr_inodes=128 \
  nemoclaw-cua-artifact-shm "$root_directory/dev/shm" || fail "private shared memory could not be mounted"
mounted_paths+=("$root_directory/dev/shm")
"$LN" -s /proc/self/fd "$root_directory/dev/fd"
"$LN" -s /proc/self/fd/0 "$root_directory/dev/stdin"
"$LN" -s /proc/self/fd/1 "$root_directory/dev/stdout"
"$LN" -s /proc/self/fd/2 "$root_directory/dev/stderr"

"$INSTALL" -d -o root -g root -m 0700 -- "$root_directory/run/nemoclaw-cua-control"
"$INSTALL" -d -o root -g root -m 0711 -- "$root_directory/run/nemoclaw-cua-artifact"
"$INSTALL" -d -o "$account_uid" -g "$account_gid" -m 0700 -- \
  "$root_directory/run/nemoclaw-cua-artifact/home" \
  "$root_directory/run/nemoclaw-cua-artifact/tmp" \
  "$root_directory/run/user/$account_uid"
"$INSTALL" -o root -g root -m 0500 -- "$runner" \
  "$root_directory$SERVICE_RUNNER_PATH"
"$CMP" -s -- "$runner" "$root_directory$SERVICE_RUNNER_PATH" \
  || fail "service runner bytes changed during staging"
"$INSTALL" -o root -g root -m 0400 -- "$stdin_source" \
  "$root_directory/run/nemoclaw-cua-control/stdin"
"$CMP" -s -- "$stdin_source" "$root_directory/run/nemoclaw-cua-control/stdin" \
  || fail "artifact stdin bytes changed during staging"
"$DD" if="$artifact" of="$root_directory/run/nemoclaw-cua-artifact/executable" \
  iflag=nofollow oflag=excl,nofollow status=none || fail "artifact could not be staged"
"$CHMOD" 0555 "$root_directory/run/nemoclaw-cua-artifact/executable"
"$CMP" -s -- "$artifact" "$root_directory/run/nemoclaw-cua-artifact/executable" \
  || fail "artifact bytes changed during staging"
staged_artifact_sha256="$($SHA256SUM -- "$root_directory/run/nemoclaw-cua-artifact/executable")"
staged_artifact_sha256="${staged_artifact_sha256%% *}"
[[ "$staged_artifact_sha256" == "$artifact_sha256" ]] \
  || fail "staged artifact digest does not match"
artifact_identity_after="$($STAT -Lc '%d:%i:%f:%h:%u:%g:%a:%s:%y:%z:%F' -- "$artifact")" \
  || fail "artifact identity changed during staging"
[[ "$artifact_identity_after" == "$artifact_identity_before" ]] \
  || fail "artifact identity changed during staging"

if [[ -n "$ingress_task_input" ]]; then
  "$DD" if="$ingress_task_input" of="$root_directory$TASK_INPUT_PATH" \
    iflag=nofollow oflag=excl,nofollow status=none || fail "task-input could not be staged"
  "$CHMOD" 0444 "$root_directory$TASK_INPUT_PATH"
  "$CMP" -s -- "$ingress_task_input" "$root_directory$TASK_INPUT_PATH" \
    || fail "task-input bytes changed during staging"
  staged_input_sha256="$($SHA256SUM -- "$root_directory$TASK_INPUT_PATH")"
  staged_input_sha256="${staged_input_sha256%% *}"
  [[ "$staged_input_sha256" == "$ingress_task_input_sha256" ]] \
    || fail "staged task-input digest does not match"
  task_input_identity_after="$($STAT -Lc '%d|%i|%f|%h|%u|%g|%a|%s|%y|%z|%F' -- "$ingress_task_input")" \
    || fail "task-input identity changed during staging"
  [[ "$task_input_identity_after" == "$task_input_identity_before" ]] \
    || fail "task-input identity changed during staging"
fi

printf 'root:x:0:0:root:/nonexistent:/bin/false\n%s:x:%s:%s::/run/nemoclaw-cua-artifact/home:/bin/false\n' \
  "$ARTIFACT_USER" "$account_uid" "$account_gid" >"$root_directory/etc/passwd"
printf 'root:x:0:\n%s:x:%s:\n' "$ARTIFACT_USER" "$account_gid" >"$root_directory/etc/group"
printf 'passwd: files\ngroup: files\nhosts: files\n' >"$root_directory/etc/nsswitch.conf"
"$CHMOD" 0444 "$root_directory/etc/passwd" "$root_directory/etc/group" \
  "$root_directory/etc/nsswitch.conf"

stdout_file="$root_directory/run/nemoclaw-cua-control/stdout"
stderr_file="$root_directory/run/nemoclaw-cua-control/stderr"
manager_log="$scratch/systemd-run.log"
"$INSTALL" -o root -g root -m 0600 /dev/null "$stdout_file"
"$INSTALL" -o root -g root -m 0600 /dev/null "$stderr_file"
"$INSTALL" -o root -g root -m 0600 /dev/null "$manager_log"

systemd_properties=(
  "--property=RootDirectory=$root_directory"
  "--property=MountAPIVFS=no"
  "--property=BindReadOnlyPaths=/usr/bin:/usr/bin"
  "--property=BindReadOnlyPaths=/usr/lib:/usr/lib"
  "--property=WorkingDirectory=/run/nemoclaw-cua-artifact/home"
  "--property=StandardInput=file:$root_directory/run/nemoclaw-cua-control/stdin"
  "--property=StandardOutput=file:$root_directory/run/nemoclaw-cua-control/stdout"
  "--property=StandardError=file:$root_directory/run/nemoclaw-cua-control/stderr"
  "--property=UMask=0077"
  "--property=PrivateMounts=yes"
  "--property=NoNewPrivileges=yes"
  "--property=CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETUID CAP_SETGID CAP_SETPCAP"
  "--property=RestrictAddressFamilies=AF_UNIX"
  "--property=IPAddressDeny=any"
  "--property=RestrictNamespaces=mnt pid cgroup net ipc uts"
  "--property=SystemCallArchitectures=native"
  "--property=SystemCallFilter=@system-service @mount unshare sethostname"
  "--property=SystemCallFilter=~@keyring @aio bpf perf_event_open userfaultfd setns clone3"
  "--property=SystemCallErrorNumber=ENOSYS"
  "--property=KeyringMode=private"
  "--property=LockPersonality=yes"
  "--property=RestrictRealtime=yes"
  "--property=RestrictSUIDSGID=yes"
  "--property=DevicePolicy=closed"
  "--property=TasksMax=32"
  "--property=MemoryMax=268435456"
  "--property=MemorySwapMax=0"
  "--property=MemoryOOMGroup=yes"
  "--property=CPUQuota=50%"
  "--property=CPUQuotaPeriodSec=100ms"
  "--property=RuntimeMaxSec=${SERVICE_WALL_SECONDS}s"
  "--property=TimeoutStartSec=10s"
  "--property=TimeoutStopSec=2s"
  "--property=KillMode=control-group"
  "--property=SendSIGKILL=yes"
  "--property=OOMPolicy=kill"
  "--property=LimitNOFILE=64"
  "--property=LimitCORE=0"
  "--property=LimitFSIZE=$OUTPUT_FILE_LIMIT_BYTES"
  "--property=LimitCPU=20"
)
if [[ -d /usr/lib64 && ! -L /usr/lib64 ]]; then
  systemd_properties+=("--property=BindReadOnlyPaths=/usr/lib64:/usr/lib64")
fi

if [[ "$channel_mode" == "--require-target-channel" ]]; then
  [[ -e "$TARGET_SOCKET_SOURCE" || -L "$TARGET_SOCKET_SOURCE" ]] \
    || fail "required qualification target socket is unavailable"
  canonical_target_socket="$($READLINK -f -- "$TARGET_SOCKET_SOURCE")" \
    || fail "qualification target socket authority is unavailable"
  [[ "$canonical_target_socket" == "$TARGET_SOCKET_SOURCE" && -S "$TARGET_SOCKET_SOURCE" &&
    ! -L "$TARGET_SOCKET_SOURCE" ]] || fail "qualification target socket authority is invalid"
  assert_root_directory_chain "${TARGET_SOCKET_SOURCE%/*}"
  target_socket_identity_before="$($STAT -Lc '%d|%i|%f|%h|%u|%g|%a|%s|%y|%z|%F' -- "$TARGET_SOCKET_SOURCE")" \
    || fail "qualification target socket identity is unavailable"
  IFS='|' read -r _socket_device _socket_inode _socket_flags socket_links socket_uid socket_gid \
    socket_mode _socket_size _socket_mtime _socket_ctime socket_type \
    <<<"$target_socket_identity_before"
  [[ "$socket_links" == "1" && "$socket_uid" == "0" && "$socket_gid" == "$account_gid" &&
    "$socket_mode" == "660" && "$socket_type" == "socket" ]] \
    || fail "qualification target socket identity is invalid"
  "$INSTALL" -o root -g "$account_gid" -m 0660 /dev/null \
    "$root_directory$TARGET_SOCKET_PATH"
  systemd_properties+=(
    "--property=BindReadOnlyPaths=$TARGET_SOCKET_SOURCE:$TARGET_SOCKET_PATH"
  )
fi

((interrupted == 0)) || fail "artifact execution was interrupted"

monitor_unit_completion() {
  local active_state sub_state observed_stdout_size observed_stderr_size
  for _attempt in {1..4000}; do
    observed_stdout_size="$($STAT -Lc '%s' -- "$stdout_file" 2>/dev/null || true)"
    observed_stderr_size="$($STAT -Lc '%s' -- "$stderr_file" 2>/dev/null || true)"
    if [[ "$observed_stdout_size" =~ ^[0-9]+$ && "$observed_stderr_size" =~ ^[0-9]+$ ]] \
      && ((10#$observed_stdout_size + 10#$observed_stderr_size > MAX_OUTPUT_BYTES)); then
      if [[ ! -e "$scratch/output-overflow" ]]; then
        printf 'overflow\n' >"$scratch/output-overflow"
        kill_service_cgroup || true
      fi
    fi
    active_state="$($SYSTEMCTL show "$unit" --property=ActiveState --value 2>/dev/null || true)"
    sub_state="$($SYSTEMCTL show "$unit" --property=SubState --value 2>/dev/null || true)"
    if [[ ("$active_state" == "active" && "$sub_state" == "exited") ||
      "$active_state" == "failed" ]]; then
      return 0
    fi
    [[ "$active_state" != "inactive" && -n "$active_state" ]] || return 1
    "$SLEEP" 0.01
  done
  return 1
}

"$SYSTEMD_RUN" \
  --quiet \
  --remain-after-exit \
  --service-type=exec \
  --expand-environment=no \
  --unit="$unit" \
  --description="$SYSTEMD_DESCRIPTION" \
  "${systemd_properties[@]}" \
  -- \
  /usr/bin/env \
  -i \
  HOME=/nonexistent \
  LANG=C \
  LC_ALL=C \
  PATH=/usr/bin:/bin \
  "$UNSHARE" \
  --mount \
  --pid \
  --cgroup \
  --net \
  --ipc \
  --uts \
  --sethostname=nemoclaw-cua-artifact \
  --fork \
  --kill-child=KILL \
  --mount-proc=/proc \
  -- \
  "$SERVICE_RUNNER_PATH" --service-stage "$account_uid" "$account_gid" "$channel_mode" -- \
  /run/nemoclaw-cua-artifact/executable "$@" \
  >"$manager_log" 2>&1 &
manager_pid=$!
set +e
wait "$manager_pid"
manager_status=$?
manager_pid=""
set -e
((manager_status == 0)) || fail "transient artifact service could not be started"
observe_service_cgroup || fail "transient artifact cgroup limits are unavailable"
((interrupted == 0)) || fail "artifact execution was interrupted"
"$INSTALL" -o root -g root -m 0400 /dev/null "$root_directory$START_GATE_PATH" \
  || fail "service start gate could not be released"
monitor_unit_completion &
service_monitor_pid=$!

set +e
wait "$service_monitor_pid"
monitor_status=$?
service_monitor_pid=""
set -e
((monitor_status == 0)) || fail "transient artifact service state was lost"

if [[ "$channel_mode" == "--require-target-channel" ]]; then
  target_socket_identity_after="$($STAT -Lc '%d|%i|%f|%h|%u|%g|%a|%s|%y|%z|%F' -- "$TARGET_SOCKET_SOURCE")" \
    || fail "qualification target socket identity changed during execution"
  [[ "$target_socket_identity_after" == "$target_socket_identity_before" ]] \
    || fail "qualification target socket identity changed during execution"
fi

declare -A unit_state=()
while IFS='=' read -r state_key state_value; do
  unit_state["$state_key"]="$state_value"
done < <("$SYSTEMCTL" show "$unit" \
  --property=Result \
  --property=ExecMainCode \
  --property=ExecMainStatus \
  --property=ControlGroup \
  --property=Description \
  --property=FragmentPath)
[[ "${unit_state[Description]:-}" == "$SYSTEMD_DESCRIPTION" &&
  -z "${unit_state[FragmentPath]:-}" &&
  "${unit_state[ControlGroup]:-}" == "/system.slice/$unit" ]] \
  || fail "transient artifact service identity is invalid"
control_group="${unit_state[ControlGroup]}"

stdout_size="$($STAT -Lc '%s' -- "$stdout_file")"
stderr_size="$($STAT -Lc '%s' -- "$stderr_file")"
[[ "$stdout_size" =~ ^[0-9]+$ && "$stderr_size" =~ ^[0-9]+$ ]] \
  || fail "artifact output size is unavailable"
if [[ -e "$scratch/output-overflow" ]] \
  || ((10#$stdout_size + 10#$stderr_size > MAX_OUTPUT_BYTES)); then
  kill_service_cgroup || true
  cleanup_root || fail "private artifact service cleanup failed"
  trap - EXIT HUP INT QUIT TERM
  printf 'cua-qualification-artifact-runner: artifact output exceeded its bounded size\n' >&2
  exit 126
fi
((interrupted == 0)) || fail "artifact execution was interrupted"

"$DD" if="$stdout_file" status=none
"$DD" if="$stderr_file" status=none >&2

service_result="${unit_state[Result]:-}"
service_code="${unit_state[ExecMainCode]:-}"
service_status="${unit_state[ExecMainStatus]:-}"
[[ "$service_status" =~ ^[0-9]+$ ]] || service_status=126
if [[ "$service_result" == "success" && ("$service_code" == "exited" || "$service_code" == "1") &&
  "$service_status" == "0" ]]; then
  artifact_status=0
elif [[ "$service_result" == "exit-code" && ("$service_code" == "exited" || "$service_code" == "1") &&
  "$service_status" -ge 1 && "$service_status" -le 125 ]]; then
  artifact_status="$service_status"
else
  artifact_status=126
fi

cleanup_root || fail "private artifact service cleanup failed"
if ((interrupted == 1)); then
  trap - EXIT HUP INT QUIT TERM
  printf 'cua-qualification-artifact-runner: artifact execution was interrupted\n' >&2
  exit 126
fi
trap - EXIT HUP INT QUIT TERM
exit "$artifact_status"
