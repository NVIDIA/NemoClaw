#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
umask 077

MAX_INSTALLER_BYTES=524288
MAX_SETUP_SCRIPT_BYTES=131072
MAX_JSON_BYTES=4096
CANONICAL_REPOSITORY="https://github.com/NVIDIA/NemoClaw.git"

usage() {
  printf '%s\n' \
    "Usage: $0 --candidate-checkout <path> --candidate-sha <commit-sha> --installer-sha256 <sha256> --architecture <amd64|arm64> --artifact-dir <path>"
}

fail() {
  printf 'Native runtime installer qualification failed: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 \
    || fail "$1 is required for native runtime installer qualification."
}

file_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

trusted_git() {
  (
    export GIT_CONFIG_GLOBAL=/dev/null
    export GIT_CONFIG_NOSYSTEM=1
    export GIT_NO_REPLACE_OBJECTS=1
    command git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
  )
}

bounded_file() {
  local file_path="$1"
  local maximum_bytes="$2"
  local byte_count=""
  byte_count="$(wc -c <"$file_path" | tr -d '[:space:]')"
  [[ "$byte_count" =~ ^[0-9]+$ && "$byte_count" -le "$maximum_bytes" ]] \
    || fail "$(basename "$file_path") exceeds its receipt size limit."
}

assert_canonical_directory() {
  local directory="$1"
  local label="$2"
  local canonical=""

  [[ "$directory" == /* && -d "$directory" && ! -L "$directory" && -O "$directory" ]] \
    || fail "$label must be an absolute, non-symlinked directory owned by the qualification process UID."
  canonical="$(cd "$directory" && pwd -P)"
  [[ "$canonical" == "$directory" ]] \
    || fail "$label must not contain symbolic links or path traversal."
}

assert_checkout_has_no_git_credentials() {
  local checkout="$1"
  local label="$2"
  if trusted_git -C "$checkout" config --local --no-includes --get-regexp '^credential\.' >/dev/null 2>&1 \
    || trusted_git -C "$checkout" config --local --no-includes --get-regexp '^http\..*\.extraheader$' >/dev/null 2>&1; then
    fail "$label must not store Git credentials."
  fi
}

verify_checkout() {
  local checkout="$1"
  local expected_revision="$2"
  local label="$3"
  local repository_root=""
  local revision=""
  local remote=""
  local -a remote_urls=()

  assert_canonical_directory "$checkout" "$label"
  [[ -e "${checkout}/.git" && ! -L "${checkout}/.git" ]] \
    || fail "$label must contain Git metadata that is not a symbolic link."
  repository_root="$(trusted_git -C "$checkout" rev-parse --show-toplevel 2>/dev/null)" \
    || fail "$label is not a Git checkout."
  [[ "$(cd "$repository_root" && pwd -P)" == "$checkout" ]] \
    || fail "$label must be the repository root."
  revision="$(trusted_git -C "$checkout" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" \
    || fail "$label does not identify a commit."
  [[ "$revision" == "$expected_revision" ]] \
    || fail "$label does not match the candidate commit."
  mapfile -t remote_urls < <(
    trusted_git -C "$checkout" config --local --no-includes --get-all remote.origin.url 2>/dev/null
  )
  [[ "${#remote_urls[@]}" -eq 1 ]] || fail "$label must have one origin repository."
  remote="${remote_urls[0]}"
  case "$remote" in
    "$CANONICAL_REPOSITORY" | "${CANONICAL_REPOSITORY%.git}") ;;
    *) fail "$label has an unexpected origin repository." ;;
  esac
  assert_checkout_has_no_git_credentials "$checkout" "$label"
}

verify_committed_file() {
  local checkout="$1"
  local revision="$2"
  local relative_path="$3"
  local file_path="$4"
  local label="$5"
  local maximum_bytes="$6"
  local committed_blob=""
  local working_blob=""

  [[ -f "$file_path" && ! -L "$file_path" && -O "$file_path" ]] \
    || fail "$label must be a non-symlinked regular file owned by the qualification process UID."
  bounded_file "$file_path" "$maximum_bytes"
  committed_blob="$(trusted_git -C "$checkout" rev-parse "${revision}:${relative_path}" 2>/dev/null)" \
    || fail "The candidate commit does not contain ${relative_path}."
  working_blob="$(trusted_git hash-object --no-filters "$file_path" 2>/dev/null)" \
    || fail "Could not identify the Git object for ${label}."
  [[ "$working_blob" == "$committed_blob" ]] \
    || fail "$label bytes do not match the candidate commit."
}

verify_installer() {
  local checkout="$1"
  local revision="$2"
  local installer="$3"
  local expected_sha256="$4"
  local actual_sha256=""

  verify_committed_file \
    "$checkout" \
    "$revision" \
    "scripts/install.sh" \
    "$installer" \
    "The candidate installer" \
    "$MAX_INSTALLER_BYTES"
  actual_sha256="$(file_sha256 "$installer")"
  [[ "$actual_sha256" == "$expected_sha256" ]] \
    || fail "The candidate installer SHA-256 does not match the trusted plan."
}

docker_socket_paths() {
  printf '%s\n' /var/run/docker.sock /run/docker.sock
  if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
    printf '%s\n' "${XDG_RUNTIME_DIR%/}/docker.sock"
  fi
}

assert_docker_unavailable() {
  local phase="$1"
  local docker_guard="$2"
  local expected_guard_sha256="$3"
  local docker_command=""
  local actual_guard_sha256=""
  local guard_status=0
  local socket_path=""
  local variable_name=""

  for variable_name in DOCKER_CERT_PATH DOCKER_CONFIG DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY; do
    [[ -z "${!variable_name:-}" ]] \
      || fail "${variable_name} must be unset during the ${phase} Docker check."
  done

  [[ -f "$docker_guard" && -x "$docker_guard" && ! -L "$docker_guard" && -O "$docker_guard" ]] \
    || fail "The Docker command guard has invalid file properties during the ${phase} check."
  actual_guard_sha256="$(file_sha256 "$docker_guard")"
  [[ "$actual_guard_sha256" == "$expected_guard_sha256" ]] \
    || fail "The Docker command guard bytes changed before the ${phase} check."
  docker_command="$(type -P docker 2>/dev/null || true)"
  [[ "$docker_command" == "$docker_guard" ]] \
    || fail "Docker commands must resolve to the qualification guard during the ${phase} check."
  "$docker_guard" >/dev/null 2>&1 || guard_status=$?
  [[ "$guard_status" -eq 97 ]] \
    || fail "The Docker command guard did not deny execution during the ${phase} check."

  require_command systemctl
  if systemctl is-active --quiet docker.service 2>/dev/null; then
    fail "docker.service is active during the ${phase} check."
  fi
  if systemctl is-active --quiet docker.socket 2>/dev/null; then
    fail "docker.socket is active during the ${phase} check."
  fi
  require_command pgrep
  if pgrep -x dockerd >/dev/null 2>&1; then
    fail "dockerd is running during the ${phase} check."
  fi

  while IFS= read -r socket_path; do
    [[ -n "$socket_path" ]] || continue
    [[ ! -S "$socket_path" ]] \
      || fail "A Docker socket exists during the ${phase} check."
  done < <(docker_socket_paths)
}

run_native_runtime_installer_qualification() {
  candidate_checkout=""
  candidate_sha=""
  expected_installer_sha256=""
  expected_architecture=""
  artifact_dir_input=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --candidate-checkout)
        [[ "$#" -ge 2 ]] || fail "--candidate-checkout requires a value."
        candidate_checkout="$2"
        shift 2
        ;;
      --candidate-sha)
        [[ "$#" -ge 2 ]] || fail "--candidate-sha requires a value."
        candidate_sha="$2"
        shift 2
        ;;
      --installer-sha256)
        [[ "$#" -ge 2 ]] || fail "--installer-sha256 requires a value."
        expected_installer_sha256="$2"
        shift 2
        ;;
      --architecture)
        [[ "$#" -ge 2 ]] || fail "--architecture requires a value."
        expected_architecture="$2"
        shift 2
        ;;
      --artifact-dir)
        [[ "$#" -ge 2 ]] || fail "--artifact-dir requires a value."
        artifact_dir_input="$2"
        shift 2
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        usage >&2
        fail "Unknown argument: $1"
        ;;
    esac
  done

  for required_command in awk bash git mktemp pgrep sha256sum systemctl wc; do
    require_command "$required_command"
  done

  [[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] \
    || fail "--candidate-sha must be a lowercase 40-character commit SHA."
  [[ "$expected_installer_sha256" =~ ^[0-9a-f]{64}$ ]] \
    || fail "--installer-sha256 must be a lowercase SHA-256 digest."
  case "$expected_architecture" in
    amd64 | arm64) ;;
    *) fail "--architecture must be amd64 or arm64." ;;
  esac
  assert_canonical_directory "$candidate_checkout" "The candidate checkout"

  [[ "$artifact_dir_input" == /* ]] \
    || fail "--artifact-dir must be an absolute path."
  [[ ! -e "$artifact_dir_input" && ! -L "$artifact_dir_input" ]] \
    || fail "--artifact-dir must not already exist."
  artifact_parent="$(dirname "$artifact_dir_input")"
  artifact_name="$(basename "$artifact_dir_input")"
  [[ "$artifact_name" =~ ^[A-Za-z0-9._-]+$ && "$artifact_name" != "." && "$artifact_name" != ".." ]] \
    || fail "--artifact-dir must end with a simple directory name."
  assert_canonical_directory "$artifact_parent" "The artifact parent"
  artifact_dir="${artifact_parent}/${artifact_name}"

  case "$(uname -m)" in
    x86_64) runner_architecture=amd64 ;;
    aarch64 | arm64) runner_architecture=arm64 ;;
    *) fail "This runner architecture is not supported by native runtime qualification." ;;
  esac
  [[ "$runner_architecture" == "$expected_architecture" ]] \
    || fail "The requested architecture does not match the runner architecture."

  candidate_installer="${candidate_checkout}/scripts/install.sh"
  candidate_setup_script="${candidate_checkout}/scripts/setup-jetson.sh"
  verify_checkout "$candidate_checkout" "$candidate_sha" "The candidate checkout"
  verify_installer \
    "$candidate_checkout" \
    "$candidate_sha" \
    "$candidate_installer" \
    "$expected_installer_sha256"
  verify_committed_file \
    "$candidate_checkout" \
    "$candidate_sha" \
    "scripts/setup-jetson.sh" \
    "$candidate_setup_script" \
    "The candidate setup script" \
    "$MAX_SETUP_SCRIPT_BYTES"

  qualification_root="$(mktemp -d /tmp/nemoclaw-native-runtime-installer.XXXXXX)"
  qualification_home="${qualification_root}/home"
  qualification_tmp="${qualification_root}/tmp"
  docker_guard_dir="${qualification_root}/docker-guard"
  managed_payload_root="${qualification_root}/managed-installer-payload"
  verified_script_dir="${qualification_root}/candidate-scripts"
  verified_installer="${verified_script_dir}/install.sh"
  verified_setup_script="${verified_script_dir}/setup-jetson.sh"
  installed_checkout="${qualification_home}/.nemoclaw/source"
  receipt_stage="$(mktemp -d "${artifact_parent}/.${artifact_name}.XXXXXX")"
  mkdir -m 700 \
    "$qualification_home" \
    "$qualification_tmp" \
    "$docker_guard_dir" \
    "$managed_payload_root" \
    "$verified_script_dir"

  cleanup() {
    if [[ -n "${receipt_stage:-}" && -d "$receipt_stage" && ! -L "$receipt_stage" ]]; then
      rm -rf -- "$receipt_stage"
    fi
    if [[ -n "${qualification_root:-}" && -d "$qualification_root" && ! -L "$qualification_root" ]]; then
      rm -rf -- "$qualification_root"
    fi
  }
  trap cleanup EXIT

  cp -- "$candidate_installer" "$verified_installer"
  cp -- "$candidate_setup_script" "$verified_setup_script"
  chmod 500 "$verified_installer" "$verified_setup_script"
  [[ "$(file_sha256 "$verified_installer")" == "$expected_installer_sha256" ]] \
    || fail "The verified installer copy changed before execution."
  verify_committed_file \
    "$candidate_checkout" \
    "$candidate_sha" \
    "scripts/setup-jetson.sh" \
    "$verified_setup_script" \
    "The verified setup script" \
    "$MAX_SETUP_SCRIPT_BYTES"

  docker_guard="${docker_guard_dir}/docker"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "Docker commands are blocked during native runtime installer qualification.\\n" >&2' \
    'exit 97' >"$docker_guard"
  chmod 500 "$docker_guard"
  docker_guard_sha256="$(file_sha256 "$docker_guard")"
  PATH="${docker_guard_dir}:${PATH}"
  export PATH

  assert_docker_unavailable "pre-execution" "$docker_guard" "$docker_guard_sha256"

  candidate_status=0
  # The child shell expands positional parameters inside this literal program.
  # shellcheck disable=SC2016
  env -i \
    ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    HOME="$qualification_home" \
    LANG=C.UTF-8 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_DEFER_OPENSHELL_INSTALL=1 \
    NEMOCLAW_INSTALL_REF="$candidate_sha" \
    NEMOCLAW_NO_EXPRESS=1 \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_REPO_ROOT="$managed_payload_root" \
    NEMOCLAW_SHIM_DIR="${qualification_home}/.local/bin" \
    NON_INTERACTIVE=1 \
    NO_COLOR=1 \
    PATH="$PATH" \
    TMPDIR="$qualification_tmp" \
    bash --noprofile --norc -c '
    set -euo pipefail
    source "$1"
    SCRIPT_DIR="$2"
    _INSTALLER_SCRIPT_PATH="$1"
    declare -F install_nemoclaw_before_onboarding >/dev/null \
      || { printf "Candidate installer has no pre-onboarding phase executor.\n" >&2; exit 96; }
    install_nemoclaw_before_onboarding
  ' _ "$verified_installer" "$verified_script_dir" || candidate_status=$?

  assert_docker_unavailable "post-execution" "$docker_guard" "$docker_guard_sha256"
  [[ "$candidate_status" -eq 0 ]] \
    || fail "The candidate installer phase executor exited with status ${candidate_status}."

  verify_checkout "$installed_checkout" "$candidate_sha" "The installed checkout"
  verify_installer \
    "$installed_checkout" \
    "$candidate_sha" \
    "${installed_checkout}/scripts/install.sh" \
    "$expected_installer_sha256"

  cp -- "$verified_installer" "${receipt_stage}/installer.sh"
  printf '{"receiptVersion":1,"script":"scripts/install.sh","scriptSha256":"%s","candidateSha":"%s","architecture":"%s"}\n' \
    "$expected_installer_sha256" "$candidate_sha" "$runner_architecture" \
    >"${receipt_stage}/invocation.json"
  printf '{"receiptVersion":1,"repository":"%s","revision":"%s","installerSha256":"%s"}\n' \
    "$CANONICAL_REPOSITORY" "$candidate_sha" "$expected_installer_sha256" \
    >"${receipt_stage}/candidate-source.json"
  printf '{"receiptVersion":1,"repository":"%s","requestedRevision":"%s","installedRevision":"%s","installMode":"managed","installerSha256":"%s"}\n' \
    "$CANONICAL_REPOSITORY" "$candidate_sha" "$candidate_sha" "$expected_installer_sha256" \
    >"${receipt_stage}/installed-source.json"
  printf '{"receiptVersion":1,"requested":"%s","runner":"%s"}\n' \
    "$expected_architecture" "$runner_architecture" \
    >"${receipt_stage}/architecture.json"
  printf '%s\n' \
    '{"receiptVersion":1,"preExecution":{"dockerCommandGuarded":true,"dockerEnvironmentVariablesUnset":true,"dockerServiceInactive":true,"dockerSocketUnitInactive":true,"dockerdProcessNameAbsent":true,"defaultSocketPathsAbsent":true},"postExecution":{"dockerCommandGuarded":true,"dockerEnvironmentVariablesUnset":true,"dockerServiceInactive":true,"dockerSocketUnitInactive":true,"dockerdProcessNameAbsent":true,"defaultSocketPathsAbsent":true}}' \
    >"${receipt_stage}/docker-absence.json"

  bounded_file "${receipt_stage}/installer.sh" "$MAX_INSTALLER_BYTES"
  for receipt_path in \
    "${receipt_stage}/invocation.json" \
    "${receipt_stage}/candidate-source.json" \
    "${receipt_stage}/installed-source.json" \
    "${receipt_stage}/architecture.json" \
    "${receipt_stage}/docker-absence.json"; do
    bounded_file "$receipt_path" "$MAX_JSON_BYTES"
  done
  chmod 600 "${receipt_stage}"/*
  mv -T -- "$receipt_stage" "$artifact_dir" \
    || fail "Could not publish the qualification receipts to ${artifact_dir}."
  receipt_stage=""

  printf 'Native runtime installer qualification receipts: %s\n' "$artifact_dir"
}

if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  run_native_runtime_installer_qualification "$@"
fi
