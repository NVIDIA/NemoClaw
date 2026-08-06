#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Versioned GPU-backed Brev Launchable bootstrap for CUA qualification.
# shellcheck disable=SC1003,SC2016 # Embedded Node and generated profile source expand later.
#
# Required Launchable variables:
#   NEMOCLAW_REF  Exact lowercase 40-hex NemoClaw candidate commit.
#   NEMOCLAW_CUA_GPU_PROBE_IMAGE  Immutable OCI image reference ending in
#                                @sha256:<64 lowercase hex characters>.
#   NEMOCLAW_CUA_RUNTIME_MANIFEST  Absolute path to the image-provided,
#                                  sanitized CUA runtime manifest. Its declared
#                                  payload files must be siblings of the manifest.
#   NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256  Exact lowercase SHA-256 of the manifest.
#   NEMOCLAW_CUA_SANDBOX_IMAGE_REF  Immutable sandbox image reference matching
#                                   the manifest's sandbox-image digest.
#   NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256  Exact lowercase SHA-256 of the sanitized
#                                        cua.release.bundle/v1 receipt.
#
# The Brev image owns GPU hardware, driver, and NVIDIA Container Toolkit
# provisioning. This script verifies those prerequisites, installs the exact
# NemoClaw candidate through the reviewed bootstrap, and records only
# content-free component identities for the qualification runner.

set -euo pipefail

# Bash keeps the script it is executing on descriptor 255. Address that open
# authority through the saved shell PID so the digesting process reopens the
# executing inode from offset zero without inheriting or advancing Bash's
# parsing descriptor. A pathname swap cannot change these bytes.
readonly CUA_LAUNCHABLE_BASH_PID="$$"
readonly CUA_LAUNCHABLE_DESCRIPTOR="/proc/${CUA_LAUNCHABLE_BASH_PID}/fd/255"
readonly CUA_LAUNCHABLE_VERSION="1.0.0"
readonly CUA_SENTINEL="/run/nemoclaw-cua-launchable-ready"
readonly QUALIFICATION_ENVIRONMENT_FILE="/etc/nemoclaw/cua-qualification-environment.json"
readonly CUA_PROFILE_FILE="/etc/profile.d/nemoclaw-cua.sh"
readonly CUA_ARTIFACT_RUNNER="/usr/local/libexec/nemoclaw-cua-qualification-artifact-runner"
readonly CUA_ARTIFACT_USER="nemoclaw-cua-artifact"
readonly CUA_TARGET_CHANNEL_PROTOCOL="cua.qualification.target-channel/v1"
readonly CLONE_ROOT="/opt/nemoclaw-cua"
readonly HOST_SYSTEM_PATH="/usr/sbin:/usr/bin:/sbin:/bin"
readonly RUNTIME_TOOL_DISCOVERY_PATH="/usr/local/sbin:/usr/local/bin:${HOST_SYSTEM_PATH}"
readonly NODE_TARGET_BINARY="/usr/bin/node"
AWK_BINARY="/usr/bin/awk"
CHMOD_BINARY="/usr/bin/chmod"
CHOWN_BINARY="/usr/bin/chown"
CMP_BINARY="/usr/bin/cmp"
CURL_BINARY="/usr/bin/curl"
ENV_BINARY="/usr/bin/env"
GETENT_BINARY="/usr/bin/getent"
GIT_BINARY="/usr/bin/git"
GREP_BINARY="/usr/bin/grep"
HEAD_BINARY="/usr/bin/head"
ID_BINARY="/usr/bin/id"
INSTALL_BINARY="/usr/bin/install"
JQ_BINARY="/usr/bin/jq"
MKDIR_BINARY="/usr/bin/mkdir"
MKTEMP_BINARY="/usr/bin/mktemp"
MV_BINARY="/usr/bin/mv"
READLINK_BINARY="/usr/bin/readlink"
REALPATH_BINARY="/usr/bin/realpath"
RM_BINARY="/usr/bin/rm"
SED_BINARY="/usr/bin/sed"
SHA256SUM_BINARY="/usr/bin/sha256sum"
SORT_BINARY="/usr/bin/sort"
STAT_BINARY="/usr/bin/stat"
SUDO_BINARY="/usr/bin/sudo"
SYNC_BINARY="/usr/bin/sync"
SYSTEMCTL_BINARY="/usr/bin/systemctl"
TEE_BINARY="/usr/bin/tee"
TRUE_BINARY="/usr/bin/true"
TR_BINARY="/usr/bin/tr"
USERADD_BINARY="/usr/sbin/useradd"
readonly MAX_TRACKED_SOURCE_BYTES=67108864
readonly -a FIXED_HOST_HELPER_VARIABLES=(
  AWK_BINARY
  CHMOD_BINARY
  CHOWN_BINARY
  CMP_BINARY
  CURL_BINARY
  ENV_BINARY
  GETENT_BINARY
  GIT_BINARY
  GREP_BINARY
  HEAD_BINARY
  ID_BINARY
  INSTALL_BINARY
  JQ_BINARY
  MKDIR_BINARY
  MKTEMP_BINARY
  MV_BINARY
  READLINK_BINARY
  RM_BINARY
  SED_BINARY
  SHA256SUM_BINARY
  SORT_BINARY
  SUDO_BINARY
  SYNC_BINARY
  SYSTEMCTL_BINARY
  TEE_BINARY
  TRUE_BINARY
  TR_BINARY
  USERADD_BINARY
)
export PATH="$HOST_SYSTEM_PATH"
export LC_ALL=C
VALIDATED_ROOT_AUTHORITY_DIRECTORIES=$'\n'

fail() {
  printf 'brev-launchable-cua-gpu: %s\n' "$1" >&2
  exit 1
}

assert_root_publication_directory() {
  local directory="$1"
  local resolved identity permissions permission_value
  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  resolved="$(cd -- "$directory" && pwd -P)" || return 1
  [[ "$resolved" == "$directory" ]] || return 1
  identity="$("$STAT_BINARY" -Lc '%u:%g:%F' -- "$directory")" || return 1
  [[ "$identity" == "0:0:directory" ]] || return 1
  permissions="$("$STAT_BINARY" -Lc '%a' -- "$directory")" || return 1
  [[ "$permissions" =~ ^[0-7]{3,4}$ ]] || return 1
  permission_value=$((8#$permissions))
  (((permission_value & 07022) == 0))
}

assert_root_publication_temp() {
  local temporary="$1"
  local prefix="$2"
  [[ "$temporary" == "$prefix"* && "$temporary" != *$'\n'* &&
    -f "$temporary" && ! -L "$temporary" ]] || return 1
  [[ "$("$STAT_BINARY" -Lc '%u:%g:%a:%h:%F' -- "$temporary")" == "0:0:600:1:regular file" ]]
}

assert_published_root_file() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || return 1
  [[ "$("$STAT_BINARY" -Lc '%u:%g:%a:%h:%F' -- "$file")" == "0:0:444:1:regular file" ]]
}

assert_root_authority_ancestors() {
  local authority="$1"
  local directory identity permissions permission_value
  directory="${authority%/*}"
  [[ -n "$directory" ]] || directory="/"
  while true; do
    [[ "$VALIDATED_ROOT_AUTHORITY_DIRECTORIES" != *$'\n'"$directory"$'\n'* ]] || break
    [[ -d "$directory" && ! -L "$directory" ]] || return 1
    [[ "$("$REALPATH_BINARY" -- "$directory")" == "$directory" ]] || return 1
    identity="$("$STAT_BINARY" -Lc '%u:%g:%F' -- "$directory")" || return 1
    [[ "$identity" == "0:0:directory" ]] || return 1
    permissions="$("$STAT_BINARY" -Lc '%a' -- "$directory")" || return 1
    [[ "$permissions" =~ ^[0-7]{3,4}$ ]] || return 1
    permission_value=$((8#$permissions))
    (((permission_value & 07022) == 0)) || return 1
    VALIDATED_ROOT_AUTHORITY_DIRECTORIES+="${directory}"$'\n'
    [[ "$directory" != "/" ]] || break
    directory="${directory%/*}"
    [[ -n "$directory" ]] || directory="/"
  done
}

validate_fixed_host_helper() {
  local source="$1"
  local canonical="$2"
  local source_identity metadata owner group permissions type permission_value
  [[ "$source" == /* && "$source" != *$'\n'* && -f "$source" && -x "$source" &&
    "$canonical" == /* && "$canonical" != *$'\n'* && -f "$canonical" &&
    ! -L "$canonical" && -x "$canonical" ]] || return 1
  assert_root_authority_ancestors "$source" || return 1
  assert_root_authority_ancestors "$canonical" || return 1
  if [[ "$source" != "$canonical" ]]; then
    source_identity="$("$STAT_BINARY" -c '%u:%g:%F' -- "$source")" || return 1
    [[ "$source_identity" == "0:0:regular file" ||
      "$source_identity" == "0:0:symbolic link" ]] || return 1
  fi
  metadata="$("$STAT_BINARY" -Lc '%u:%g:%a:%F' -- "$canonical")" || return 1
  IFS=: read -r owner group permissions type <<<"$metadata"
  [[ "$owner" == "0" && "$group" == "0" && "$type" == "regular file" ]] || return 1
  [[ "$permissions" =~ ^[0-7]{3,4}$ ]] || return 1
  permission_value=$((8#$permissions))
  (((permission_value & 0022) == 0 && (permission_value & 0111) != 0))
}

bootstrap_fixed_host_helpers() {
  local helper_variable source canonical
  local stat_source="$STAT_BINARY"
  local realpath_source="$REALPATH_BINARY"
  # These exact paths are the only bootstrap authorities used to inspect the
  # rest. Shell file tests run before either executable is trusted.
  [[ -f "$stat_source" && ! -L "$stat_source" && -x "$stat_source" &&
    -f "$realpath_source" && ! -L "$realpath_source" && -x "$realpath_source" ]] || return 1
  STAT_BINARY="$("$realpath_source" -- "$stat_source")" || return 1
  REALPATH_BINARY="$("$realpath_source" -- "$realpath_source")" || return 1
  validate_fixed_host_helper "$stat_source" "$STAT_BINARY" || return 1
  validate_fixed_host_helper "$realpath_source" "$REALPATH_BINARY" || return 1
  for helper_variable in "${FIXED_HOST_HELPER_VARIABLES[@]}"; do
    source="${!helper_variable}"
    canonical="$("$REALPATH_BINARY" -- "$source")" || return 1
    validate_fixed_host_helper "$source" "$canonical" || return 1
    printf -v "$helper_variable" '%s' "$canonical"
  done
  readonly STAT_BINARY REALPATH_BINARY "${FIXED_HOST_HELPER_VARIABLES[@]}"
}

resolve_root_host_tool() {
  local command_name="$1"
  local path_variable="$2"
  local digest_variable="$3"
  local discovered canonical identity mode mode_value opened_identity after_identity raw_digest
  local tool_size
  discovered="$(PATH="$RUNTIME_TOOL_DISCOVERY_PATH" command -v -- "$command_name")" || return 1
  [[ "$discovered" == /* && "$discovered" != *$'\n'* ]] || return 1
  canonical="$("$REALPATH_BINARY" -- "$discovered")" || return 1
  [[ "$canonical" == /* && "$canonical" != *$'\n'* && -f "$canonical" &&
    ! -L "$canonical" && -x "$canonical" ]] || return 1
  assert_root_authority_ancestors "$canonical" || return 1
  [[ "$("$STAT_BINARY" -Lc '%u:%g:%F' -- "$canonical")" == "0:0:regular file" ]] || return 1
  mode="$("$STAT_BINARY" -Lc '%a' -- "$canonical")" || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  mode_value=$((8#$mode))
  (((mode_value & 07022) == 0 && (mode_value & 0111) != 0)) || return 1
  [[ "$("$STAT_BINARY" -Lc '%h' -- "$canonical")" == "1" ]] || return 1
  tool_size="$("$STAT_BINARY" -Lc '%s' -- "$canonical")" || return 1
  [[ "$tool_size" =~ ^(0|[1-9][0-9]{0,8})$ ]] || return 1
  ((10#$tool_size > 0 && 10#$tool_size <= 268435456)) || return 1
  identity="$("$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$canonical")" || return 1
  [[ "$identity" == *":regular file" ]] || return 1
  exec 8<"$canonical" || return 1
  opened_identity="$("$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- /dev/fd/8)" || {
    exec 8<&-
    return 1
  }
  [[ "$opened_identity" == "$identity" ]] || {
    exec 8<&-
    return 1
  }
  raw_digest="$("$SHA256SUM_BINARY" /dev/fd/8 | "$AWK_BINARY" '{print $1}')" || {
    exec 8<&-
    return 1
  }
  after_identity="$("$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- /dev/fd/8)" || {
    exec 8<&-
    return 1
  }
  exec 8<&-
  [[ "$after_identity" == "$identity" &&
    "$("$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$canonical")" == "$identity" &&
    "$raw_digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf -v "$path_variable" '%s' "$canonical"
  printf -v "$digest_variable" 'sha256:%s' "$raw_digest"
}

bootstrap_fixed_host_helpers \
  || fail "the Launchable image contains an untrusted fixed host helper authority"

launchable_authority_identity="$(
  "$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$CUA_LAUNCHABLE_DESCRIPTOR" 2>/dev/null
)" || fail "the Launchable must be executed from a supported regular file descriptor"
[[ "$launchable_authority_identity" == *":regular file" ]] \
  || fail "the Launchable must be executed from a supported regular file descriptor"
launchable_authority_mode="$("$STAT_BINARY" -Lc '%a' -- "$CUA_LAUNCHABLE_DESCRIPTOR" 2>/dev/null)" \
  || fail "the executing Launchable file mode is unavailable"
[[ "$launchable_authority_mode" =~ ^[0-7]{3,4}$ ]] \
  || fail "the executing Launchable file mode is invalid"
launchable_authority_mode_value=$((8#$launchable_authority_mode))
(((launchable_authority_mode_value & 07222) == 0 && (\
launchable_authority_mode_value & 0111) != 0)) \
  || fail "the executing Launchable file mode is unsafe"
[[ "$("$STAT_BINARY" -Lc '%u:%g' -- "$CUA_LAUNCHABLE_DESCRIPTOR" 2>/dev/null)" == "0:0" ]] \
  || fail "the executing Launchable must be root-owned"
[[ "$("$STAT_BINARY" -Lc '%h' -- "$CUA_LAUNCHABLE_DESCRIPTOR" 2>/dev/null)" == "1" ]] \
  || fail "the executing Launchable file must have one authority link"
launchable_authority_path="$("$REALPATH_BINARY" -- "$CUA_LAUNCHABLE_DESCRIPTOR")" \
  || fail "the executing Launchable authority path is unavailable"
[[ "$launchable_authority_path" == /* && "$launchable_authority_path" != *$'\n'* &&
  -f "$launchable_authority_path" && ! -L "$launchable_authority_path" ]] \
  || fail "the executing Launchable authority path is invalid"
launchable_authority_path_identity="$(
  "$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$launchable_authority_path"
)" || fail "the executing Launchable path does not retain its opened authority"
[[ "$launchable_authority_path_identity" == "$launchable_authority_identity" ]] \
  || fail "the executing Launchable path does not retain its opened authority"
assert_root_authority_ancestors "$launchable_authority_path" \
  || fail "the executing Launchable path has an untrusted ancestor"

launchable_digest="$("$SHA256SUM_BINARY" "$CUA_LAUNCHABLE_DESCRIPTOR" | "$AWK_BINARY" '{print $1}')" \
  || fail "the executing Launchable descriptor could not be hashed"
[[ "$launchable_digest" =~ ^[0-9a-f]{64}$ ]] \
  || fail "the executing Launchable descriptor digest is invalid"
launchable_authority_after="$(
  "$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$CUA_LAUNCHABLE_DESCRIPTOR" 2>/dev/null
)" || fail "the executing Launchable descriptor changed while it was hashed"
[[ "$launchable_authority_after" == "$launchable_authority_identity" ]] \
  || fail "the executing Launchable descriptor changed while it was hashed"

cua_runtime_manifest="${NEMOCLAW_CUA_RUNTIME_MANIFEST:-}"

[[ "${NEMOCLAW_REF:-}" =~ ^[0-9a-f]{40}$ ]] \
  || fail "NEMOCLAW_REF must be an exact lowercase 40-hex commit"
[[ "${NEMOCLAW_CUA_GPU_PROBE_IMAGE:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] \
  || fail "NEMOCLAW_CUA_GPU_PROBE_IMAGE must be an immutable OCI digest reference"
[[ "$cua_runtime_manifest" =~ ^/[A-Za-z0-9._/-]+$ &&
  "/${cua_runtime_manifest#/}/" != *"/../"* &&
  "/${cua_runtime_manifest#/}/" != *"/./"* ]] \
  || fail "NEMOCLAW_CUA_RUNTIME_MANIFEST must be one canonical absolute path"
[[ "${NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] \
  || fail "NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256 must be a lowercase SHA-256"
[[ "${NEMOCLAW_CUA_SANDBOX_IMAGE_REF:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._/:+-]*@sha256:[0-9a-f]{64}$ ]] \
  || fail "NEMOCLAW_CUA_SANDBOX_IMAGE_REF must be an immutable OCI digest reference"
[[ "${NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] \
  || fail "NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256 must be a lowercase SHA-256"

# Revoke a previous attempt before any candidate-controlled setup runs. The
# profile below also checks the sentinel, so partially published files cannot
# activate CUA in a newly started shell.
"$SUDO_BINARY" "$RM_BINARY" -f -- \
  "$CUA_SENTINEL" \
  "$CUA_PROFILE_FILE" \
  "$QUALIFICATION_ENVIRONMENT_FILE" \
  "$CUA_ARTIFACT_RUNNER"

target_user="${SUDO_USER:-$("$ID_BINARY" -un)}"
[[ "$target_user" =~ ^[A-Za-z_][A-Za-z0-9._-]{0,63}$ ]] \
  || fail "the target user identity is invalid"
passwd_entry="$("$GETENT_BINARY" passwd "$target_user")" \
  || fail "the target user home is unavailable"
[[ -n "$passwd_entry" && "$passwd_entry" != *$'\n'* ]] \
  || fail "the target user home is unavailable"
IFS=: read -r passwd_name _passwd _uid _gid _gecos target_home _shell <<<"$passwd_entry"
[[ "$passwd_name" == "$target_user" && "$target_home" == /* && -d "$target_home" ]] \
  || fail "the target user home is unavailable"

[[ -z "${NEMOCLAW_CLONE_DIR+x}" ]] \
  || fail "NEMOCLAW_CLONE_DIR must not be set for CUA qualification"

clone_parent="${CLONE_ROOT%/*}"
[[ -d "$clone_parent" && ! -L "$clone_parent" ]] \
  || fail "the CUA clone parent is not a regular directory"
resolved_clone_parent="$(cd -- "$clone_parent" && pwd -P)" \
  || fail "the CUA clone parent is unavailable"
[[ "$resolved_clone_parent" == "$clone_parent" ]] \
  || fail "the CUA clone parent must not contain symbolic-link ancestors"
clone_parent_identity="$("$STAT_BINARY" -c '%u:%g:%a:%F' -- "$clone_parent")" \
  || fail "the CUA clone parent identity is unavailable"
[[ "$clone_parent_identity" =~ ^0:0:7[0145][0145]:directory$ ]] \
  || fail "the CUA clone parent must remain root-owned and non-writable"

if [[ -e "$CLONE_ROOT" || -L "$CLONE_ROOT" ]]; then
  [[ -d "$CLONE_ROOT" && ! -L "$CLONE_ROOT" ]] \
    || fail "the CUA clone root is not a regular directory"
else
  "$SUDO_BINARY" "$INSTALL_BINARY" -d -o root -g root -m 0755 "$CLONE_ROOT"
fi
[[ -d "$CLONE_ROOT" && ! -L "$CLONE_ROOT" ]] \
  || fail "the CUA clone root is not a regular directory"
resolved_clone_root="$(cd -- "$CLONE_ROOT" && pwd -P)" \
  || fail "the CUA clone root is unavailable"
[[ "$resolved_clone_root" == "$CLONE_ROOT" ]] \
  || fail "the CUA clone root must not contain symbolic-link ancestors"
clone_root_identity="$("$STAT_BINARY" -c '%u:%g:%a:%F' -- "$CLONE_ROOT")" \
  || fail "the CUA clone root identity is unavailable"
[[ "$clone_root_identity" == "0:0:755:directory" ]] \
  || fail "the CUA clone root must remain root-owned and non-writable"
clone_dir="${CLONE_ROOT}/${NEMOCLAW_REF}"
[[ ! -e "$clone_dir" && ! -L "$clone_dir" ]] \
  || fail "the fresh Launchable clone path already exists"

bootstrap_dir="$("$MKTEMP_BINARY" -d "/tmp/nemoclaw-brev-launchable.XXXXXXXX")" \
  || fail "a private bootstrap directory could not be created"
[[ "$bootstrap_dir" == /tmp/nemoclaw-brev-launchable.* && -d "$bootstrap_dir" && ! -L "$bootstrap_dir" ]] \
  || fail "the private bootstrap directory is invalid"
"$CHMOD_BINARY" 0700 "$bootstrap_dir"
qualification_environment_temp=""
profile_temp=""
sentinel_temp=""
artifact_runner_temp=""
cua_publication_complete=0
cleanup_bootstrap() {
  set +e
  [[ -z "$qualification_environment_temp" ]] \
    || "$SUDO_BINARY" "$RM_BINARY" -f -- "$qualification_environment_temp" 2>/dev/null || true
  [[ -z "$profile_temp" ]] \
    || "$SUDO_BINARY" "$RM_BINARY" -f -- "$profile_temp" 2>/dev/null || true
  [[ -z "$sentinel_temp" ]] \
    || "$SUDO_BINARY" "$RM_BINARY" -f -- "$sentinel_temp" 2>/dev/null || true
  [[ -z "$artifact_runner_temp" ]] \
    || "$SUDO_BINARY" "$RM_BINARY" -f -- "$artifact_runner_temp" 2>/dev/null || true
  if ((cua_publication_complete == 0)); then
    "$SUDO_BINARY" "$RM_BINARY" -f -- \
      "$CUA_SENTINEL" \
      "$CUA_PROFILE_FILE" \
      "$QUALIFICATION_ENVIRONMENT_FILE" \
      "$CUA_ARTIFACT_RUNNER" \
      2>/dev/null || true
  fi
  "$RM_BINARY" -rf -- "${bootstrap_dir:?}"
}
trap cleanup_bootstrap EXIT

base_script="${bootstrap_dir}/brev-launchable-ci-cpu.sh"
base_home="${bootstrap_dir}/base-home"
base_launch_log="${bootstrap_dir}/base-launch.log"
git_home="${bootstrap_dir}/git-home"
git_xdg_home="${bootstrap_dir}/git-xdg"
"$MKDIR_BINARY" -m 0700 "$base_home" "$git_home" "$git_xdg_home"
[[ -x "$GIT_BINARY" ]] \
  || fail "the selected Brev Launchable image does not include an executable git binary"

# Git inherits no caller-controlled repository or configuration environment.
# Command-line overrides also disable the two repository-local execution paths
# relevant to checkout and status: hooks and fsmonitor.
run_git() {
  "$ENV_BINARY" -i \
    HOME="$git_home" \
    XDG_CONFIG_HOME="$git_xdg_home" \
    PATH="$HOST_SYSTEM_PATH" \
    LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_NO_REPLACE_OBJECTS=1 \
    "$GIT_BINARY" \
    --no-replace-objects \
    -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false \
    -c core.untrackedCache=false \
    -c core.attributesFile=/dev/null \
    -c core.excludesFile=/dev/null \
    -c credential.helper= \
    "$@"
}

# Verify source bytes without trusting Git's mutable index concealment flags.
# The ordinary status is retained for untracked paths, while the independent
# tree walk proves every tracked index entry and filesystem byte against HEAD.
verify_exact_git_checkout() {
  local repository="$1"
  local revision="$2"
  git_verification_sequence=$((${git_verification_sequence:-0} + 1))
  local verification_prefix="${bootstrap_dir}/git-verification-${git_verification_sequence}"
  local flags_file="${verification_prefix}-index-flags"
  local replace_refs_file="${verification_prefix}-replace-refs"
  local tree_file="${verification_prefix}-head-tree"
  local status_file="${verification_prefix}-status"
  local authority_file="${verification_prefix}-head-blob"
  local local_link_file="${verification_prefix}-local-link"
  local entry tag metadata mode type object raw_size extra relative file permissions permission_value
  local before_identity after_identity local_size
  local gitlink_marker gitlink_marker_identity gitlink_marker_identity_after

  [[ "$(run_git -C "$repository" rev-parse --show-toplevel)" == "$repository" ]] || return 1
  run_git -C "$repository" for-each-ref --format='%(refname)' refs/replace/ \
    >"$replace_refs_file" || return 1
  [[ ! -s "$replace_refs_file" ]] || return 1
  [[ "$(run_git -C "$repository" rev-parse --verify HEAD)" == "$revision" ]] || return 1

  run_git -C "$repository" ls-files -v -z >"$flags_file" || return 1
  while IFS= read -r -d '' entry; do
    tag="${entry:0:1}"
    [[ "$tag" != "S" && ! "$tag" =~ [a-z] ]] || return 1
  done <"$flags_file"

  run_git -C "$repository" diff-index --cached --quiet "$revision" -- || return 1
  run_git -C "$repository" ls-tree -lrz --full-tree "$revision" >"$tree_file" || return 1
  while IFS= read -r -d '' entry; do
    [[ "$entry" == *$'\t'* ]] || return 1
    metadata="${entry%%$'\t'*}"
    relative="${entry#*$'\t'}"
    read -r mode type object raw_size extra <<<"$metadata"
    [[ "$object" =~ ^[0-9a-f]{40}$ && -n "$relative" && "$relative" != /* ]] || return 1
    [[ "/$relative/" != *"/../"* && "/$relative/" != *"/./"* ]] || return 1
    file="${repository}/${relative}"

    if [[ "$mode" == "160000" && "$type" == "commit" ]]; then
      [[ "$raw_size" == "-" && -z "$extra" ]] || return 1
      [[ -d "$file" && ! -L "$file" ]] || return 1
      gitlink_marker="${file}/.git"
      [[ -e "$gitlink_marker" && ! -L "$gitlink_marker" ]] || return 1
      gitlink_marker_identity="$("$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$gitlink_marker")" \
        || return 1
      [[ "$gitlink_marker_identity" == *":regular file" ||
        "$gitlink_marker_identity" == *":directory" ]] || return 1
      verify_exact_git_checkout "$file" "$object" || return 1
      gitlink_marker_identity_after="$("$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$gitlink_marker")" \
        || return 1
      [[ -e "$gitlink_marker" && ! -L "$gitlink_marker" &&
        "$gitlink_marker_identity_after" == "$gitlink_marker_identity" ]] || return 1
      continue
    fi
    [[ "$type" == "blob" ]] || return 1
    [[ -z "$extra" && "$raw_size" =~ ^(0|[1-9][0-9]{0,7})$ ]] || return 1
    ((10#$raw_size <= MAX_TRACKED_SOURCE_BYTES)) || return 1
    run_git -C "$repository" cat-file blob "$object" >"$authority_file" || return 1
    [[ "$("$STAT_BINARY" -Lc '%s' -- "$authority_file")" == "$raw_size" ]] || return 1
    if [[ "$mode" == "120000" ]]; then
      [[ -L "$file" ]] || return 1
      before_identity="$("$STAT_BINARY" -c '%d:%i:%f:%h:%s:%y:%z:%F' -- "$file")" || return 1
      [[ "$before_identity" == *":symbolic link" ]] || return 1
      "$READLINK_BINARY" -n -- "$file" >"$local_link_file" || return 1
      local_size="$("$STAT_BINARY" -Lc '%s' -- "$local_link_file")" || return 1
      [[ "$local_size" == "$raw_size" ]] || return 1
      "$CMP_BINARY" -s -- "$authority_file" "$local_link_file" || return 1
      after_identity="$("$STAT_BINARY" -c '%d:%i:%f:%h:%s:%y:%z:%F' -- "$file")" || return 1
      [[ "$after_identity" == "$before_identity" && -L "$file" ]] || return 1
    else
      [[ "$mode" == "100644" || "$mode" == "100755" ]] || return 1
      [[ -f "$file" && ! -L "$file" ]] || return 1
      before_identity="$("$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$file")" || return 1
      [[ "$before_identity" == *":regular file" ]] || return 1
      permissions="$("$STAT_BINARY" -Lc '%a' -- "$file")" || return 1
      [[ "$permissions" =~ ^[0-7]{3,4}$ ]] || return 1
      permission_value=$((8#$permissions))
      (((permission_value & 07022) == 0)) || return 1
      if [[ "$mode" == "100755" ]]; then
        (((permission_value & 0111) != 0)) || return 1
      else
        (((permission_value & 0111) == 0)) || return 1
      fi
      local_size="$("$STAT_BINARY" -Lc '%s' -- "$file")" || return 1
      [[ "$local_size" == "$raw_size" ]] || return 1
      "$CMP_BINARY" -s -- "$authority_file" "$file" || return 1
      after_identity="$("$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$file")" || return 1
      [[ "$after_identity" == "$before_identity" && -f "$file" && ! -L "$file" ]] || return 1
    fi
  done <"$tree_file"

  run_git -C "$repository" status --porcelain=v1 -z --untracked-files=normal >"$status_file" \
    || return 1
  [[ ! -s "$status_file" ]]
}

base_url="https://raw.githubusercontent.com/NVIDIA/NemoClaw/${NEMOCLAW_REF}/scripts/brev-launchable-ci-cpu.sh"
# `noclobber` gives the output redirection exclusive-create semantics. The
# private directory prevents an untrusted user from pre-positioning a link.
if ! (umask 077 && set -o noclobber && "$CURL_BINARY" -fsSL -- "$base_url" >"$base_script"); then
  fail "the exact base Launchable script could not be downloaded privately"
fi
[[ -f "$base_script" && ! -L "$base_script" ]] \
  || fail "the exact base Launchable script is not a regular file"
"$CHMOD_BINARY" 0500 "$base_script"
exec 9<"$base_script" \
  || fail "the exact base Launchable script could not be opened"
[[ -f /dev/fd/9 ]] \
  || fail "the exact base Launchable script descriptor is invalid"
"$RM_BINARY" -f -- "$base_script"

repository_url="https://github.com/NVIDIA/NemoClaw.git"
run_git clone --filter=blob:none --no-checkout -- "$repository_url" "$clone_dir"
run_git -C "$clone_dir" fetch --depth 1 -- "$repository_url" "$NEMOCLAW_REF"
run_git -C "$clone_dir" checkout --detach -- "$NEMOCLAW_REF"
run_git -c protocol.file.allow=never -C "$clone_dir" \
  submodule update --init --recursive --depth 1
verify_exact_git_checkout "$clone_dir" "$NEMOCLAW_REF" \
  || fail "the installed checkout is not an exact clean candidate"
"$CMP_BINARY" -s "$CUA_LAUNCHABLE_DESCRIPTOR" "$clone_dir/scripts/brev-launchable-cua-gpu.sh" \
  || fail "the executing Launchable does not match the exact candidate checkout"
"$CMP_BINARY" -s /dev/fd/9 "$clone_dir/scripts/brev-launchable-ci-cpu.sh" \
  || fail "the downloaded base Launchable script does not match the candidate checkout"

"$ENV_BINARY" -i \
  HOME="$base_home" \
  USER="$target_user" \
  LOGNAME="$target_user" \
  SUDO_USER="$target_user" \
  PATH="$RUNTIME_TOOL_DISCOVERY_PATH" \
  LC_ALL=C \
  LAUNCH_LOG="$base_launch_log" \
  NPM_CONFIG_USERCONFIG=/dev/null \
  NPM_CONFIG_GLOBALCONFIG=/dev/null \
  NEMOCLAW_REF="$NEMOCLAW_REF" \
  NEMOCLAW_CLONE_DIR="$clone_dir" \
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_SYSTEM=/dev/null \
  GIT_CONFIG_GLOBAL=/dev/null \
  GIT_NO_REPLACE_OBJECTS=1 \
  GIT_CONFIG_COUNT=6 \
  GIT_CONFIG_KEY_0=core.hooksPath \
  GIT_CONFIG_VALUE_0=/dev/null \
  GIT_CONFIG_KEY_1=core.fsmonitor \
  GIT_CONFIG_VALUE_1=false \
  GIT_CONFIG_KEY_2=core.untrackedCache \
  GIT_CONFIG_VALUE_2=false \
  GIT_CONFIG_KEY_3=core.attributesFile \
  GIT_CONFIG_VALUE_3=/dev/null \
  GIT_CONFIG_KEY_4=core.excludesFile \
  GIT_CONFIG_VALUE_4=/dev/null \
  GIT_CONFIG_KEY_5=credential.helper \
  GIT_CONFIG_VALUE_5= \
  /bin/bash /dev/fd/9
exec 9<&-
"$SUDO_BINARY" "$RM_BINARY" -f /var/run/nemoclaw-launchable-ready

node_tool_path=""
node_tool_digest=""
docker_tool_path=""
docker_tool_digest=""
nvidia_smi_tool_path=""
nvidia_smi_tool_digest=""
nvidia_ctk_tool_path=""
nvidia_ctk_tool_digest=""
resolve_root_host_tool node node_tool_path node_tool_digest \
  || fail "the qualification Node executable is not a trusted root authority"
[[ "$node_tool_path" == "$NODE_TARGET_BINARY" ]] \
  || fail "the qualification Node executable must resolve to /usr/bin/node for the target-channel probe"
resolve_root_host_tool docker docker_tool_path docker_tool_digest \
  || fail "the qualification Docker executable is not a trusted root authority"
resolve_root_host_tool nvidia-smi nvidia_smi_tool_path nvidia_smi_tool_digest \
  || fail "the qualification NVIDIA SMI executable is not a trusted root authority"
resolve_root_host_tool nvidia-ctk nvidia_ctk_tool_path nvidia_ctk_tool_digest \
  || fail "the qualification NVIDIA Container Toolkit executable is not a trusted root authority"

verify_exact_git_checkout "$clone_dir" "$NEMOCLAW_REF" \
  || fail "the installed checkout changed during candidate bootstrap"

if ! "$GETENT_BINARY" passwd "$CUA_ARTIFACT_USER" >/dev/null 2>&1; then
  "$SUDO_BINARY" "$USERADD_BINARY" \
    --system \
    --user-group \
    --home-dir /nonexistent \
    --no-create-home \
    --shell /usr/sbin/nologin \
    "$CUA_ARTIFACT_USER"
fi
artifact_passwd_entry="$("$GETENT_BINARY" passwd "$CUA_ARTIFACT_USER")" \
  || fail "the dedicated CUA artifact account is unavailable"
IFS=: read -r artifact_name _artifact_password artifact_uid artifact_gid _artifact_gecos \
  artifact_home artifact_shell <<<"$artifact_passwd_entry"
[[ "$artifact_name" == "$CUA_ARTIFACT_USER" && "$artifact_uid" =~ ^[1-9][0-9]*$ &&
  "$artifact_gid" =~ ^[1-9][0-9]*$ && "$artifact_home" == "/nonexistent" &&
  "$artifact_shell" == "/usr/sbin/nologin" &&
  "$("$ID_BINARY" -G "$CUA_ARTIFACT_USER")" == "$artifact_gid" ]] \
  || fail "the dedicated CUA artifact account is invalid"
artifact_runner_dir="${CUA_ARTIFACT_RUNNER%/*}"
"$SUDO_BINARY" "$INSTALL_BINARY" -d -o root -g root -m 0755 "$artifact_runner_dir"
assert_root_publication_directory "$artifact_runner_dir" \
  || fail "the CUA artifact runner directory is not a trusted root authority"
artifact_runner_temp="$(
  "$SUDO_BINARY" "$MKTEMP_BINARY" "${artifact_runner_dir}/.nemoclaw-cua-artifact-runner.XXXXXXXX"
)" \
  || fail "the CUA artifact runner temporary file could not be created"
"$SUDO_BINARY" "$INSTALL_BINARY" -o root -g root -m 0555 \
  "$clone_dir/scripts/cua-qualification-artifact-runner.sh" \
  "$artifact_runner_temp"
"$SUDO_BINARY" "$SYNC_BINARY" -f "$artifact_runner_temp"
[[ "$("$STAT_BINARY" -Lc '%u:%g:%a:%h:%F' -- "$artifact_runner_temp")" == "0:0:555:1:regular file" ]] \
  || fail "the CUA artifact runner temporary authority is invalid"
"$SUDO_BINARY" "$MV_BINARY" -fT -- "$artifact_runner_temp" "$CUA_ARTIFACT_RUNNER"
artifact_runner_temp=""
"$SUDO_BINARY" "$SYNC_BINARY" -f "$CUA_ARTIFACT_RUNNER"
[[ "$("$STAT_BINARY" -Lc '%u:%g:%a:%h:%F' -- "$CUA_ARTIFACT_RUNNER")" == "0:0:555:1:regular file" ]] \
  || fail "the CUA qualification artifact runner authority is invalid"
true_sha256_record="$("$SHA256SUM_BINARY" -- "$TRUE_BINARY")" \
  || fail "the fixed true helper digest is unavailable"
true_sha256="${true_sha256_record%% *}"
[[ "$true_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || fail "the fixed true helper digest is invalid"
"$CUA_ARTIFACT_RUNNER" \
  --no-target-channel \
  --artifact-sha256 "$true_sha256" \
  -- \
  "$TRUE_BINARY" </dev/null \
  || fail "the CUA qualification artifact isolation boundary is unavailable"

validate_cua_runtime_authority() {
  (
    cd "$clone_dir"
    NEMOCLAW_CUA_ENABLED=1 \
      NEMOCLAW_CUA_RUNTIME_MANIFEST="$NEMOCLAW_CUA_RUNTIME_MANIFEST" \
      NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256="$NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256" \
      NEMOCLAW_CUA_SANDBOX_IMAGE_REF="$NEMOCLAW_CUA_SANDBOX_IMAGE_REF" \
      NEMOCLAW_REF="$NEMOCLAW_REF" \
      NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256="$NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256" \
      "$node_tool_path" -e '
        const fs = require("node:fs");
        const path = require("node:path");
        const runtime = require("./dist/lib/cua/runtime-manifest.js");
        const buildIdentity = require("./dist/lib/cua/build-identity.js");
        const assertRootAuthority = (filePath, label) => {
          if (fs.realpathSync(filePath) !== filePath) {
            throw new Error(`${label} must have one canonical root authority path`);
          }
          const file = fs.lstatSync(filePath);
          if (
            !file.isFile() ||
            file.isSymbolicLink() ||
            file.uid !== 0 ||
            file.nlink !== 1 ||
            (file.mode & 0o022) !== 0
          ) {
            throw new Error(`${label} must be a root-owned immutable regular file`);
          }
          let directory = path.dirname(filePath);
          for (;;) {
            const ancestor = fs.lstatSync(directory);
            if (
              !ancestor.isDirectory() ||
              ancestor.isSymbolicLink() ||
              ancestor.uid !== 0 ||
              (ancestor.mode & 0o022) !== 0 ||
              fs.realpathSync(directory) !== directory
            ) {
              throw new Error(`${label} has an untrusted path ancestor`);
            }
            if (directory === path.parse(directory).root) break;
            directory = path.dirname(directory);
          }
        };
        const validation = { assertFileOwnership: assertRootAuthority };
        const loaded = runtime.loadCuaRuntimeManifest(process.env, validation);
        runtime.verifyCuaRuntimePayload(loaded);
        runtime.verifyCuaRuntimeAuthorityPayload(process.env, validation);
        runtime.getCuaSandboxImageRef(process.env, validation);
        const compatibility = loaded.manifest.compatibility;
        if (
          compatibility.status !== "candidate" ||
          compatibility.candidateSourceRevision !== process.env.NEMOCLAW_REF ||
          loaded.manifest.bundleReceipt.sha256 !== process.env.NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256
        ) {
          throw new Error("runtime manifest is not bound to this candidate and bundle receipt");
        }
        const build = buildIdentity.resolveCurrentCuaBuildIdentity({ rootDir: process.cwd() });
        if (build.sourceRevision !== process.env.NEMOCLAW_REF || build.sourceClean !== true) {
          throw new Error("compiled CUA build identity is not an exact clean candidate");
        }
        process.stdout.write(
          loaded.sha256 + "\t" +
            loaded.manifest.artifacts.targetImage.digest + "\tsha256:" +
            loaded.manifest.artifacts.targetServices.sha256,
        );
      '
  )
}

runtime_authority_record="$(validate_cua_runtime_authority)" \
  || fail "the sanitized CUA runtime payload failed exact candidate validation"
runtime_manifest_sha256=""
target_image_digest=""
service_bundle_digest=""
runtime_authority_extra=""
IFS=$'\t' read -r runtime_manifest_sha256 target_image_digest service_bundle_digest \
  runtime_authority_extra \
  <<<"$runtime_authority_record"
[[ "$runtime_manifest_sha256" == "$NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256" &&
  "$target_image_digest" =~ ^sha256:[0-9a-f]{64}$ &&
  "$service_bundle_digest" =~ ^sha256:[0-9a-f]{64}$ &&
  -z "$runtime_authority_extra" ]] \
  || fail "the runtime manifest content identity record is invalid"

target_channel_probe_path="$clone_dir/scripts/cua-qualification-target-channel-probe.ts"
target_channel_probe_sha256_record="$("$SHA256SUM_BINARY" -- "$target_channel_probe_path")" \
  || fail "the candidate target-channel probe digest is unavailable"
target_channel_probe_sha256="${target_channel_probe_sha256_record%% *}"
[[ "$target_channel_probe_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || fail "the candidate target-channel probe digest is invalid"
target_channel_record="$({
  "$CUA_ARTIFACT_RUNNER" \
    --require-target-channel \
    --artifact-sha256 "$target_channel_probe_sha256" \
    -- \
    "$target_channel_probe_path" \
    --isolated \
    "$artifact_gid" \
    "$service_bundle_digest" \
    "$target_image_digest" </dev/null
})" || fail "the image-provided CUA qualification target channel is unavailable"
expected_target_channel_record="$(
  printf '%s' \
    "{\"schemaVersion\":\"1.0.0\",\"kind\":\"cua-qualification-target-channel-identity\",\"protocol\":\"${CUA_TARGET_CHANNEL_PROTOCOL}\",\"serviceBundleDigest\":\"${service_bundle_digest}\",\"targetImageDigest\":\"${target_image_digest}\"}"
)"
[[ "$target_channel_record" == "$expected_target_channel_record" ]] \
  || fail "the image-provided CUA qualification target channel identity is invalid"

# Filesystem permissions are not a substitute for the server-side peer check.
# Root can bypass the socket mode, so a successful source-path identity probe
# here would prove that the service accepts a peer other than the dedicated
# artifact UID.
if "$SUDO_BINARY" "$ENV_BINARY" -i \
  HOME=/root \
  LANG=C \
  LC_ALL=C \
  PATH=/usr/bin:/bin \
  "$clone_dir/scripts/cua-qualification-target-channel-probe.ts" \
  --source \
  "$artifact_gid" \
  "$service_bundle_digest" \
  "$target_image_digest" \
  >/dev/null 2>&1; then
  fail "the CUA qualification target channel accepts an unauthorized root peer"
fi
probe_image_digest="${NEMOCLAW_CUA_GPU_PROBE_IMAGE##*@}"
[[ "$probe_image_digest" == "$target_image_digest" ]] \
  || fail "the GPU probe image does not match the pinned target image manifest digest"

"$SUDO_BINARY" "$nvidia_ctk_tool_path" runtime configure --runtime=docker
"$SUDO_BINARY" "$SYSTEMCTL_BINARY" restart docker
"$SUDO_BINARY" "$docker_tool_path" pull --quiet "$NEMOCLAW_CUA_GPU_PROBE_IMAGE" >/dev/null \
  || fail "the pinned GPU probe image could not be pulled"
probe_repo_digests="$(
  "$SUDO_BINARY" "$docker_tool_path" image inspect \
    --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    "$NEMOCLAW_CUA_GPU_PROBE_IMAGE"
)" || fail "the pinned GPU probe image identity could not be inspected"
probe_identity_found=0
while IFS= read -r repo_digest; do
  if [[ "$repo_digest" == "$NEMOCLAW_CUA_GPU_PROBE_IMAGE" ]]; then
    probe_identity_found=1
  fi
done <<<"$probe_repo_digests"
((probe_identity_found == 1)) \
  || fail "the pulled GPU probe image does not expose the pinned manifest identity"
"$SUDO_BINARY" "$docker_tool_path" run \
  --rm \
  --pull=never \
  --gpus=all \
  --env=NVIDIA_VISIBLE_DEVICES=all \
  --env=NVIDIA_DRIVER_CAPABILITIES=utility \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges=true \
  --pids-limit=32 \
  --cpus=1.0 \
  --memory=256m \
  --ulimit=nofile=64:64 \
  --user=65534:65534 \
  --entrypoint=/usr/bin/nvidia-smi \
  "$NEMOCLAW_CUA_GPU_PROBE_IMAGE" \
  || fail "the bounded pinned GPU probe failed"

gpu_names="$("$nvidia_smi_tool_path" --query-gpu=name --format=csv,noheader | "$TR_BINARY" -d '\r')"
gpu_count="$(printf '%s\n' "$gpu_names" | "$AWK_BINARY" 'NF { count++ } END { print count + 0 }')"
gpu_models="$(printf '%s\n' "$gpu_names" | "$AWK_BINARY" 'NF' | "$SORT_BINARY" -u)"
[[ "$(printf '%s\n' "$gpu_models" | "$AWK_BINARY" 'NF { count++ } END { print count + 0 }')" == "1" ]] \
  || fail "CUA qualification requires one homogeneous GPU model"
gpu_model="$(printf '%s\n' "$gpu_models" | "$HEAD_BINARY" -n 1)"
driver_versions="$(
  "$nvidia_smi_tool_path" --query-gpu=driver_version --format=csv,noheader \
    | "$TR_BINARY" -d '\r' \
    | "$AWK_BINARY" 'NF' \
    | "$SORT_BINARY" -u
)"
[[ "$(printf '%s\n' "$driver_versions" | "$AWK_BINARY" 'NF { count++ } END { print count + 0 }')" == "1" ]] \
  || fail "CUA qualification requires one homogeneous GPU driver version"
driver_version="$(printf '%s\n' "$driver_versions" | "$HEAD_BINARY" -n 1)"
cuda_version="$(
  "$nvidia_smi_tool_path" \
    | "$SED_BINARY" -n 's/.*CUDA Version: \([0-9][0-9.]*\).*/\1/p' \
    | "$HEAD_BINARY" -n 1
)"
toolkit_version="$(
  "$nvidia_ctk_tool_path" --version \
    | "$GREP_BINARY" -oE '[0-9]+[.][0-9]+[.][0-9]+' \
    | "$HEAD_BINARY" -n 1
)"

[[ "$gpu_count" =~ ^[1-9][0-9]*$ && -n "$gpu_model" && -n "$driver_version" &&
  -n "$cuda_version" && -n "$toolkit_version" ]] \
  || fail "GPU identity discovery returned an incomplete record"

# Recheck both immutable authorities immediately before privileged state
# publication. Any chmod, write, pathname swap, checkout mutation, or script
# substitution since the initial validation fails closed.
launchable_publication_identity="$(
  "$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$CUA_LAUNCHABLE_DESCRIPTOR"
)" || fail "the executing Launchable authority changed before publication"
[[ "$launchable_publication_identity" == "$launchable_authority_identity" ]] \
  || fail "the executing Launchable authority changed before publication"
[[ "$("$STAT_BINARY" -Lc '%u:%g' -- "$CUA_LAUNCHABLE_DESCRIPTOR")" == "0:0" ]] \
  || fail "the executing Launchable authority changed before publication"
[[ "$("$STAT_BINARY" -Lc '%a' -- "$CUA_LAUNCHABLE_DESCRIPTOR")" == "$launchable_authority_mode" ]] \
  || fail "the executing Launchable authority changed before publication"
launchable_publication_path_identity="$(
  "$STAT_BINARY" -Lc '%d:%i:%f:%h:%s:%y:%z:%F' -- "$launchable_authority_path"
)" || fail "the executing Launchable path changed before publication"
[[ "$("$REALPATH_BINARY" -- "$CUA_LAUNCHABLE_DESCRIPTOR")" == "$launchable_authority_path" &&
"$launchable_publication_path_identity" == "$launchable_authority_identity" ]] \
  || fail "the executing Launchable path changed before publication"
assert_root_authority_ancestors "$launchable_authority_path" \
  || fail "the executing Launchable path changed before publication"
[[ "$("$SHA256SUM_BINARY" "$CUA_LAUNCHABLE_DESCRIPTOR" | "$AWK_BINARY" '{print $1}')" == "$launchable_digest" ]] \
  || fail "the executing Launchable bytes changed before publication"
verify_exact_git_checkout "$clone_dir" "$NEMOCLAW_REF" \
  || fail "the installed checkout changed before publication"
"$CMP_BINARY" -s "$CUA_LAUNCHABLE_DESCRIPTOR" "$clone_dir/scripts/brev-launchable-cua-gpu.sh" \
  || fail "the executing Launchable no longer matches the candidate checkout"
[[ "$("$STAT_BINARY" -Lc '%u:%g:%a:%h:%F' -- "$CUA_ARTIFACT_RUNNER")" == "0:0:555:1:regular file" ]] \
  || fail "the CUA artifact runner authority changed before publication"
"$CMP_BINARY" -s "$CUA_ARTIFACT_RUNNER" "$clone_dir/scripts/cua-qualification-artifact-runner.sh" \
  || fail "the CUA artifact runner bytes changed before publication"
qualification_environment_dir="${QUALIFICATION_ENVIRONMENT_FILE%/*}"
"$SUDO_BINARY" "$INSTALL_BINARY" -d -o root -g root -m 0755 "$qualification_environment_dir"
assert_root_publication_directory "$qualification_environment_dir" \
  || fail "the qualification environment directory is not a trusted root authority"
profile_dir="${CUA_PROFILE_FILE%/*}"
sentinel_dir="${CUA_SENTINEL%/*}"
assert_root_publication_directory "$profile_dir" \
  || fail "the CUA profile directory is not a trusted root authority"
assert_root_publication_directory "$sentinel_dir" \
  || fail "the CUA sentinel directory is not a trusted root authority"
qualification_environment_temp="$(
  "$SUDO_BINARY" "$MKTEMP_BINARY" \
    "${qualification_environment_dir}/.cua-qualification-environment.XXXXXXXX"
)" || fail "the qualification environment temporary file could not be created"
assert_root_publication_temp \
  "$qualification_environment_temp" \
  "${qualification_environment_dir}/.cua-qualification-environment." \
  || fail "the qualification environment temporary file is not a trusted root authority"
"$JQ_BINARY" -n \
  --arg schemaVersion "1.0.0" \
  --arg launchableVersion "$CUA_LAUNCHABLE_VERSION" \
  --arg launchableDigest "sha256:${launchable_digest}" \
  --arg nemoclawCommit "$NEMOCLAW_REF" \
  --argjson gpuCount "$gpu_count" \
  --arg gpuModel "$gpu_model" \
  --arg driverVersion "$driver_version" \
  --arg cudaVersion "$cuda_version" \
  --arg toolkitVersion "$toolkit_version" \
  --arg probeImageDigest "$probe_image_digest" \
  --arg nodeToolDigest "$node_tool_digest" \
  --arg dockerToolDigest "$docker_tool_digest" \
  --arg nvidiaSmiToolDigest "$nvidia_smi_tool_digest" \
  --arg nvidiaCtkToolDigest "$nvidia_ctk_tool_digest" \
  --arg bundleReceiptSha256 "$NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256" \
  --arg targetChannelProtocol "$CUA_TARGET_CHANNEL_PROTOCOL" \
  --arg targetChannelServiceBundleDigest "$service_bundle_digest" \
  --arg targetChannelTargetImageDigest "$target_image_digest" \
  '{
    schemaVersion: $schemaVersion,
    kind: "cua-qualification-environment",
    launchable: {
      version: $launchableVersion,
      digest: $launchableDigest
    },
    nemoclawCommit: $nemoclawCommit,
    bundleReceiptSha256: $bundleReceiptSha256,
    gpu: {
      count: $gpuCount,
      model: $gpuModel,
      driverVersion: $driverVersion,
      cudaVersion: $cudaVersion,
      containerToolkitVersion: $toolkitVersion,
      probeImageDigest: $probeImageDigest
    },
    hostTools: {
      node: $nodeToolDigest,
      docker: $dockerToolDigest,
      nvidiaSmi: $nvidiaSmiToolDigest,
      nvidiaCtk: $nvidiaCtkToolDigest
    },
    targetChannel: {
      schemaVersion: "1.0.0",
      kind: "cua-qualification-target-channel-identity",
      protocol: $targetChannelProtocol,
      serviceBundleDigest: $targetChannelServiceBundleDigest,
      targetImageDigest: $targetChannelTargetImageDigest
    }
  }' \
  | "$SUDO_BINARY" "$TEE_BINARY" "$qualification_environment_temp" >/dev/null
"$SUDO_BINARY" "$SYNC_BINARY" -f "$qualification_environment_temp"
"$SUDO_BINARY" "$CHOWN_BINARY" root:root "$qualification_environment_temp"
"$SUDO_BINARY" "$CHMOD_BINARY" 0444 "$qualification_environment_temp"
"$SUDO_BINARY" "$SYNC_BINARY" -f "$qualification_environment_temp"
qualification_environment_sha256="$(
  "$SHA256SUM_BINARY" "$qualification_environment_temp" | "$AWK_BINARY" '{print $1}'
)" || fail "the qualification environment could not be hashed"
[[ "$qualification_environment_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || fail "the qualification environment digest is invalid"
activation_line="nemoclaw-cua-launchable-ready/v1 commit=${NEMOCLAW_REF} environment=sha256:${qualification_environment_sha256} launchable=sha256:${launchable_digest}"

profile_temp="$("$SUDO_BINARY" "$MKTEMP_BINARY" "${profile_dir}/.nemoclaw-cua.XXXXXXXX")" \
  || fail "the CUA profile temporary file could not be created"
assert_root_publication_temp "$profile_temp" "${profile_dir}/.nemoclaw-cua." \
  || fail "the CUA profile temporary file is not a trusted root authority"
{
  printf '%s\n' "nemoclaw_cua_ready_line=''"
  printf '%s\n' "nemoclaw_cua_profile_line=''"
  printf '%s\n' "nemoclaw_cua_sentinel_lines=''"
  printf 'nemoclaw_cua_environment_digest=$(/usr/bin/sha256sum %q) || nemoclaw_cua_environment_digest=\n' \
    "$QUALIFICATION_ENVIRONMENT_FILE"
  printf '%s\n' 'nemoclaw_cua_environment_digest=${nemoclaw_cua_environment_digest%% *}'
  printf 'nemoclaw_cua_profile_digest=$(/usr/bin/sha256sum %q) || nemoclaw_cua_profile_digest=\n' \
    "$CUA_PROFILE_FILE"
  printf '%s\n' 'nemoclaw_cua_profile_digest=${nemoclaw_cua_profile_digest%% *}'
  printf 'nemoclaw_cua_ready_line=$(/usr/bin/sed -n 1p %q) || nemoclaw_cua_ready_line=\n' \
    "$CUA_SENTINEL"
  printf 'nemoclaw_cua_profile_line=$(/usr/bin/sed -n 2p %q) || nemoclaw_cua_profile_line=\n' \
    "$CUA_SENTINEL"
  printf "nemoclaw_cua_sentinel_lines=\$(/usr/bin/sed -n '\$=' %q) || nemoclaw_cua_sentinel_lines=\n" \
    "$CUA_SENTINEL"
  printf '%s\n' 'if [ "$nemoclaw_cua_sentinel_lines" = 2 ] \'
  printf '  && [ "$nemoclaw_cua_ready_line" = %q ] \\\n' "$activation_line"
  printf '%s\n' '  && [ "$nemoclaw_cua_profile_line" = "profile=sha256:${nemoclaw_cua_profile_digest}" ] \'
  printf '  && [ "$nemoclaw_cua_environment_digest" = %q ]; then\n' \
    "$qualification_environment_sha256"
  printf '%s\n' '  export NEMOCLAW_CUA_ENABLED=1'
  printf '%s\n' '  export NEMOCLAW_CUA_QUALIFICATION=1'
  printf '%s\n' '  export NEMOCLAW_AGENT=nemocua'
  printf '  export NEMOCLAW_CUA_RUNTIME_MANIFEST=%q\n' "$NEMOCLAW_CUA_RUNTIME_MANIFEST"
  printf '  export NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256=%q\n' \
    "$NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256"
  printf '  export NEMOCLAW_CUA_SANDBOX_IMAGE_REF=%q\n' "$NEMOCLAW_CUA_SANDBOX_IMAGE_REF"
  printf '  export NEMOCLAW_CUA_DOCKER_BIN=%q\n' "$docker_tool_path"
  printf '  export NEMOCLAW_CUA_NVIDIA_SMI_BIN=%q\n' "$nvidia_smi_tool_path"
  printf '  export NEMOCLAW_CUA_NVIDIA_CTK_BIN=%q\n' "$nvidia_ctk_tool_path"
  printf '  export NEMOCLAW_CUA_QUALIFICATION_ENVIRONMENT=%q\n' \
    "$QUALIFICATION_ENVIRONMENT_FILE"
  printf '  export NEMOCLAW_CUA_QUALIFICATION_ARTIFACT_RUNNER=%q\n' \
    "$CUA_ARTIFACT_RUNNER"
  printf '%s\n' 'fi'
  printf '%s\n' 'unset nemoclaw_cua_ready_line nemoclaw_cua_profile_line nemoclaw_cua_sentinel_lines nemoclaw_cua_environment_digest nemoclaw_cua_profile_digest'
} | "$SUDO_BINARY" "$TEE_BINARY" "$profile_temp" >/dev/null
"$SUDO_BINARY" "$SYNC_BINARY" -f "$profile_temp"
"$SUDO_BINARY" "$CHOWN_BINARY" root:root "$profile_temp"
"$SUDO_BINARY" "$CHMOD_BINARY" 0444 "$profile_temp"
"$SUDO_BINARY" "$SYNC_BINARY" -f "$profile_temp"
profile_sha256="$("$SHA256SUM_BINARY" "$profile_temp" | "$AWK_BINARY" '{print $1}')" \
  || fail "the CUA profile could not be hashed"
[[ "$profile_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "the CUA profile digest is invalid"

sentinel_temp="$("$SUDO_BINARY" "$MKTEMP_BINARY" "${sentinel_dir}/.nemoclaw-cua-ready.XXXXXXXX")" \
  || fail "the CUA readiness sentinel temporary file could not be created"
assert_root_publication_temp "$sentinel_temp" "${sentinel_dir}/.nemoclaw-cua-ready." \
  || fail "the CUA readiness sentinel temporary file is not a trusted root authority"
{
  printf '%s\n' "$activation_line"
  printf 'profile=sha256:%s\n' "$profile_sha256"
} | "$SUDO_BINARY" "$TEE_BINARY" "$sentinel_temp" >/dev/null
"$SUDO_BINARY" "$SYNC_BINARY" -f "$sentinel_temp"
"$SUDO_BINARY" "$CHOWN_BINARY" root:root "$sentinel_temp"
"$SUDO_BINARY" "$CHMOD_BINARY" 0444 "$sentinel_temp"
"$SUDO_BINARY" "$SYNC_BINARY" -f "$sentinel_temp"

# Rerun the closed manifest and every declared payload check after all probe
# work. Activation is allowed only if this root-only authority pass returns the
# same manifest bytes and target image identity as the initial pass.
publication_runtime_authority_record="$(validate_cua_runtime_authority)" \
  || fail "the sanitized CUA runtime payload changed before publication"
publication_runtime_manifest_sha256=""
publication_target_image_digest=""
publication_service_bundle_digest=""
publication_runtime_authority_extra=""
IFS=$'\t' read -r \
  publication_runtime_manifest_sha256 \
  publication_target_image_digest \
  publication_service_bundle_digest \
  publication_runtime_authority_extra \
  <<<"$publication_runtime_authority_record"
[[ "$publication_runtime_manifest_sha256" == "$runtime_manifest_sha256" &&
  "$publication_target_image_digest" == "$target_image_digest" &&
  "$publication_service_bundle_digest" == "$service_bundle_digest" &&
  -z "$publication_runtime_authority_extra" ]] \
  || fail "the CUA runtime manifest, target image, or service bundle changed before publication"

# Re-resolve and rehash every exact tool authority immediately before the
# first atomic publication. No tool lookup or generated record may change
# between this comparison and the environment/profile/sentinel rename tuple.
publication_node_tool_path=""
publication_node_tool_digest=""
publication_docker_tool_path=""
publication_docker_tool_digest=""
publication_nvidia_smi_tool_path=""
publication_nvidia_smi_tool_digest=""
publication_nvidia_ctk_tool_path=""
publication_nvidia_ctk_tool_digest=""
resolve_root_host_tool node publication_node_tool_path publication_node_tool_digest \
  || fail "the qualification Node executable changed before publication"
resolve_root_host_tool docker publication_docker_tool_path publication_docker_tool_digest \
  || fail "the qualification Docker executable changed before publication"
resolve_root_host_tool \
  nvidia-smi \
  publication_nvidia_smi_tool_path \
  publication_nvidia_smi_tool_digest \
  || fail "the qualification NVIDIA SMI executable changed before publication"
resolve_root_host_tool \
  nvidia-ctk \
  publication_nvidia_ctk_tool_path \
  publication_nvidia_ctk_tool_digest \
  || fail "the qualification NVIDIA Container Toolkit executable changed before publication"
[[ "$publication_node_tool_path" == "$node_tool_path" &&
  "$publication_node_tool_digest" == "$node_tool_digest" &&
  "$publication_docker_tool_path" == "$docker_tool_path" &&
  "$publication_docker_tool_digest" == "$docker_tool_digest" &&
  "$publication_nvidia_smi_tool_path" == "$nvidia_smi_tool_path" &&
  "$publication_nvidia_smi_tool_digest" == "$nvidia_smi_tool_digest" &&
  "$publication_nvidia_ctk_tool_path" == "$nvidia_ctk_tool_path" &&
  "$publication_nvidia_ctk_tool_digest" == "$nvidia_ctk_tool_digest" ]] \
  || fail "a qualification host executable changed before publication"

"$SUDO_BINARY" "$MV_BINARY" -fT -- \
  "$qualification_environment_temp" "$QUALIFICATION_ENVIRONMENT_FILE"
qualification_environment_temp=""
"$SUDO_BINARY" "$SYNC_BINARY" -f "$qualification_environment_dir"
"$SUDO_BINARY" "$MV_BINARY" -fT -- "$profile_temp" "$CUA_PROFILE_FILE"
profile_temp=""
"$SUDO_BINARY" "$SYNC_BINARY" -f "$profile_dir"
"$SUDO_BINARY" "$MV_BINARY" -fT -- "$sentinel_temp" "$CUA_SENTINEL"
sentinel_temp=""
"$SUDO_BINARY" "$SYNC_BINARY" -f "$sentinel_dir"

assert_published_root_file "$QUALIFICATION_ENVIRONMENT_FILE" \
  || fail "the published qualification environment authority is invalid"
assert_published_root_file "$CUA_PROFILE_FILE" \
  || fail "the published CUA profile authority is invalid"
assert_published_root_file "$CUA_SENTINEL" \
  || fail "the published CUA readiness authority is invalid"
[[ "$("$SHA256SUM_BINARY" "$QUALIFICATION_ENVIRONMENT_FILE" | "$AWK_BINARY" '{print $1}')" == "$qualification_environment_sha256" ]] \
  || fail "the published qualification environment changed"
[[ "$("$SHA256SUM_BINARY" "$CUA_PROFILE_FILE" | "$AWK_BINARY" '{print $1}')" == "$profile_sha256" ]] \
  || fail "the published CUA profile changed"
published_sentinel_first=""
published_sentinel_second=""
published_sentinel_extra=""
IFS= read -r published_sentinel_first <"$CUA_SENTINEL" \
  || fail "the published CUA readiness authority is incomplete"
IFS= read -r published_sentinel_second < <("$SED_BINARY" -n '2p' "$CUA_SENTINEL") \
  || fail "the published CUA readiness authority is incomplete"
if IFS= read -r published_sentinel_extra < <("$SED_BINARY" -n '3p' "$CUA_SENTINEL"); then
  : "$published_sentinel_extra"
  fail "the published CUA readiness authority has extra content"
fi
[[ "$published_sentinel_first" == "$activation_line" &&
  "$published_sentinel_second" == "profile=sha256:${profile_sha256}" ]] \
  || fail "the published CUA readiness authority is not content-bound"
cua_publication_complete=1

printf 'brev-launchable-cua-gpu: ready (version %s, candidate %s)\n' \
  "$CUA_LAUNCHABLE_VERSION" "$NEMOCLAW_REF"
