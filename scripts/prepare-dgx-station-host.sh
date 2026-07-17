#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -Eeuo pipefail
umask 077

readonly SCRIPT_VERSION="2026-07-16.5"
readonly REBOOT_REQUIRED_EXIT=10
readonly MIN_FREE_KIB=$((20 * 1024 * 1024))
# The qualified generic image currently ships this OEM telemetry bootcmd. Its
# exception disappears automatically when the file changes or the bootcmd
# failure is fixed; update the pin only with a newly audited image.
readonly FACTORY_CLOUD_INIT_TELEMETRY="/etc/cloud/telemetry-bootcmd-event.py"
readonly FACTORY_CLOUD_INIT_RESULT="/run/cloud-init/result.json"
readonly FACTORY_CLOUD_INIT_TELEMETRY_SHA256="09a526c73fcbbe238db56f0ba4ce90a5a0634bab14b5122b016089d581f07275"

readonly CUDA_KEYRING_URL="https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/sbsa/cuda-keyring_1.1-1_all.deb"
readonly CUDA_KEYRING_SHA256="6ea7d2737648936820e85677177957a0f6521b840d98eb0bbae0a4f003fa7249"
readonly CUDA_KEYRING_PACKAGE_VERSION="1.1-1"
readonly CUDA_KEY_FINGERPRINT="EB693B3035CD5710E231E123A4B469963BF863CC" # gitleaks:allow -- public NVIDIA signing-key fingerprint
readonly DOCKER_KEY_URL="https://download.docker.com/linux/ubuntu/gpg"
readonly DOCKER_KEY_SHA256="1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570" # gitleaks:allow -- public Docker GPG-key integrity pin
readonly DOCKER_KEY_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

readonly DRIVER_VERSION="610.43.02"
readonly DOCKER_VERSION="29.6.1"
readonly TOOLKIT_VERSION="1.19.1"
readonly FACTORY_DKMS_VERSION="3.0.11-1ubuntu13"
readonly TARGET_DKMS_VERSION="1:3.4.0-1ubuntu1"
# Keep this as a plain Ubuntu image: NVIDIA Container Toolkit injects the host
# driver utility when CDI or --gpus is requested. This intentionally exercises
# the documented runtime contract instead of relying on a CUDA image payload:
# https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/sample-workload.html
readonly ACCEPTANCE_IMAGE="docker.io/library/ubuntu@sha256:7f622ca8766bccb22f04242ecb6f19f770b2f08827dc4b8c707de5e78a6da7ab"
readonly STATE_DIR="${HOME}/.local/state/station-bootstrap"
readonly INSTALL_BOOT_MARKER="${STATE_DIR}/install-boot-id"

readonly -a PACKAGE_SPECS=(
  "dkms=${TARGET_DKMS_VERSION}"
  "nvidia-driver-pinning-610=610-2ubuntu1"
  "nvidia-driver-open=610.43.02-1ubuntu1"
  "containerd.io=2.2.6-1~ubuntu.24.04~noble"
  "docker-buildx-plugin=0.35.0-1~ubuntu.24.04~noble"
  "docker-ce=5:29.6.1-1~ubuntu.24.04~noble"
  "docker-ce-cli=5:29.6.1-1~ubuntu.24.04~noble"
  "libnvidia-container-tools=1.19.1-1"
  "libnvidia-container1=1.19.1-1"
  "nvidia-container-toolkit=1.19.1-1"
  "nvidia-container-toolkit-base=1.19.1-1"
)

MODE=""
LOG_FILE=""
DOCKER_GROUP_ADDED=0
CDI_LIFECYCLE_READY=0
NETWORK_VALIDATED=0

info() {
  printf '[station-prepare] %s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

warn() {
  printf '[station-prepare] %s WARNING: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

fatal() {
  printf '[station-prepare] %s ERROR: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
  exit 1
}

on_error() {
  local rc=$?
  local line=${1:-unknown}
  printf '[station-prepare] %s ERROR: command failed at line %s (exit %s)\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$line" "$rc" >&2
  exit "$rc"
}

usage() {
  cat <<'EOF'
Usage: prepare-dgx-station-host.sh --check|--apply|--verify

  --check   Read-only eligibility and current-state report.
  --apply   Install exact prerequisites or finish post-reboot runtime setup.
  --verify  Read-only host verification plus ephemeral GPU container tests.

Exit 10 from --apply means an operator-controlled reboot is required. After
the reboot, run --apply once more, followed by --verify.
EOF
}

is_valid_mode() {
  case "${1:-}" in
    --check | --apply | --verify) return 0 ;;
    *) return 1 ;;
  esac
}

is_station_product() {
  local product=${1:-}
  [[ "$product" == *"Station"* && "$product" == *"GB300"* ]]
}

is_preparation_critical_unit() {
  case "${1:-}" in
    containerd.service | docker.service | nvidia-cdi-refresh.service | nvidia-persistenced.service)
      return 0
      ;;
    *) return 1 ;;
  esac
}

is_driver_transitional_unit() {
  [[ "${1:-}" == "nvidia-persistenced.service" ]]
}

root_owned_file_is_not_writable_by_group_or_other() {
  local metadata kind uid gid mode
  metadata="$(stat -Lc '%F|%u|%g|%a' "$1" 2>/dev/null)" || return 1
  IFS='|' read -r kind uid gid mode <<<"$metadata"
  [[ "$kind" == "regular file" && "$uid" == "0" && "$gid" == "0" && "$mode" =~ ^[0-7]{3,4}$ ]] \
    || return 1
  (((8#$mode & 0022) == 0))
}

cloud_init_failure_is_qualified() {
  local actual_sha
  ((NETWORK_VALIDATED == 1)) || return 1
  root_owned_file_is_not_writable_by_group_or_other "$FACTORY_CLOUD_INIT_TELEMETRY" \
    || return 1
  root_owned_file_is_not_writable_by_group_or_other "$FACTORY_CLOUD_INIT_RESULT" || return 1
  actual_sha="$(sha256sum "$FACTORY_CLOUD_INIT_TELEMETRY" 2>/dev/null | awk '{print $1}')"
  [[ "$actual_sha" == "$FACTORY_CLOUD_INIT_TELEMETRY_SHA256" ]] || return 1
  grep -Fq "\"('bootcmd', ProcessExecutionError(" "$FACTORY_CLOUD_INIT_RESULT"
}

network_wait_failure_is_qualified() {
  ((NETWORK_VALIDATED == 1)) \
    && systemctl is-active --quiet NetworkManager.service \
    && systemctl is-active --quiet network-online.target
}

fwupd_refresh_failure_is_qualified() {
  local state
  ((NETWORK_VALIDATED == 1)) || return 1
  state="$(systemctl is-enabled fwupd.service 2>/dev/null)" || true
  [[ "$state" == "masked" ]]
}

sssd_socket_failure_is_qualified() {
  [[ ! -e /etc/sssd/sssd.conf && ! -L /etc/sssd/sssd.conf ]]
}

is_qualified_factory_failed_unit() {
  case "${1:-}" in
    cloud-init.service) cloud_init_failure_is_qualified ;;
    NetworkManager-wait-online.service | systemd-networkd-wait-online.service)
      network_wait_failure_is_qualified
      ;;
    fwupd-refresh.service) fwupd_refresh_failure_is_qualified ;;
    sssd-autofs.socket | sssd-nss.socket | sssd-pam.socket | sssd-pam-priv.socket)
      sssd_socket_failure_is_qualified
      ;;
    *) return 1 ;;
  esac
}

package_name() {
  printf '%s\n' "${1%%=*}"
}

package_expected_version() {
  printf '%s\n' "${1#*=}"
}

acquire_sudo() {
  if sudo -n true >/dev/null 2>&1; then
    info "sudo=noninteractive"
    return
  fi

  info "sudo=interactive_authentication_required"
  sudo -v
}

installed_version() {
  dpkg-query -W -f='${Version}' "$1" 2>/dev/null || true
}

package_is_exact() {
  local spec=$1
  local name expected actual
  name="$(package_name "$spec")"
  expected="$(package_expected_version "$spec")"
  actual="$(installed_version "$name")"
  [[ "$actual" == "$expected" ]]
}

package_state() {
  local spec=$1
  local name expected actual
  name="$(package_name "$spec")"
  expected="$(package_expected_version "$spec")"
  actual="$(installed_version "$name")"
  if [[ -z "$actual" ]]; then
    printf 'missing\n'
  elif [[ "$actual" == "$expected" ]]; then
    printf 'exact\n'
  elif [[ "$name" == "dkms" && "$actual" == "$FACTORY_DKMS_VERSION" && "$expected" == "$TARGET_DKMS_VERSION" ]]; then
    printf 'approved-transition\n'
  else
    printf 'mismatch\n'
  fi
}

assert_no_package_mismatches() {
  local spec state name expected actual mismatch=0
  for spec in "${PACKAGE_SPECS[@]}"; do
    state="$(package_state "$spec")"
    if [[ "$state" == "approved-transition" ]]; then
      name="$(package_name "$spec")"
      expected="$(package_expected_version "$spec")"
      actual="$(installed_version "$name")"
      info "package=${name} status=approved_transition actual=${actual} expected=${expected}"
      continue
    fi
    [[ "$state" == "mismatch" ]] || continue
    name="$(package_name "$spec")"
    expected="$(package_expected_version "$spec")"
    actual="$(installed_version "$name")"
    warn "package=${name} status=mismatch actual=${actual} expected=${expected}"
    mismatch=1
  done
  ((mismatch == 0)) || fatal "Existing Station prerequisite versions differ from the validated pins or approved factory transition; refusing to change them automatically"
}

all_packages_exact() {
  local spec
  for spec in "${PACKAGE_SPECS[@]}"; do
    package_is_exact "$spec" || return 1
  done
  return 0
}

setup_log() {
  local log_dir="${HOME}/station-bootstrap-logs"
  mkdir -p "$log_dir"
  chmod 0700 "$log_dir"
  LOG_FILE="${log_dir}/station-prepare-${MODE#--}-$(date -u '+%Y%m%dT%H%M%SZ').log"
  exec > >(tee -a "$LOG_FILE") 2>&1
  info "version=${SCRIPT_VERSION} mode=${MODE} log=${LOG_FILE}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fatal "Required command is missing: $1"
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

check_platform() {
  local arch product
  arch="$(uname -m)"
  [[ "$arch" == "aarch64" || "$arch" == "arm64" ]] || fatal "Expected ARM64, found ${arch}"

  [[ -r /etc/os-release ]] || fatal "/etc/os-release is unavailable"
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] \
    || fatal "Expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}"
  [[ ! -e /etc/dgx-release && ! -L /etc/dgx-release ]] \
    || fatal "DGX OS/BaseOS is outside this recipe's validated boundary; use the generic Ubuntu 24.04 ARM64 image"

  product="$(</sys/class/dmi/id/product_name)"
  is_station_product "$product" || fatal "Expected DGX Station GB300 DMI, found ${product}"
  info "platform=${product} os=${PRETTY_NAME} arch=${arch} kernel=$(uname -r)"
}

check_secure_boot() {
  local state
  require_command mokutil
  state="$(mokutil --sb-state 2>&1)" || fatal "Unable to query Secure Boot state"
  [[ "$state" == *"disabled"* ]] || fatal "Secure Boot must be disabled for the pinned open-driver flow: ${state}"
  info "secure_boot=disabled"
}

check_kernel_headers() {
  [[ -e "/lib/modules/$(uname -r)/build" ]] \
    || fatal "Kernel headers are missing for $(uname -r); install the matching Ubuntu headers first"
  info "kernel_headers=present"
}

check_capacity() {
  local available
  available="$(df -Pk / | awk 'NR == 2 {print $4}')"
  [[ "$available" =~ ^[0-9]+$ ]] || fatal "Could not determine free root filesystem capacity"
  ((available >= MIN_FREE_KIB)) || fatal "At least 20 GiB free is required; found $((available / 1024 / 1024)) GiB"
  info "root_free_gib=$((available / 1024 / 1024))"
}

check_network() {
  local host
  for host in developer.download.nvidia.com download.docker.com registry-1.docker.io; do
    getent ahosts "$host" >/dev/null 2>&1 || fatal "DNS resolution failed for ${host}"
  done
  NETWORK_VALIDATED=1
  info "network=required_vendor_hosts_resolve"
}

check_package_managers_idle() {
  local active
  active="$(ps -eo pid=,comm= | awk '$2 ~ /^(apt|apt-get|dpkg|unattended-upgrade)$/ {print}')"
  [[ -z "$active" ]] || fatal "A package-manager process is active: ${active}"
  info "package_manager=idle"
}

check_failed_units() {
  local unit failed_output blocking=0
  local -a units=()
  failed_output="$(systemctl --failed --no-legend --plain 2>/dev/null)" \
    || fatal "Unable to inspect failed system services"
  while IFS= read -r unit; do
    [[ -n "$unit" ]] && units+=("$unit")
  done < <(awk 'NF {print $1}' <<<"$failed_output")
  if ((${#units[@]} == 0)); then
    info "failed_units=none"
    return 0
  fi
  for unit in "${units[@]}"; do
    if is_driver_transitional_unit "$unit" && all_packages_exact && ! driver_loaded_exact; then
      warn "driver unit failure allowed only until post-reboot verification: ${unit}"
    elif is_preparation_critical_unit "$unit"; then
      warn "failed preparation-critical unit: ${unit}"
      blocking=1
    elif is_qualified_factory_failed_unit "$unit"; then
      warn "condition-qualified generic-image failed unit: ${unit}"
    else
      warn "unqualified failed unit: ${unit}"
      blocking=1
    fi
  done
  ((blocking == 0)) || fatal "Unqualified failed system units block Station preparation"
}

check_no_workloads() {
  local processes matches listeners containers=""
  processes="$(ps -eo pid=,ppid=,comm=,args=)"
  matches="$(awk -v self="$$" -v parent="$PPID" '
    {
      pid=$1
      ppid=$2
      comm=tolower($3)
      $1=$2=$3=""
      args=tolower($0)
      if (pid == self || pid == parent) next
      if (comm ~ /^(vllm|nemoclaw|openshell)$/ ||
          args ~ /(^|[[:space:]\/])(vllm|nemoclaw|openshell)([[:space:]:]|\.js([[:space:]]|$)|$)/) print
    }
  ' <<<"$processes")"
  [[ -z "$matches" ]] || fatal "Agent or inference workload is active: ${matches}"

  listeners="$(ss -H -ltn 2>/dev/null | awk '$4 ~ /:8000$/ {print}')"
  [[ -z "$listeners" ]] || fatal "Port 8000 is already listening: ${listeners}"

  if command -v docker >/dev/null 2>&1; then
    if containers="$(docker ps -aq 2>/dev/null)"; then
      :
    elif [[ "$MODE" == "--apply" ]] && containers="$(sudo -n docker ps -aq 2>/dev/null)"; then
      info "docker_access=sudo_until_group_membership_is_active"
    elif systemctl is-active --quiet docker.service; then
      fatal "Docker is active but inaccessible to this login; start a new login session with docker-group membership"
    else
      fatal "Docker is installed but inactive, so existing container state cannot be verified safely; start Docker and rerun preparation"
    fi
  fi
  [[ -z "$containers" ]] || fatal "Existing Docker containers block host preparation: ${containers}"
  info "workloads=none port_8000=free"
}

driver_loaded_exact() {
  local loaded
  command -v nvidia-smi >/dev/null 2>&1 || return 1
  loaded="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n1 | tr -d '[:space:]')"
  [[ "$loaded" == "$DRIVER_VERSION" ]]
}

assert_station_state_dir_safe() {
  local path mode
  for path in "${HOME}/.local" "${HOME}/.local/state" "$STATE_DIR"; do
    [[ ! -L "$path" ]] || fatal "Refusing symbolic link in Station bootstrap state path: ${path}"
    [[ ! -e "$path" || -d "$path" ]] || fatal "Station bootstrap state path is not a directory: ${path}"
    if [[ -e "$path" ]]; then
      [[ -O "$path" ]] || fatal "Station bootstrap state path is not owned by the current user: ${path}"
      mode="$(file_mode "$path")"
      (((8#$mode & 0022) == 0)) || fatal "Station bootstrap state path is group- or other-writable: ${path}"
    fi
  done
}

assert_install_boot_marker_safe() {
  local mode
  [[ ! -L "$INSTALL_BOOT_MARKER" ]] || fatal "Refusing symbolic link for Station bootstrap boot marker: ${INSTALL_BOOT_MARKER}"
  [[ ! -e "$INSTALL_BOOT_MARKER" || -f "$INSTALL_BOOT_MARKER" ]] \
    || fatal "Station bootstrap boot marker is not a regular file: ${INSTALL_BOOT_MARKER}"
  if [[ -e "$INSTALL_BOOT_MARKER" ]]; then
    [[ -O "$INSTALL_BOOT_MARKER" ]] || fatal "Station bootstrap boot marker is not owned by the current user"
    mode="$(file_mode "$INSTALL_BOOT_MARKER")"
    [[ "$mode" == "600" ]] || fatal "Station bootstrap boot marker must have mode 0600"
  fi
}

write_install_boot_marker() {
  local temp_file
  assert_station_state_dir_safe
  mkdir -p "$STATE_DIR"
  assert_station_state_dir_safe
  chmod 0700 "$STATE_DIR"
  assert_install_boot_marker_safe
  temp_file="$(mktemp "${INSTALL_BOOT_MARKER}.tmp.XXXXXX")"
  chmod 0600 "$temp_file"
  tr -d '[:space:]' </proc/sys/kernel/random/boot_id >"$temp_file"
  printf '\n' >>"$temp_file"
  mv -f "$temp_file" "$INSTALL_BOOT_MARKER"
  assert_install_boot_marker_safe
}

install_boot_marker_matches_current_boot() {
  local installed_boot current_boot
  assert_station_state_dir_safe
  [[ -e "$INSTALL_BOOT_MARKER" || -L "$INSTALL_BOOT_MARKER" ]] || return 1
  assert_install_boot_marker_safe
  installed_boot="$(tr -d '[:space:]' <"$INSTALL_BOOT_MARKER")"
  current_boot="$(tr -d '[:space:]' </proc/sys/kernel/random/boot_id)"
  [[ "$installed_boot" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || fatal "Station bootstrap boot marker is invalid"
  [[ "$installed_boot" == "$current_boot" ]]
}

print_package_status() {
  local spec name expected actual
  for spec in "${PACKAGE_SPECS[@]}"; do
    name="$(package_name "$spec")"
    expected="$(package_expected_version "$spec")"
    actual="$(installed_version "$name")"
    if [[ "$actual" == "$expected" ]]; then
      info "package=${name} status=exact version=${actual}"
    elif [[ -z "$actual" ]]; then
      info "package=${name} status=missing expected=${expected}"
    elif [[ "$name" == "dkms" && "$actual" == "$FACTORY_DKMS_VERSION" ]]; then
      info "package=${name} status=approved_transition actual=${actual} expected=${expected}"
    else
      warn "package=${name} status=mismatch actual=${actual} expected=${expected}"
    fi
  done
}

common_preflight() {
  require_command awk
  require_command df
  require_command dpkg-query
  require_command getent
  require_command grep
  require_command ps
  require_command sha256sum
  require_command ss
  require_command stat
  require_command systemctl
  check_platform
  check_secure_boot
  check_kernel_headers
  check_capacity
  check_network
  check_package_managers_idle
  check_failed_units
  check_no_workloads
}

verify_file_sha256() {
  local path=$1 expected=$2 actual
  actual="$(sha256sum "$path" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || fatal "SHA-256 mismatch for ${path}: ${actual}"
}

verify_key_fingerprint() {
  local path=$1 expected=$2
  gpg --batch --show-keys --with-colons "$path" 2>/dev/null \
    | awk -F: '$1 == "fpr" {print $10}' \
    | grep -Fxq "$expected" || fatal "Expected signing-key fingerprint ${expected} was not found in ${path}"
}

root_directory_is_safe() {
  local path=$1 metadata uid gid mode
  sudo test ! -L "$path" || return 1
  sudo test -d "$path" || return 1
  metadata="$(sudo stat -c '%u %g %a' -- "$path")" || return 1
  read -r uid gid mode <<<"$metadata"
  [[ "$uid" == "0" && "$gid" == "0" && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#$mode & 0022) == 0))
}

assert_root_directory_safe() {
  local path=$1 label=$2
  root_directory_is_safe "$path" \
    || fatal "${label} must be a root-owned directory that is not group- or other-writable: ${path}"
}

ensure_root_directory_safe() {
  local path=$1 parent=$2 mode=$3 label=$4
  assert_root_directory_safe "$parent" "${label} parent"
  sudo test ! -L "$path" || fatal "${label} must not be a symbolic link: ${path}"
  if ! sudo test -e "$path"; then
    sudo install -d -o root -g root -m "$mode" "$path"
  fi
  assert_root_directory_safe "$path" "$label"
}

root_regular_file_is_safe() {
  local path=$1 expected_mode=${2:-} metadata uid gid mode
  sudo test ! -L "$path" || return 1
  sudo test -f "$path" || return 1
  metadata="$(sudo stat -c '%u %g %a' -- "$path")" || return 1
  read -r uid gid mode <<<"$metadata"
  [[ "$uid" == "0" && "$gid" == "0" && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#$mode & 0022) == 0)) || return 1
  [[ -z "$expected_mode" || "$mode" == "${expected_mode#0}" ]]
}

assert_root_regular_file_safe() {
  local path=$1 expected_mode=$2 label=$3
  if [[ -n "$expected_mode" ]]; then
    root_regular_file_is_safe "$path" "$expected_mode" \
      || fatal "${label} must be a root-owned regular file with mode ${expected_mode}: ${path}"
  else
    root_regular_file_is_safe "$path" "" \
      || fatal "${label} must be a root-owned regular file that is not group- or other-writable: ${path}"
  fi
}

ensure_cuda_keyring() {
  local cuda_deb=$1 actual verification
  assert_root_directory_safe /usr/share/keyrings "CUDA repository keyring directory"
  actual="$(installed_version cuda-keyring)"
  if [[ -z "$actual" ]]; then
    curl --fail --silent --show-error --location "$CUDA_KEYRING_URL" --output "$cuda_deb"
    verify_file_sha256 "$cuda_deb" "$CUDA_KEYRING_SHA256"
    sudo dpkg -i "$cuda_deb"
    package_is_exact "cuda-keyring=${CUDA_KEYRING_PACKAGE_VERSION}" \
      || fatal "Installed cuda-keyring does not match ${CUDA_KEYRING_PACKAGE_VERSION}"
  elif [[ "$actual" == "$CUDA_KEYRING_PACKAGE_VERSION" ]]; then
    verification="$(dpkg -V cuda-keyring 2>&1)" \
      || fatal "Unable to verify the installed cuda-keyring package"
    [[ -z "$verification" ]] || fatal "Installed cuda-keyring files differ from the package manifest: ${verification}"
    info "cuda_keyring=exact version=${actual}"
  else
    fatal "Existing cuda-keyring version ${actual} differs from validated pin ${CUDA_KEYRING_PACKAGE_VERSION}; refusing to upgrade or downgrade it automatically"
  fi

  assert_root_regular_file_safe /usr/share/keyrings/cuda-archive-keyring.gpg 0644 "CUDA repository keyring"
  verify_key_fingerprint /usr/share/keyrings/cuda-archive-keyring.gpg "$CUDA_KEY_FINGERPRINT"
}

install_exact_file_or_reuse() {
  local source=$1 target=$2 mode=$3 label=$4 parent
  parent="$(dirname "$target")"
  assert_root_directory_safe "$parent" "${label} directory"
  sudo test ! -L "$target" || fatal "${label} must not be a symbolic link: ${target}"
  if sudo test -e "$target"; then
    assert_root_regular_file_safe "$target" "$mode" "$label"
    sudo cmp -s "$source" "$target" \
      || fatal "Existing ${label} differs from the validated content; refusing to overwrite ${target}"
    info "${label}=exact path=${target}"
    return 0
  fi
  sudo install -o root -g root -m "$mode" "$source" "$target"
  assert_root_regular_file_safe "$target" "$mode" "$label"
  info "${label}=installed path=${target}"
}

configure_repositories() {
  local tmp cuda_deb docker_asc docker_gpg docker_list
  tmp="$(mktemp -d)"
  cuda_deb="${tmp}/cuda-keyring.deb"
  docker_asc="${tmp}/docker.asc"
  docker_gpg="${tmp}/docker.gpg"
  docker_list="${tmp}/docker.list"

  info "Downloading and verifying official repository keys"
  ensure_cuda_keyring "$cuda_deb"

  curl --fail --silent --show-error --location "$DOCKER_KEY_URL" --output "$docker_asc"
  verify_file_sha256 "$docker_asc" "$DOCKER_KEY_SHA256"
  verify_key_fingerprint "$docker_asc" "$DOCKER_KEY_FINGERPRINT"
  gpg --batch --yes --dearmor --output "$docker_gpg" "$docker_asc"
  ensure_root_directory_safe /etc/apt/keyrings /etc/apt 0755 "Docker repository key directory"
  assert_root_directory_safe /etc/apt/sources.list.d "Docker repository source directory"
  install_exact_file_or_reuse "$docker_gpg" /etc/apt/keyrings/docker.gpg 0644 docker_repository_key
  printf '%s\n' \
    'deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable' \
    >"$docker_list"
  install_exact_file_or_reuse "$docker_list" /etc/apt/sources.list.d/docker.list 0644 docker_repository_source

  rm -rf "$tmp"
  info "repository_keys=verified"
}

validate_package_availability() {
  local spec
  for spec in "${PACKAGE_SPECS[@]}"; do
    apt-cache show "$spec" >/dev/null 2>&1 || fatal "Exact package version is unavailable: ${spec}"
  done
  info "exact_package_versions=available"
}

simulate_install() {
  local simulation
  simulation="$(apt-get -s install --no-install-recommends "${PACKAGE_SPECS[@]}")" \
    || fatal "APT simulation failed"
  printf '%s\n' "$simulation"
  if grep -Eq '^(Remv |Purg )' <<<"$simulation"; then
    fatal "APT simulation proposed a package removal"
  fi
  info "apt_simulation=no_removals"
}

install_packages() {
  configure_repositories
  info "Refreshing package metadata"
  sudo apt-get update
  validate_package_availability
  simulate_install
  check_no_workloads
  info "Installing pinned Station prerequisites"
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    "${PACKAGE_SPECS[@]}"

  local spec
  for spec in "${PACKAGE_SPECS[@]}"; do
    package_is_exact "$spec" || fatal "Installed package does not match ${spec}"
  done
  info "pinned_packages=installed"
}

ensure_docker_group() {
  local user_name=${SUDO_USER:-$USER}
  getent group docker >/dev/null 2>&1 || fatal "Docker group is missing after package installation"
  if ! id -nG "$user_name" | tr ' ' '\n' | grep -Fxq docker; then
    sudo usermod -aG docker "$user_name"
    DOCKER_GROUP_ADDED=1
    info "docker_group=added user=${user_name}; a new login is required"
  else
    info "docker_group=present user=${user_name}"
  fi
}

ensure_cdi_refresh_lifecycle() {
  ((CDI_LIFECYCLE_READY == 0)) || return 0
  check_no_workloads
  sudo systemctl enable nvidia-cdi-refresh.path nvidia-cdi-refresh.service \
    || fatal "Could not enable the packaged NVIDIA CDI refresh lifecycle"
  sudo systemctl start nvidia-cdi-refresh.path \
    || fatal "Could not activate the packaged NVIDIA CDI refresh path"
  CDI_LIFECYCLE_READY=1
  info "cdi_refresh_lifecycle=enabled"
}

verify_cdi_refresh_lifecycle() {
  systemctl is-enabled --quiet nvidia-cdi-refresh.path \
    || fatal "nvidia-cdi-refresh.path is not enabled"
  systemctl is-enabled --quiet nvidia-cdi-refresh.service \
    || fatal "nvidia-cdi-refresh.service is not enabled"
  systemctl is-active --quiet nvidia-cdi-refresh.path \
    || fatal "nvidia-cdi-refresh.path is not active"
  info "cdi_refresh_lifecycle=verified"
}

refresh_cdi() {
  check_no_workloads
  ensure_cdi_refresh_lifecycle
  if ! sudo systemctl restart nvidia-cdi-refresh.service; then
    warn "Packaged CDI refresh failed; collecting diagnostics"
    sudo systemctl status nvidia-cdi-refresh.service --no-pager || true
    sudo journalctl -u nvidia-cdi-refresh.service --no-pager -n 50 || true
    fatal "Packaged CDI refresh failed; repair nvidia-cdi-refresh.service before rerunning preparation"
  fi
  if ! nvidia-ctk cdi list | grep -Fxq 'nvidia.com/gpu=all'; then
    warn "Packaged CDI refresh completed without advertising nvidia.com/gpu=all"
    sudo systemctl status nvidia-cdi-refresh.service --no-pager || true
    sudo journalctl -u nvidia-cdi-refresh.service --no-pager -n 50 || true
    fatal "Packaged CDI refresh did not advertise nvidia.com/gpu=all; direct CDI generation is not permitted"
  fi
  info "cdi=nvidia.com/gpu=all source=packaged_refresh_service"
}

ensure_acceptance_image() {
  if ! sudo docker image inspect "$ACCEPTANCE_IMAGE" >/dev/null 2>&1; then
    info "Pulling digest-pinned ARM64 acceptance image"
    sudo docker pull --platform linux/arm64 "$ACCEPTANCE_IMAGE"
  fi
}

run_cdi_test_sudo() {
  sudo docker run --rm --device nvidia.com/gpu=all "$ACCEPTANCE_IMAGE" nvidia-smi
}

run_gpus_test_sudo() {
  sudo docker run --rm --gpus all "$ACCEPTANCE_IMAGE" nvidia-smi
}

docker_has_nvidia_runtime_sudo() {
  local runtimes
  runtimes="$(
    sudo docker info --format '{{range $name, $_ := .Runtimes}}{{println $name}}{{end}}'
  )" || fatal "Could not inspect Docker runtimes after the --gpus all probe failed"
  grep -Fxq 'nvidia' <<<"$runtimes"
}

ensure_cdi_runtime() {
  ensure_cdi_refresh_lifecycle
  if run_cdi_test_sudo; then
    info "cdi_contract=pass_without_configuration_change"
    return 0
  fi

  warn "CDI GPU launch failed; refreshing the NVIDIA CDI device spec"
  refresh_cdi
  run_cdi_test_sudo || fatal "CDI Docker GPU test failed after CDI refresh"
  info "cdi_contract=pass_after_refresh"
}

configure_docker_runtime_if_needed() {
  local backup_dir previous_daemon=0
  if run_gpus_test_sudo; then
    info "docker_gpus_contract=pass_without_configuration_change"
    return 0
  fi

  if docker_has_nvidia_runtime_sudo; then
    fatal "Docker --gpus all failed even though the NVIDIA runtime is registered; daemon configuration was left unchanged. Inspect the failed container launch and rerun preparation."
  fi

  # Persistent registration is the supported repair only for the diagnosed
  # missing-runtime state. It remains required until this acceptance probe
  # succeeds through a replacement Docker/NVIDIA runtime integration.
  warn "Docker --gpus all failed and Docker reports no NVIDIA runtime; applying the reviewed NVIDIA runtime registration"
  check_no_workloads
  ensure_root_directory_safe /etc/docker /etc 0755 "Docker configuration directory"
  ensure_root_directory_safe /var/backups/station-bootstrap /var/backups 0700 "Station bootstrap backup directory"
  backup_dir="$(sudo mktemp -d /var/backups/station-bootstrap/docker-runtime.XXXXXXXXXX)" \
    || fatal "Could not create a unique Docker runtime backup directory"
  assert_root_directory_safe "$backup_dir" "Docker runtime backup directory"
  if sudo test -e /etc/docker/daemon.json || sudo test -L /etc/docker/daemon.json; then
    assert_root_regular_file_safe /etc/docker/daemon.json "" "Docker daemon configuration"
    sudo cp --archive --no-dereference -- /etc/docker/daemon.json "${backup_dir}/daemon.json"
    assert_root_regular_file_safe "${backup_dir}/daemon.json" "" "Docker daemon configuration backup"
    previous_daemon=1
  else
    sudo touch "${backup_dir}/daemon.json.absent"
    sudo chmod 0600 "${backup_dir}/daemon.json.absent"
  fi
  check_no_workloads
  if ! sudo nvidia-ctk runtime configure --runtime=docker; then
    fail_after_docker_runtime_rollback "$backup_dir" "$previous_daemon" "NVIDIA runtime registration failed"
  fi
  if ! root_regular_file_is_safe /etc/docker/daemon.json ""; then
    fail_after_docker_runtime_rollback "$backup_dir" "$previous_daemon" "NVIDIA runtime registration produced an unsafe Docker daemon configuration"
  fi
  if ! (check_no_workloads); then
    fail_after_docker_runtime_rollback "$backup_dir" "$previous_daemon" "A workload appeared before Docker restart" 0
  fi
  if ! sudo systemctl restart docker.service; then
    fail_after_docker_runtime_rollback "$backup_dir" "$previous_daemon" "Docker restart failed after NVIDIA runtime registration"
  fi
  if ! run_gpus_test_sudo; then
    fail_after_docker_runtime_rollback "$backup_dir" "$previous_daemon" "Docker --gpus all still fails after NVIDIA runtime registration"
  fi
  if ! run_cdi_test_sudo; then
    fail_after_docker_runtime_rollback "$backup_dir" "$previous_daemon" "CDI launch regressed after NVIDIA runtime registration"
  fi
  info "docker_gpus_contract=pass backup=${backup_dir}"
}

rollback_docker_runtime_config() {
  local backup_dir=$1 previous_daemon=$2 restart_after_restore=${3:-1}
  warn "Restoring the Docker daemon configuration from ${backup_dir}"
  if [[ "$previous_daemon" == "1" ]]; then
    root_regular_file_is_safe "${backup_dir}/daemon.json" "" || return 1
    sudo rm -f -- /etc/docker/daemon.json || return 1
    sudo cp --archive --no-dereference -- "${backup_dir}/daemon.json" /etc/docker/daemon.json || return 1
    root_regular_file_is_safe /etc/docker/daemon.json "" || return 1
  else
    sudo rm -f -- /etc/docker/daemon.json || return 1
  fi
  if [[ "$restart_after_restore" == "1" ]]; then
    sudo systemctl restart docker.service
  fi
}

fail_after_docker_runtime_rollback() {
  local backup_dir=$1 previous_daemon=$2 reason=$3 restart_after_restore=${4:-1}
  if rollback_docker_runtime_config "$backup_dir" "$previous_daemon" "$restart_after_restore"; then
    fatal "${reason}; the prior Docker daemon configuration was restored"
  fi
  fatal "${reason}; automatic Docker daemon rollback failed, restore from ${backup_dir} before retrying"
}

finish_runtime() {
  check_no_workloads
  sudo systemctl enable --now containerd.service docker.service
  ensure_docker_group
  ensure_acceptance_image
  ensure_cdi_runtime
  configure_docker_runtime_if_needed
  [[ -z "$(sudo docker ps -aq)" ]] || fatal "Acceptance tests left a Docker container behind"
  info "runtime_setup=complete"
}

verify_apply_state() {
  local spec
  for spec in "${PACKAGE_SPECS[@]}"; do
    package_is_exact "$spec" || fatal "Package verification failed: ${spec}"
  done
  verify_gpu
  systemctl is-active --quiet nvidia-persistenced.service || fatal "nvidia-persistenced.service is not active"
  systemctl is-active --quiet containerd.service || fatal "containerd.service is not active"
  systemctl is-active --quiet docker.service || fatal "docker.service is not active"
  verify_cdi_refresh_lifecycle
  nvidia-ctk cdi list | grep -Fxq 'nvidia.com/gpu=all' || fatal "CDI verification failed"
  sudo docker image inspect "$ACCEPTANCE_IMAGE" >/dev/null 2>&1 || fatal "Digest-pinned acceptance image is missing"
  [[ -z "$(sudo docker ps -aq)" ]] || fatal "Verification found a leftover Docker container"
  info "STATION_HOST_READY"
}

verify_gpu() {
  local row name driver corrected uncorrected
  row="$(nvidia-smi \
    --query-gpu=name,driver_version,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total \
    --format=csv,noheader,nounits)" || fatal "nvidia-smi failed"
  IFS=',' read -r name driver corrected uncorrected <<<"$row"
  name="${name#"${name%%[![:space:]]*}"}"
  driver="${driver//[[:space:]]/}"
  corrected="${corrected//[[:space:]]/}"
  uncorrected="${uncorrected//[[:space:]]/}"
  [[ "$name" == *"GB300"* ]] || fatal "Expected NVIDIA GB300, found ${name}"
  [[ "$driver" == "$DRIVER_VERSION" ]] || fatal "Expected driver ${DRIVER_VERSION}, found ${driver}"
  [[ "$corrected" == "0" && "$uncorrected" == "0" ]] \
    || fatal "ECC must be 0/0, found corrected=${corrected} uncorrected=${uncorrected}"
  info "gpu=${name} driver=${driver} ecc_corrected=${corrected} ecc_uncorrected=${uncorrected}"
}

verify_host() {
  local spec user_name=${SUDO_USER:-$USER}
  for spec in "${PACKAGE_SPECS[@]}"; do
    package_is_exact "$spec" || fatal "Package verification failed: ${spec}"
  done
  verify_gpu
  systemctl is-active --quiet nvidia-persistenced.service || fatal "nvidia-persistenced.service is not active"
  systemctl is-active --quiet containerd.service || fatal "containerd.service is not active"
  systemctl is-active --quiet docker.service || fatal "docker.service is not active"
  verify_cdi_refresh_lifecycle
  id -nG "$user_name" | tr ' ' '\n' | grep -Fxq docker || fatal "${user_name} is not in the docker group"
  docker info >/dev/null 2>&1 || fatal "${user_name} cannot access Docker; start a new login session"
  nvidia-ctk cdi list | grep -Fxq 'nvidia.com/gpu=all' || fatal "CDI verification failed"
  docker image inspect "$ACCEPTANCE_IMAGE" >/dev/null 2>&1 || fatal "Digest-pinned acceptance image is missing; run --apply"
  docker run --rm --device nvidia.com/gpu=all "$ACCEPTANCE_IMAGE" nvidia-smi >/dev/null
  docker run --rm --gpus all "$ACCEPTANCE_IMAGE" nvidia-smi >/dev/null
  [[ -z "$(docker ps -aq)" ]] || fatal "Verification left a Docker container behind"
  info "docker=$(docker version --format '{{.Server.Version}}') expected_docker=${DOCKER_VERSION} toolkit=$(nvidia-ctk --version | head -n1) expected_toolkit=${TOOLKIT_VERSION}"
  info "STATION_HOST_READY"
}

run_check() {
  common_preflight
  print_package_status
  if all_packages_exact; then
    if install_boot_marker_matches_current_boot; then
      warn "Package installation completed in the current boot; reboot is required"
      info "CHECK_RESULT=REBOOT_REQUIRED"
    elif driver_loaded_exact; then
      info "CHECK_RESULT=PACKAGES_AND_DRIVER_PRESENT"
    else
      warn "Exact packages are installed but driver ${DRIVER_VERSION} is not loaded; reboot is required"
      info "CHECK_RESULT=REBOOT_REQUIRED"
    fi
  else
    info "CHECK_RESULT=READY_TO_APPLY"
  fi
}

run_apply() {
  require_command apt-cache
  require_command apt-get
  require_command cmp
  require_command curl
  require_command dpkg
  require_command gpg
  require_command grep
  require_command readlink
  require_command sha256sum
  require_command sudo
  acquire_sudo
  common_preflight

  if [[ -e /var/run/reboot-required ]]; then
    if all_packages_exact && ! driver_loaded_exact; then
      warn "A reboot is required before runtime setup can continue"
      exit "$REBOOT_REQUIRED_EXIT"
    fi
    fatal "An unrelated reboot is already pending"
  fi

  if ! all_packages_exact; then
    assert_no_package_mismatches
    install_packages
    ensure_docker_group
    check_no_workloads
    sudo systemctl enable containerd.service docker.service nvidia-cdi-refresh.path nvidia-cdi-refresh.service
    write_install_boot_marker
    info "APPLY_RESULT=REBOOT_REQUIRED"
    info "Run: sudo reboot"
    exit "$REBOOT_REQUIRED_EXIT"
  fi

  if install_boot_marker_matches_current_boot; then
    warn "Package installation completed in the current boot"
    info "APPLY_RESULT=REBOOT_REQUIRED"
    info "Run: sudo reboot"
    exit "$REBOOT_REQUIRED_EXIT"
  fi

  driver_loaded_exact || {
    warn "Pinned packages are installed but driver ${DRIVER_VERSION} is not loaded"
    info "APPLY_RESULT=REBOOT_REQUIRED"
    info "Run: sudo reboot"
    exit "$REBOOT_REQUIRED_EXIT"
  }

  finish_runtime
  verify_apply_state
  if ((DOCKER_GROUP_ADDED == 1)); then
    warn "Docker group membership was added and requires a new login before onboarding"
    info "APPLY_RESULT=REBOOT_REQUIRED"
    info "Run: sudo reboot"
    exit "$REBOOT_REQUIRED_EXIT"
  fi
  rm -f "$INSTALL_BOOT_MARKER"
  info "APPLY_RESULT=COMPLETE"
}

run_verify() {
  common_preflight
  require_command docker
  require_command nvidia-ctk
  require_command nvidia-smi
  all_packages_exact || fatal "Pinned prerequisite packages are incomplete; run --apply"
  driver_loaded_exact || fatal "Pinned driver is not loaded; reboot, then run --apply"
  verify_host
}

main() {
  if (($# != 1)) || ! is_valid_mode "${1:-}"; then
    usage >&2
    exit 2
  fi
  MODE=$1
  if [[ "$MODE" == "--apply" ]]; then
    setup_log
  else
    info "version=${SCRIPT_VERSION} mode=${MODE} log=disabled_read_only"
  fi
  trap 'on_error "$LINENO"' ERR
  case "$MODE" in
    --check) run_check ;;
    --apply) run_apply ;;
    --verify) run_verify ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
