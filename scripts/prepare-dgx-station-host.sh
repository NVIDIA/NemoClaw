#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -Eeuo pipefail
umask 077

readonly SCRIPT_VERSION="2026-07-18.1"
readonly REBOOT_REQUIRED_EXIT=10
readonly LOGIN_REQUIRED_EXIT=11
readonly MIN_FREE_KIB=$((20 * 1024 * 1024))
readonly GB300_PCI_VENDOR="0x10de"
readonly -a GB300_PCI_DEVICES=("0x31c2" "0x31c3")
readonly GB300_PCI_CLASS_PREFIX="0x03"
STATION_HOST_PROFILE="generic-ubuntu"
FORCE_STATION_INSTALL=0
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
readonly BASEOS_DRIVER_VERSION="595.58.03"
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
DOCKER_BASELINE_CAPTURED=0
DOCKER_CONTAINER_BASELINE=""
DOCKER_CONTAINER_BASELINE_TOTAL=0
DOCKER_QUERY_OUTPUT=""
DOCKER_QUERY_USES_SUDO=0

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

readonly -a BASEOS_PACKAGE_SPECS=(
  "dgx-release=7.5.0"
  "dgx-repo=25.10-2"
  "dgxstation-desktop=25.11-1"
  "dgxstation-grub=25.02-1"
  "dkms=3.2.2-1"
  "nvidia-driver-595-open=595.58.03-0ubuntu0.24.04.1"
  "containerd.io=2.2.1-1~ubuntu.24.04~noble"
  "docker-buildx-plugin=0.31.1-1~ubuntu.24.04~noble"
  "docker-ce=5:29.2.1-1~ubuntu.24.04~noble"
  "docker-ce-cli=5:29.2.1-1~ubuntu.24.04~noble"
  "libnvidia-container-tools=1.19.0-1"
  "libnvidia-container1=1.19.0-1"
  "nvidia-container-toolkit=1.19.0-1"
  "nvidia-container-toolkit-base=1.19.0-1"
  "cloud-init=25.3-0ubuntu1~24.04.1"
  "fluent-bit=4.2.1"
  "fwupd=1.9.33-0ubuntu1~24.04.1ubuntu1"
  "sssd-common=2.9.4-1.1ubuntu6.4"
)

readonly BASEOS_CLOUD_CFG_SHA256="038ba435093de59f4a21021caf6c921d63344e9aae3b88795ee5b2659f43f437"
readonly BASEOS_CLOUD_INIT_UNIT_SHA256="e13dd95a7bfac6407ea1ce45ed6683c0f4e84c791840d305c937d38ae77d9456"
readonly BASEOS_FLUENT_BIT_UNIT_SHA256="1854339f563e518894c156d081912595d2d6e175a1ed6692e74e88224b6bad5f"
readonly BASEOS_FLUENT_BIT_CFG_NORMALIZED_SHA256="ffec8b1bcc628877b9a230c6b26313b5ee6b25c20398580832133dbb15349551"
readonly BASEOS_FLUENT_BIT_PARSERS_SHA256="760e6a347874a6cbdc10c6cd21d82d1ee5388c8573ddfaab05ef37904749dbe1"
readonly BASEOS_FLUENT_BIT_PLUGINS_SHA256="9d5aad2c1be151b4d35de53a460f9783f98ac3cc815ebc638b0e8489f4ecd577"
readonly BASEOS_FWUPD_UNIT_SHA256="835e7c291761c247d3cd5c64652b768c6a7fdc7cc72fea1bf70fc92e4cb3cfd5"
readonly BASEOS_FWUPD_CFG_SHA256="a25bd457c86be85a286cd175d94e30fa152eb119c95b2a7db8a495886cdd7654"
readonly BASEOS_FWUPD_LVFS_TESTING_SHA256="f50a44def594f256a8192c1d048e08aa94f0287de804262f680b73fa62d97787"
readonly BASEOS_FWUPD_LVFS_SHA256="c4e62d855e41dbf777972b4249da5b2b968fc723e8c7d0d55f932ba47764e98c"
readonly BASEOS_FWUPD_VENDOR_SHA256="0f5a62990f2ddb1681349c01373b3208131e5254a0e734e6090c249c5af9a73f"
readonly BASEOS_SSSD_AUTOFS_UNIT_SHA256="d1be2c2c33e1591ac2fa0bf656bf8dc3d52083a7e9569902e777aea827baeb1f"
readonly BASEOS_SSSD_NSS_UNIT_SHA256="bd432f92436f5c1c142c5824fce66aded6b8be80db4fdfbbed60f222c3a97d9e"
readonly BASEOS_SSSD_PAM_UNIT_SHA256="6760940940471d5bb1b09652b1632db1251b90c3a028efcf11a1b731bb0ab43c"
readonly BASEOS_SSSD_PAM_PRIV_UNIT_SHA256="851fc28d7ab5ac38cd56fcad1f4125cfeb46e8ee62bbf6cbc6376c592faeb51a"

dgx_station_release_path() {
  printf '%s' /etc/dgx-release
}

station_os_release_path() {
  printf '%s' /etc/os-release
}

station_product_name_path() {
  printf '%s' /sys/class/dmi/id/product_name
}

station_pci_devices_path() {
  printf '%s' /sys/bus/pci/devices
}

reboot_required() {
  [[ -e /var/run/reboot-required ]]
}

dgx_station_release_file_is_safe() {
  local path=$1 metadata uid gid mode size
  [[ -r "$path" && -f "$path" && ! -L "$path" ]] || return 1
  metadata="$(LC_ALL=C stat -c '%u|%g|%a|%s' -- "$path" 2>/dev/null)" || return 1
  IFS='|' read -r uid gid mode size <<<"$metadata"
  [[ "$uid" == "0" && "$gid" == "0" ]] || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#$mode & 0022) == 0)) || return 1
  [[ "$size" =~ ^[0-9]+$ ]] && ((size > 0 && size <= 4096))
}

dgx_station_release_schema_is_valid() {
  local path=$1 line key encoded value seen='|' expect_ota_date=0 prior_version
  local -a ota_versions=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ -z "$line" ]]; then
      ((expect_ota_date == 0)) || return 1
      continue
    fi
    [[ "$line" == *=* ]] || return 1
    key="${line%%=*}"
    encoded="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 1
    [[ ${#encoded} -ge 2 && "$encoded" == \"*\" && "$encoded" == *\" ]] || return 1
    value="${encoded:1:${#encoded}-2}"
    [[ "$value" != *\"* ]] || return 1
    case "$key" in
      DGX_NAME | DGX_PRETTY_NAME | DGX_SWBUILD_DATE | DGX_SWBUILD_VERSION | DGX_COMMIT_ID | DGX_OTA_PRETTY_NAME | DGX_OTA_VERSION | DGX_OTA_DATE | DGX_PLATFORM | DGX_SERIAL_NUMBER) ;;
      *) return 1 ;;
    esac
    # DGX OS appends unique OTA version/date pairs as release history. Require
    # each version to be immediately followed by its date; other keys remain
    # unique, and dgx_station_release_value returns the latest complete OTA.
    case "$key" in
      DGX_OTA_VERSION)
        ((expect_ota_date == 0)) || return 1
        if ((${#ota_versions[@]} > 0)); then
          for prior_version in "${ota_versions[@]}"; do
            [[ "$prior_version" != "$value" ]] || return 1
          done
        fi
        ota_versions+=("$value")
        expect_ota_date=1
        ;;
      DGX_OTA_DATE)
        ((expect_ota_date == 1)) || return 1
        expect_ota_date=0
        ;;
      *)
        ((expect_ota_date == 0)) || return 1
        [[ "$seen" != *"|${key}|"* ]] || return 1
        ;;
    esac
    seen="${seen}${key}|"
  done <"$path"
  ((expect_ota_date == 0))
}

dgx_station_release_value() {
  local path=$1 wanted=$2 line value="" found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "${wanted}="* ]] || continue
    value="${line#*=}"
    [[ ${#value} -ge 2 && "$value" == \"*\" && "$value" == *\" ]] || return 1
    value="${value:1:${#value}-2}"
    [[ "$value" != *\"* ]] || return 1
    found=1
  done <"$path"
  ((found == 1)) || return 1
  printf '%s' "$value"
}

dgx_station_release_profile() {
  local path=$1 ota_pretty="" pretty version build_date platform
  dgx_station_release_schema_is_valid "$path" || return 1
  platform="$(dgx_station_release_value "$path" DGX_PLATFORM)" || return 1
  [[ "$platform" == "DGX Server for GALAXY-GB300" ]] || return 1

  # DGX OS keeps its upgrade history in the DGX_OTA_* fields, so a host that has
  # an OTA history is classified by the most recent OTA version it applied.
  #
  # A host provisioned from a full DGX OS image also carries the identity field
  # DGX_OTA_PRETTY_NAME="DGX OS"; when that field is present it must read exactly
  # "DGX OS". It is absent on a host that was first installed from an older base
  # image (for example 7.4.1-GB300ws) and later OTA-upgraded, because an OTA
  # upgrade never adds that field. In that case, fall back to the hardware
  # identity and require DGX_PRETTY_NAME="NVIDIA DGX GB300WS" so that other
  # release lineages that also emit DGX_OTA_* fields stay fail-closed.
  if dgx_station_release_value "$path" DGX_OTA_VERSION >/dev/null 2>&1; then
    if ota_pretty="$(dgx_station_release_value "$path" DGX_OTA_PRETTY_NAME 2>/dev/null)"; then
      [[ "$ota_pretty" == "DGX OS" ]] || return 1
    else
      pretty="$(dgx_station_release_value "$path" DGX_PRETTY_NAME)" || return 1
      [[ "$pretty" == "NVIDIA DGX GB300WS" ]] || return 1
    fi
    version="$(dgx_station_release_value "$path" DGX_OTA_VERSION)" || return 1
    case "$version" in
      7.2.0 | 7.4.0 | 7.5.0) printf '%s' supported-dgx-os ;;
      *) return 1 ;;
    esac
    return 0
  fi

  # No-OTA factory images are separate, exact profiles. Do not infer support
  # merely from a missing OTA identity: internal BaseOS and customer images
  # use different software stacks and qualification evidence.
  dgx_station_release_value "$path" DGX_OTA_DATE >/dev/null 2>&1 && return 1
  pretty="$(dgx_station_release_value "$path" DGX_PRETTY_NAME)" || return 1
  version="$(dgx_station_release_value "$path" DGX_SWBUILD_VERSION)" || return 1
  build_date="$(dgx_station_release_value "$path" DGX_SWBUILD_DATE)" || return 1

  case "${pretty}|${version}|${build_date}" in
    "NVIDIA DGX Server|7.5.0-GB300ws-GB200ws|2026-04-02-08-20-16")
      printf '%s' supported-colossus-baseos
      ;;
    "NVIDIA DGX GB300WS|7.5.0|2026-06-16-11-48-10")
      printf '%s' supported-ai-developer-tools
      ;;
    *) return 1 ;;
  esac
}

dgx_station_release_contents_are_supported() {
  dgx_station_release_profile "$1" >/dev/null
}

dgx_station_release_is_supported() {
  local path=$1
  dgx_station_release_file_is_safe "$path" \
    && dgx_station_release_contents_are_supported "$path"
}

dgx_station_release_state() {
  local path=${1:-"$(dgx_station_release_path)"} profile
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    printf '%s' generic-ubuntu
  elif dgx_station_release_file_is_safe "$path" \
    && profile="$(dgx_station_release_profile "$path")"; then
    printf '%s' "$profile"
  else
    printf '%s' unsupported-dgx-os
  fi
}

MODE=""
LOG_FILE=""
DOCKER_GROUP_ADDED=0
CDI_LIFECYCLE_READY=0
NETWORK_VALIDATED=0
PACKAGE_TRANSACTION_SPECS=()
APT_TRANSACTION_GUARD_DIR=""
APT_TRANSACTION_HOOK=""
GPU_ROWS_ERROR=""

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
Usage: prepare-dgx-station-host.sh --check|--apply|--verify [--force-station-install]

  --check   Read-only eligibility and current-state report.
  --apply   Install exact prerequisites or finish post-reboot runtime setup.
  --verify  Read-only host verification plus ephemeral GPU container tests.
  --force-station-install
            Bypass only the DGX release-metadata allowlist. ARM64 Ubuntu 24.04,
            Station GB300 hardware, and all factory-runtime health checks still
            apply. The existing driver and container runtime are preserved.

Exit 10 from --apply means an operator-controlled reboot is required. After
the reboot, run --apply once more, followed by --verify.
Exit 11 means Docker-group membership was added. Start a new login session and
run --apply again; a reboot is not required.
EOF
}

parse_args() {
  local arg
  MODE=""
  FORCE_STATION_INSTALL=0
  for arg in "$@"; do
    case "$arg" in
      --check | --apply | --verify | --classify-dgx-release)
        [[ -z "$MODE" ]] || return 1
        MODE="$arg"
        ;;
      --force-station-install) FORCE_STATION_INSTALL=1 ;;
      *) return 1 ;;
    esac
  done
  [[ -n "$MODE" ]] || return 1
  [[ "$MODE" != "--classify-dgx-release" || "$FORCE_STATION_INSTALL" == "0" ]]
}

is_station_gb300_product() {
  local product=${1:-}
  [[ "$product" =~ (^|[^[:alnum:]])[Ss][Tt][Aa][Tt][Ii][Oo][Nn]([^[:alnum:]]|$) &&
    "$product" =~ (^|[^[:alnum:]])[Gg][Bb]300([^[:alnum:]]|$) ]]
}

normalize_nvidia_pci_bus_id() {
  local bus_id domain rest
  bus_id="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  bus_id="${bus_id//[[:space:]]/}"
  [[ "$bus_id" =~ ^([0-9a-f]{4}|[0-9a-f]{8}):[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$ ]] || return 1
  domain="${bus_id%%:*}"
  rest="${bus_id#*:}"
  if ((${#domain} == 8)); then
    domain="${domain:4}"
  fi
  printf '%s:%s' "$domain" "$rest"
}

gb300_pci_device_is_known() {
  local candidate=$1 known
  for known in "${GB300_PCI_DEVICES[@]}"; do
    [[ "$candidate" == "$known" ]] && return 0
  done
  return 1
}

gb300_pci_device_display() {
  local rendered="" device
  for device in "${GB300_PCI_DEVICES[@]}"; do
    rendered+="${rendered:+/}${device#0x}"
  done
  printf '%s' "$rendered"
}

station_pci_device_is_gb300() {
  local bus_id=$1 pci_root=${2:-/sys/bus/pci/devices} pci_path vendor device class
  bus_id="$(normalize_nvidia_pci_bus_id "$bus_id")" || return 1
  pci_path="${pci_root}/${bus_id}"
  [[ -d "$pci_path" &&
    -r "$pci_path/vendor" &&
    -r "$pci_path/device" &&
    -r "$pci_path/class" ]] || return 1
  IFS= read -r vendor <"$pci_path/vendor" || return 1
  IFS= read -r device <"$pci_path/device" || return 1
  IFS= read -r class <"$pci_path/class" || return 1
  [[ "$vendor" == "$GB300_PCI_VENDOR" ]] || return 1
  gb300_pci_device_is_known "$device" || return 1
  [[ "$class" == "${GB300_PCI_CLASS_PREFIX}"* ]]
}

station_has_exact_gb300_pci_gpu() {
  local pci_root=${1:-/sys/bus/pci/devices} pci_path
  for pci_path in "$pci_root"/*; do
    station_pci_device_is_gb300 "${pci_path##*/}" "$pci_root" && return 0
  done
  return 1
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

file_sha256_matches() {
  local path=$1 expected=$2 actual
  root_owned_file_is_not_writable_by_group_or_other "$path" || return 1
  actual="$(sha256sum "$path" 2>/dev/null | awk '{print $1}')"
  [[ "$actual" == "$expected" ]]
}

baseos_fluent_bit_config_matches() {
  local path=$1 expected=$2 actual
  root_owned_file_is_not_writable_by_group_or_other "$path" || return 1
  actual="$({
    LC_ALL=C sed -E \
      -e 's/^([[:space:]]*Add Hostname) [A-Za-z0-9][A-Za-z0-9._-]*$/\1 <HOSTNAME>/' \
      -e 's/^([[:space:]]*Add MAC) ([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/\1 <MAC>/' \
      -e 's/^([[:space:]]*Add IP) ([0-9]{1,3}\.){3}[0-9]{1,3}$/\1 <IP>/' \
      "$path" \
      | sha256sum \
      | awk '{print $1}'
  } 2>/dev/null)" || return 1
  [[ "$actual" == "$expected" ]]
}

systemd_property_matches() {
  local unit=$1 property=$2 expected=$3 actual
  actual="$(systemctl show "$unit" -p "$property" --value 2>/dev/null)" || return 1
  [[ "$actual" == "$expected" ]]
}

baseos_failed_unit_matches() {
  local unit=$1 fragment=$2 unit_hash=$3 unit_state=$4 exec_status=${5:-}
  systemd_property_matches "$unit" LoadState loaded \
    && systemd_property_matches "$unit" ActiveState failed \
    && systemd_property_matches "$unit" SubState failed \
    && systemd_property_matches "$unit" Result exit-code \
    && systemd_property_matches "$unit" FragmentPath "$fragment" \
    && systemd_property_matches "$unit" UnitFileState "$unit_state" \
    && file_sha256_matches "$fragment" "$unit_hash" \
    || return 1
  [[ -z "$exec_status" ]] || systemd_property_matches "$unit" ExecMainStatus "$exec_status"
}

baseos_cloud_init_failure_is_qualified() {
  local result=/run/cloud-init/result.json
  ((NETWORK_VALIDATED == 1)) \
    && baseos_failed_unit_matches cloud-init.service \
      /usr/lib/systemd/system/cloud-init.service "$BASEOS_CLOUD_INIT_UNIT_SHA256" enabled 1 \
    && file_sha256_matches /etc/cloud/cloud.cfg "$BASEOS_CLOUD_CFG_SHA256" \
    && root_owned_file_is_not_writable_by_group_or_other "$result" \
    && grep -Fq '"datasource": "DataSourceConfigDrive ' "$result" \
    && grep -Fq "\"('bootcmd', ProcessExecutionError(" "$result"
}

baseos_fluent_bit_failure_is_qualified() {
  baseos_failed_unit_matches fluent-bit.service \
    /usr/lib/systemd/system/fluent-bit.service "$BASEOS_FLUENT_BIT_UNIT_SHA256" enabled 1 \
    && baseos_fluent_bit_config_matches \
      /etc/fluent-bit/fluent-bit.conf "$BASEOS_FLUENT_BIT_CFG_NORMALIZED_SHA256" \
    && file_sha256_matches /etc/fluent-bit/parsers.conf "$BASEOS_FLUENT_BIT_PARSERS_SHA256" \
    && file_sha256_matches /etc/fluent-bit/plugins.conf "$BASEOS_FLUENT_BIT_PLUGINS_SHA256"
}

baseos_fwupd_failure_is_qualified() {
  ((NETWORK_VALIDATED == 1)) \
    && baseos_failed_unit_matches fwupd-refresh.service \
      /usr/lib/systemd/system/fwupd-refresh.service "$BASEOS_FWUPD_UNIT_SHA256" static 1 \
    && file_sha256_matches /etc/fwupd/fwupd.conf "$BASEOS_FWUPD_CFG_SHA256" \
    && file_sha256_matches /etc/fwupd/remotes.d/lvfs-testing.conf "$BASEOS_FWUPD_LVFS_TESTING_SHA256" \
    && file_sha256_matches /etc/fwupd/remotes.d/lvfs.conf "$BASEOS_FWUPD_LVFS_SHA256" \
    && file_sha256_matches /etc/fwupd/remotes.d/vendor-directory.conf "$BASEOS_FWUPD_VENDOR_SHA256"
}

baseos_sssd_socket_failure_is_qualified() {
  local unit=$1 hash
  [[ ! -e /etc/sssd/sssd.conf && ! -L /etc/sssd/sssd.conf ]] || return 1
  case "$unit" in
    sssd-autofs.socket) hash="$BASEOS_SSSD_AUTOFS_UNIT_SHA256" ;;
    sssd-nss.socket) hash="$BASEOS_SSSD_NSS_UNIT_SHA256" ;;
    sssd-pam.socket) hash="$BASEOS_SSSD_PAM_UNIT_SHA256" ;;
    sssd-pam-priv.socket) hash="$BASEOS_SSSD_PAM_PRIV_UNIT_SHA256" ;;
    *) return 1 ;;
  esac
  baseos_failed_unit_matches "$unit" "/usr/lib/systemd/system/${unit}" "$hash" enabled
}

is_qualified_factory_failed_unit() {
  case "$STATION_HOST_PROFILE" in
    generic-ubuntu)
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
      ;;
    colossus-baseos)
      all_baseos_packages_exact || return 1
      case "${1:-}" in
        cloud-init.service) baseos_cloud_init_failure_is_qualified ;;
        fluent-bit.service) baseos_fluent_bit_failure_is_qualified ;;
        fwupd-refresh.service) baseos_fwupd_failure_is_qualified ;;
        sssd-autofs.socket | sssd-nss.socket | sssd-pam.socket | sssd-pam-priv.socket)
          baseos_sssd_socket_failure_is_qualified "$1"
          ;;
        *) return 1 ;;
      esac
      ;;
    forced-factory-runtime)
      case "${1:-}" in
        ibacm.service | rtkit-daemon.service) return 0 ;;
        *) return 1 ;;
      esac
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

all_baseos_packages_exact() {
  local spec
  for spec in "${BASEOS_PACKAGE_SPECS[@]}"; do
    package_is_exact "$spec" || return 1
  done
  return 0
}

verify_baseos_packages() {
  local spec
  for spec in "${BASEOS_PACKAGE_SPECS[@]}"; do
    package_is_exact "$spec" || fatal "BaseOS package does not match the qualified image: ${spec}"
  done
  info "baseos_packages=exact"
}

station_uses_factory_runtime() {
  case "$STATION_HOST_PROFILE" in
    stock-dgx-os | colossus-baseos | ai-developer-tools | forced-factory-runtime) return 0 ;;
    *) return 1 ;;
  esac
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
  local arch os_release_path product product_name_path release_path release_state
  arch="$(uname -m)"
  [[ "$arch" == "aarch64" || "$arch" == "arm64" ]] || fatal "Expected ARM64, found ${arch}"

  os_release_path="$(station_os_release_path)"
  [[ -r "$os_release_path" ]] || fatal "/etc/os-release is unavailable"
  # shellcheck disable=SC1090
  source "$os_release_path"
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] \
    || fatal "Expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}"
  product_name_path="$(station_product_name_path)"
  [[ -r "$product_name_path" ]] || fatal "DGX Station product identity is unavailable"
  product="$(<"$product_name_path")"
  is_station_gb300_product "$product" || fatal "Expected DGX Station GB300 DMI, found ${product}"
  release_path="$(dgx_station_release_path)"
  release_state="$(dgx_station_release_state "$release_path")"
  if ((FORCE_STATION_INSTALL == 1)); then
    case "$release_state" in
      generic-ubuntu | supported-dgx-os | supported-colossus-baseos | supported-ai-developer-tools)
        fatal "--force-station-install is only for unrecognized DGX Station release metadata. This host is already supported (${release_state}); omit --force-station-install."
        ;;
    esac
  fi
  case "$release_state" in
    generic-ubuntu)
      station_has_exact_gb300_pci_gpu "$(station_pci_devices_path)" \
        || fatal "Expected an NVIDIA GB300 PCI GPU (${GB300_PCI_VENDOR#0x}:$(gb300_pci_device_display)) before generic Ubuntu preparation"
      STATION_HOST_PROFILE="generic-ubuntu"
      ;;
    supported-dgx-os) STATION_HOST_PROFILE="stock-dgx-os" ;;
    supported-colossus-baseos) STATION_HOST_PROFILE="colossus-baseos" ;;
    supported-ai-developer-tools) STATION_HOST_PROFILE="ai-developer-tools" ;;
    *)
      if ((FORCE_STATION_INSTALL == 1)); then
        station_has_exact_gb300_pci_gpu "$(station_pci_devices_path)" \
          || fatal "Expected an NVIDIA GB300 PCI GPU (${GB300_PCI_VENDOR#0x}:$(gb300_pci_device_display)) before forced factory-runtime validation"
        STATION_HOST_PROFILE="forced-factory-runtime"
        warn "DGX release metadata allowlist bypassed by explicit --force-station-install intent; all hardware and factory-runtime health checks remain required"
      else
        fatal "This DGX Station OS image is outside the validated boundary"
      fi
      ;;
  esac
  info "platform=${product} profile=${STATION_HOST_PROFILE} release=${release_state} os=${PRETTY_NAME} arch=${arch} kernel=$(uname -r)"
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

check_dgx_os_docker_selection() {
  [[ -z "${DOCKER_HOST:-}" ]] \
    || fatal "Station factory-runtime validation requires the local Docker daemon; unset DOCKER_HOST and rerun"
  [[ -z "${DOCKER_CONTEXT:-}" || "${DOCKER_CONTEXT}" == "default" ]] \
    || fatal "Station factory-runtime validation requires the default local Docker context; unset DOCKER_CONTEXT and rerun"
}

station_local_default_docker() (
  unset DOCKER_HOST DOCKER_CONTEXT
  docker --context default "$@"
)

station_sudo_local_default_docker() {
  sudo -n env -u DOCKER_HOST -u DOCKER_CONTEXT docker --context default "$@"
}

host_docker() {
  if station_uses_factory_runtime; then
    station_local_default_docker "$@"
  else
    docker "$@"
  fi
}

host_docker_sudo() {
  if station_uses_factory_runtime; then
    station_sudo_local_default_docker "$@"
  else
    sudo -n docker "$@"
  fi
}

query_host_docker() {
  local output
  DOCKER_QUERY_OUTPUT=""
  command -v docker >/dev/null 2>&1 || return 2
  if output="$(host_docker "$@" 2>/dev/null)"; then
    DOCKER_QUERY_OUTPUT="$output"
    return 0
  fi
  if [[ "$MODE" == "--apply" ]] && output="$(host_docker_sudo "$@" 2>/dev/null)"; then
    DOCKER_QUERY_OUTPUT="$output"
    if ((DOCKER_QUERY_USES_SUDO == 0)); then
      info "docker_access=sudo_until_group_membership_is_active"
      DOCKER_QUERY_USES_SUDO=1
    fi
    return 0
  fi
  if systemctl is-active --quiet docker.service; then
    fatal "Docker is active but inaccessible to this login; start a new login session with docker-group membership"
  fi
  fatal "Docker is installed but inactive, so existing container state cannot be verified safely; start Docker and rerun preparation"
}

normalize_container_ids() {
  LC_ALL=C sort -u | awk 'NF'
}

container_count() {
  awk 'NF { count++ } END { print count + 0 }'
}

capture_docker_container_baseline() {
  local status running running_count
  ((DOCKER_BASELINE_CAPTURED == 0)) || return 0
  if query_host_docker ps -aq --no-trunc; then
    DOCKER_CONTAINER_BASELINE="$(normalize_container_ids <<<"$DOCKER_QUERY_OUTPUT")"
  else
    status=$?
    ((status == 2)) || return "$status"
    DOCKER_CONTAINER_BASELINE=""
  fi
  DOCKER_CONTAINER_BASELINE_TOTAL="$(container_count <<<"$DOCKER_CONTAINER_BASELINE")"
  DOCKER_BASELINE_CAPTURED=1

  running=""
  if command -v docker >/dev/null 2>&1; then
    query_host_docker ps -q --no-trunc
    running="$(normalize_container_ids <<<"$DOCKER_QUERY_OUTPUT")"
  fi
  running_count="$(container_count <<<"$running")"
  info "docker_container_baseline_total=${DOCKER_CONTAINER_BASELINE_TOTAL} running=${running_count}"
  if ((DOCKER_CONTAINER_BASELINE_TOTAL > 0)); then
    warn "Existing Docker container records will be preserved during Station preparation"
  fi
}

verify_docker_container_baseline() {
  local current current_total status
  ((DOCKER_BASELINE_CAPTURED == 1)) || capture_docker_container_baseline
  if query_host_docker ps -aq --no-trunc; then
    current="$(normalize_container_ids <<<"$DOCKER_QUERY_OUTPUT")"
  else
    status=$?
    ((status == 2)) || return "$status"
    current=""
  fi
  current_total="$(container_count <<<"$current")"
  if [[ "$current" != "$DOCKER_CONTAINER_BASELINE" ]]; then
    fatal "Docker container inventory changed during Station preparation (before=${DOCKER_CONTAINER_BASELINE_TOTAL}, after=${current_total}); rerun after container activity stops"
  fi
  info "docker_container_baseline=preserved total=${current_total}"
}

require_no_running_docker_containers() {
  local action=${1:-this host mutation}
  command -v docker >/dev/null 2>&1 || return 0
  query_host_docker ps --format '{{.ID}} {{.Names}}'
  [[ -z "$DOCKER_QUERY_OUTPUT" ]] \
    || fatal "Running Docker containers block ${action}: ${DOCKER_QUERY_OUTPUT}"
  info "running_docker_containers=none action=${action}"
}

require_no_autorestarting_stopped_containers() {
  local action=${1:-this Docker restart or reboot} line blockers=""
  local -a container_ids=()
  command -v docker >/dev/null 2>&1 || return 0
  query_host_docker ps -aq --no-trunc
  while IFS= read -r line; do
    [[ -n "$line" ]] && container_ids+=("$line")
  done <<<"$DOCKER_QUERY_OUTPUT"
  ((${#container_ids[@]} == 0)) && return 0
  query_host_docker inspect \
    --format '{{.Id}} {{.Name}} {{.State.Running}} {{.HostConfig.RestartPolicy.Name}}' \
    "${container_ids[@]}"
  blockers="$(awk '
    $3 == "false" && $4 != "" && $4 != "no" {
      sub(/^\//, "", $2)
      print substr($1, 1, 12) " " $2 " restart=" $4
    }
  ' <<<"$DOCKER_QUERY_OUTPUT")"
  [[ -z "$blockers" ]] \
    || fatal "Stopped containers with restart policies block ${action}: ${blockers}"
  info "autorestarting_stopped_containers=none action=${action}"
}

warn_openibd_remediation() {
  warn "openibd.service configures optional Mellanox RDMA networking; NemoClaw does not require RDMA"
  warn "Check the default route: ip route get 1.1.1.1"
  warn "Check NFS mount options: findmnt -rn -t nfs,nfs4 -o TARGET,OPTIONS"
  warn "These checks are not exhaustive; confirm no RDMA-backed networking, storage, or workloads are in use"
  warn "If this host does not use RDMA, run: sudo systemctl disable openibd.service"
  warn "After disabling the unused service, reboot and rerun the NemoClaw installer"
  warn "If this host uses RDMA, repair OpenIB/OFED before rerunning the installer"
  warn "NemoClaw did not change systemd or networking state"
}

check_failed_units() {
  local unit failed_output blocking=0 qualified_label
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
      if [[ "$STATION_HOST_PROFILE" == "generic-ubuntu" ]]; then
        qualified_label="generic-image"
      else
        qualified_label="$STATION_HOST_PROFILE"
      fi
      warn "condition-qualified ${qualified_label} failed unit: ${unit}"
    else
      warn "unqualified failed unit: ${unit}"
      [[ "$unit" != "openibd.service" ]] || warn_openibd_remediation
      blocking=1
    fi
  done
  ((blocking == 0)) || fatal "Unqualified failed system units block Station preparation"
}

check_agent_and_inference_conflicts() {
  local processes matches listeners
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

  info "agent_inference_workloads=none port_8000=free"
}

require_docker_mutation_quiescence() {
  local action=$1
  check_agent_and_inference_conflicts
  verify_docker_container_baseline
  require_no_running_docker_containers "$action"
}

require_docker_restart_quiescence() {
  local action=$1
  require_docker_mutation_quiescence "$action"
  require_no_autorestarting_stopped_containers "$action"
  require_docker_mutation_quiescence "$action"
}

exit_reboot_required() {
  require_docker_restart_quiescence "rebooting the Station host"
  info "APPLY_RESULT=REBOOT_REQUIRED"
  info "Run: sudo reboot"
  exit "$REBOOT_REQUIRED_EXIT"
}

loaded_driver_version() {
  local rows row bus_id driver pci_root
  command -v nvidia-smi >/dev/null 2>&1 || return 0
  rows="$(nvidia-smi --query-gpu=pci.bus_id,driver_version --format=csv,noheader 2>/dev/null)" \
    || return 0
  pci_root="$(station_pci_devices_path)"
  while IFS= read -r row; do
    [[ -n "${row//[[:space:]]/}" ]] || continue
    IFS=',' read -r bus_id driver <<<"$row"
    bus_id="$(normalize_nvidia_pci_bus_id "$bus_id")" || continue
    station_pci_device_is_gb300 "$bus_id" "$pci_root" || continue
    printf '%s' "${driver//[[:space:]]/}"
    return 0
  done <<<"$rows"
}

driver_is_loaded() {
  [[ -n "$(loaded_driver_version)" ]]
}

driver_loaded_exact() {
  [[ "$(loaded_driver_version)" == "$DRIVER_VERSION" ]]
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
  require_command sed
  require_command sha256sum
  require_command sort
  require_command ss
  require_command stat
  require_command systemctl
  check_platform
  if station_uses_factory_runtime; then
    info "factory_packages=preserved package_and_driver_mutation=disabled"
    check_dgx_os_docker_selection
    if [[ "$STATION_HOST_PROFILE" == "colossus-baseos" ]]; then
      verify_baseos_packages
    fi
  else
    check_secure_boot
    check_kernel_headers
  fi
  check_capacity
  check_network
  check_package_managers_idle
  check_failed_units
  check_agent_and_inference_conflicts
  capture_docker_container_baseline
  require_no_running_docker_containers "initial Station host preparation"
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

ensure_docker_repository_source() {
  local docker_asc=$1 docker_gpg=$2 docker_gpg_list=$3 docker_asc_list=$4
  local source_target=/etc/apt/sources.list.d/docker.list
  local gpg_key_target=/etc/apt/keyrings/docker.gpg
  local asc_key_target=/etc/apt/keyrings/docker.asc

  sudo test ! -L "$source_target" \
    || fatal "Docker repository source must not be a symbolic link: ${source_target}"
  if ! sudo test -e "$source_target"; then
    install_exact_file_or_reuse "$docker_gpg" "$gpg_key_target" 0644 docker_repository_key
    install_exact_file_or_reuse "$docker_gpg_list" "$source_target" 0644 docker_repository_source
    return 0
  fi

  assert_root_regular_file_safe "$source_target" 0644 "Docker repository source"
  if sudo cmp -s "$docker_gpg_list" "$source_target"; then
    assert_root_regular_file_safe "$gpg_key_target" 0644 "Docker repository key"
    sudo cmp -s "$docker_gpg" "$gpg_key_target" \
      || fatal "Existing Docker repository key differs from the verified dearmored key: ${gpg_key_target}"
    info "docker_repository_source=exact path=${source_target}"
    return 0
  fi

  if sudo cmp -s "$docker_asc_list" "$source_target"; then
    assert_root_regular_file_safe "$asc_key_target" 0644 "Docker repository ASCII key"
    sudo cmp -s "$docker_asc" "$asc_key_target" \
      || fatal "Existing Docker repository ASCII key differs from the verified key: ${asc_key_target}"
    info "docker_repository_source=verified_compatible path=${source_target}"
    return 0
  fi

  fatal "Existing Docker repository source differs from the validated .gpg and .asc forms; refusing to overwrite ${source_target}"
}

configure_repositories() {
  local tmp cuda_deb docker_asc docker_gpg docker_gpg_list docker_asc_list
  tmp="$(mktemp -d)"
  cuda_deb="${tmp}/cuda-keyring.deb"
  docker_asc="${tmp}/docker.asc"
  docker_gpg="${tmp}/docker.gpg"
  docker_gpg_list="${tmp}/docker-gpg.list"
  docker_asc_list="${tmp}/docker-asc.list"

  info "Downloading and verifying official repository keys"
  ensure_cuda_keyring "$cuda_deb"

  curl --fail --silent --show-error --location "$DOCKER_KEY_URL" --output "$docker_asc"
  verify_file_sha256 "$docker_asc" "$DOCKER_KEY_SHA256"
  verify_key_fingerprint "$docker_asc" "$DOCKER_KEY_FINGERPRINT"
  gpg --batch --yes --dearmor --output "$docker_gpg" "$docker_asc"
  ensure_root_directory_safe /etc/apt/keyrings /etc/apt 0755 "Docker repository key directory"
  assert_root_directory_safe /etc/apt/sources.list.d "Docker repository source directory"
  printf '%s\n' \
    'deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable' \
    >"$docker_gpg_list"
  printf '%s\n' \
    'deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable' \
    >"$docker_asc_list"
  ensure_docker_repository_source "$docker_asc" "$docker_gpg" "$docker_gpg_list" "$docker_asc_list"

  rm -rf "$tmp"
  info "repository_keys=verified"
}

collect_package_transaction_specs() {
  local spec state
  PACKAGE_TRANSACTION_SPECS=()
  for spec in "${PACKAGE_SPECS[@]}"; do
    state="$(package_state "$spec")"
    case "$state" in
      missing | approved-transition) PACKAGE_TRANSACTION_SPECS+=("$spec") ;;
      exact) ;;
      *) fatal "Package transaction contains an unapproved prerequisite state: ${spec} (${state})" ;;
    esac
  done
  ((${#PACKAGE_TRANSACTION_SPECS[@]} > 0)) \
    || fatal "Package transaction has no missing or approved-transition prerequisites"
}

validate_package_availability() {
  local spec
  for spec in "$@"; do
    apt-cache show "$spec" >/dev/null 2>&1 || fatal "Exact package version is unavailable: ${spec}"
  done
  info "exact_package_versions=available"
}

apt_guard_fatal() {
  printf 'APT transaction guard: %s\n' "$*" >&2
  return 1
}

validate_apt_preinstall_plan() {
  local targets_file=$1 line package old_version old_arch old_multiarch direction
  local new_version new_arch new_multiarch action extra record_key
  local target expected allowed_old native_arch target_line target_expected target_allowed_old target_native_arch
  local manifest_native_arch=""
  local configured='|' changed='|' seen_targets='|' target_names='|'
  [[ -r "$targets_file" && -f "$targets_file" && ! -L "$targets_file" ]] \
    || apt_guard_fatal "target manifest is unavailable or unsafe: ${targets_file}" || return

  while IFS='|' read -r target expected allowed_old native_arch extra; do
    [[ -n "$target" && -n "$expected" && -n "$native_arch" && -z "$extra" ]] \
      || apt_guard_fatal "target manifest contains an invalid record" || return
    [[ "$target" =~ ^[a-z0-9][a-z0-9+.-]+$ ]] \
      || apt_guard_fatal "target manifest contains an invalid package name: ${target}" || return
    [[ "$expected" != *[[:space:]]* && "$expected" != *"|"* &&
      "$allowed_old" != *[[:space:]]* && "$allowed_old" != *"|"* &&
      "$native_arch" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
      || apt_guard_fatal "target manifest contains an invalid version for ${target}" || return
    [[ "$target_names" != *"|${target}|"* ]] \
      || apt_guard_fatal "target manifest repeats package ${target}" || return
    if [[ -z "$manifest_native_arch" ]]; then
      manifest_native_arch=$native_arch
    else
      [[ "$native_arch" == "$manifest_native_arch" ]] \
        || apt_guard_fatal "target manifest mixes native architectures" || return
    fi
    target_names="${target_names}${target}|"
  done <"$targets_file"
  [[ "$target_names" != "|" ]] || apt_guard_fatal "target manifest is empty" || return

  IFS= read -r line || apt_guard_fatal "APT omitted the pre-install protocol header" || return
  [[ "$line" == "VERSION 3" ]] \
    || apt_guard_fatal "APT pre-install protocol must be VERSION 3, found: ${line}" || return
  while IFS= read -r line; do
    [[ -n "$line" ]] || break
  done
  [[ -z "$line" ]] || apt_guard_fatal "APT pre-install protocol omitted its record separator" || return

  while read -r package old_version old_arch old_multiarch direction new_version new_arch new_multiarch action extra; do
    [[ -n "$package" && -n "$old_version" && -n "$old_arch" && -n "$old_multiarch" &&
      -n "$direction" && -n "$new_version" && -n "$new_arch" && -n "$new_multiarch" &&
      -n "$action" && -z "$extra" ]] \
      || apt_guard_fatal "APT emitted a malformed package action" || return
    [[ "$package" =~ ^[a-z0-9][a-z0-9+.-]+$ ]] \
      || apt_guard_fatal "APT emitted an invalid package name: ${package}" || return
    [[ "$old_arch" == "-" || "$old_arch" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
      || apt_guard_fatal "APT emitted an invalid old architecture for ${package}: ${old_arch}" || return
    [[ "$new_arch" == "-" || "$new_arch" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
      || apt_guard_fatal "APT emitted an invalid new architecture for ${package}: ${new_arch}" || return
    [[ "$old_multiarch" =~ ^(same|foreign|allowed|none|no|-)$ &&
      "$new_multiarch" =~ ^(same|foreign|allowed|none|no|-)$ ]] \
      || apt_guard_fatal "APT emitted an invalid Multi-Arch field for ${package}" || return
    record_key="${package}@${new_arch}"
    case "$action" in
      "**REMOVE**") apt_guard_fatal "APT proposed removing ${package}" || return ;;
      "**CONFIGURE**")
        configured="${configured}${record_key}|"
        ;;
      /*)
        [[ "$changed" != *"|${record_key}|"* ]] \
          || apt_guard_fatal "APT proposed duplicate archive actions for ${record_key}" || return
        changed="${changed}${record_key}|"
        target=""
        expected=""
        allowed_old=""
        native_arch=""
        while IFS='|' read -r target_line target_expected target_allowed_old target_native_arch; do
          if [[ "$target_line" == "$package" ]]; then
            target=$target_line
            expected=$target_expected
            allowed_old=$target_allowed_old
            native_arch=$target_native_arch
            break
          fi
        done <"$targets_file"
        if [[ -z "$native_arch" ]]; then
          native_arch=$manifest_native_arch
        fi
        [[ "$new_arch" == "$native_arch" || "$new_arch" == "all" ]] \
          || apt_guard_fatal "APT selected foreign architecture ${new_arch} for ${package}; expected ${native_arch} or all" || return
        if [[ -n "$target" ]]; then
          [[ "$new_version" == "$expected" ]] \
            || apt_guard_fatal "APT selected ${package}=${new_version}; expected ${expected}" || return
          if [[ -n "$allowed_old" ]]; then
            [[ "$old_version" == "$allowed_old" && "$direction" == "<" &&
              ("$old_arch" == "$native_arch" || "$old_arch" == "all") ]] \
              || apt_guard_fatal "APT changed approved transition ${package} from ${old_version}; expected ${allowed_old}" || return
          else
            [[ "$old_version" == "-" && "$old_arch" == "-" && "$direction" == "<" ]] \
              || apt_guard_fatal "APT proposed changing retained target ${package}=${old_version}" || return
          fi
          seen_targets="${seen_targets}${package}|"
        else
          [[ "$old_version" == "-" && "$old_arch" == "-" && "$direction" == "<" ]] \
            || apt_guard_fatal "APT proposed changing retained package ${package}=${old_version}" || return
        fi
        ;;
      *) apt_guard_fatal "APT emitted an unsupported action for ${package}: ${action}" || return ;;
    esac
  done

  while IFS='|' read -r target expected allowed_old native_arch; do
    [[ "$seen_targets" == *"|${target}|"* ]] \
      || apt_guard_fatal "APT omitted required target ${target}=${expected}" || return
  done <"$targets_file"
  while [[ "$configured" != "|" ]]; do
    configured="${configured#|}"
    package="${configured%%|*}"
    configured="|${configured#*|}"
    [[ "$changed" == *"|${package}|"* ]] \
      || apt_guard_fatal "APT proposed configuring retained package ${package} without an archive action" || return
  done
}

cleanup_apt_transaction_guard() {
  local guard_dir=${APT_TRANSACTION_GUARD_DIR:-}
  APT_TRANSACTION_GUARD_DIR=""
  APT_TRANSACTION_HOOK=""
  [[ -n "$guard_dir" ]] || return 0
  if [[ ! "$guard_dir" =~ ^/run/nemoclaw-apt-transaction\.[A-Za-z0-9]+$ ]]; then
    warn "refusing to clean unexpected APT transaction guard path: ${guard_dir}"
    return 0
  fi
  sudo rm -rf -- "$guard_dir" \
    || warn "could not remove APT transaction guard directory: ${guard_dir}"
}

create_apt_transaction_guard() {
  local spec state name expected allowed_old native_arch targets="" hook_path targets_path
  native_arch="$(sudo dpkg --print-architecture)"
  [[ "$native_arch" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
    || fatal "Could not determine the native package architecture"
  for spec in "${PACKAGE_TRANSACTION_SPECS[@]}"; do
    state="$(package_state "$spec")"
    name="$(package_name "$spec")"
    expected="$(package_expected_version "$spec")"
    case "$state" in
      missing) allowed_old="" ;;
      approved-transition) allowed_old="$(installed_version "$name")" ;;
      *) fatal "Cannot authorize APT target ${spec} from state ${state}" ;;
    esac
    targets="${targets}${name}|${expected}|${allowed_old}|${native_arch}"$'\n'
  done

  APT_TRANSACTION_GUARD_DIR="$(sudo mktemp -d /run/nemoclaw-apt-transaction.XXXXXXXXXX)" \
    || fatal "Could not create the root-owned APT transaction guard directory"
  [[ "$APT_TRANSACTION_GUARD_DIR" =~ ^/run/nemoclaw-apt-transaction\.[A-Za-z0-9]+$ ]] \
    || fatal "APT transaction guard returned an unexpected path: ${APT_TRANSACTION_GUARD_DIR}"
  hook_path="${APT_TRANSACTION_GUARD_DIR}/verify-plan"
  targets_path="${APT_TRANSACTION_GUARD_DIR}/targets"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
    declare -f apt_guard_fatal
    declare -f validate_apt_preinstall_plan
    # The generated hook expands its own path at execution time.
    # shellcheck disable=SC2016
    printf '%s\n' 'validate_apt_preinstall_plan "${0%/*}/targets"'
  } | sudo tee "$hook_path" >/dev/null
  printf '%s' "$targets" | sudo tee "$targets_path" >/dev/null
  sudo chmod 0700 "$hook_path"
  sudo chmod 0600 "$targets_path"
  assert_root_directory_safe "$APT_TRANSACTION_GUARD_DIR" "APT transaction guard directory"
  assert_root_regular_file_safe "$hook_path" 0700 "APT transaction guard"
  assert_root_regular_file_safe "$targets_path" 0600 "APT transaction target manifest"
  APT_TRANSACTION_HOOK="/bin/bash ${hook_path}"
}

validate_apt_simulation() {
  local simulation=$1
  shift
  local spec target_spec name expected actual line action version before_version
  local simulated_targets='|' simulated_changes='|'

  while IFS= read -r line; do
    [[ "$line" =~ ^(Inst|Conf|Remv|Purg)[[:space:]] ]] || continue
    read -r action name _ <<<"$line"
    case "$action" in
      Remv | Purg) fatal "APT simulation proposed a package removal: ${line}" ;;
      Conf)
        [[ "$simulated_changes" == *"|${name}|"* ]] \
          || fatal "APT simulation proposed configuration without an approved install: ${line}"
        ;;
      Inst)
        [[ "$simulated_changes" != *"|${name}|"* ]] \
          || fatal "APT simulation proposed a duplicate package change: ${line}"
        simulated_changes="${simulated_changes}${name}|"
        target_spec=""
        for spec in "$@"; do
          if [[ "$(package_name "$spec")" == "$name" ]]; then
            target_spec=$spec
            break
          fi
        done
        if [[ -n "$target_spec" ]]; then
          [[ "$line" == *"("* ]] || fatal "APT simulation omitted the target version: ${line}"
          version="${line#*(}"
          version="${version%%[[:space:]]*}"
          version="${version%)}"
          expected="$(package_expected_version "$target_spec")"
          [[ "$version" == "$expected" ]] \
            || fatal "APT simulation selected ${name}=${version}; expected ${expected}"
          simulated_targets="${simulated_targets}${name}|"
          continue
        fi

        # A target package may require a new dependency, but APT must not
        # upgrade, downgrade, or reinstall any package retained from the host.
        actual="$(installed_version "$name")"
        before_version="${line%%(*}"
        [[ -z "$actual" && "$before_version" != *"["* ]] \
          || fatal "APT simulation proposed changing retained package ${name}=${actual}: ${line}"
        ;;
    esac
  done <<<"$simulation"

  for spec in "$@"; do
    name="$(package_name "$spec")"
    [[ "$simulated_targets" == *"|${name}|"* ]] \
      || fatal "APT simulation did not include required package ${spec}"
  done
}

simulate_install() {
  local simulation
  [[ "$APT_TRANSACTION_GUARD_DIR" =~ ^/run/nemoclaw-apt-transaction\.[A-Za-z0-9]+$ &&
    "$APT_TRANSACTION_HOOK" == "/bin/bash ${APT_TRANSACTION_GUARD_DIR}/verify-plan" ]] \
    || fatal "APT transaction guard is not ready"
  simulation="$(sudo env DEBIAN_FRONTEND=noninteractive LC_ALL=C \
    apt-get -s install --no-install-recommends --no-remove \
    -o "DPkg::Pre-Install-Pkgs::=${APT_TRANSACTION_HOOK}" \
    -o "DPkg::Tools::options::/bin/bash::Version=3" "$@")" \
    || fatal "APT simulation failed"
  printf '%s\n' "$simulation"
  validate_apt_simulation "$simulation" "$@"
  info "apt_simulation=missing_only retained_packages=unchanged"
}

install_packages() {
  collect_package_transaction_specs
  configure_repositories
  info "Refreshing package metadata"
  sudo apt-get update
  validate_package_availability "${PACKAGE_TRANSACTION_SPECS[@]}"
  create_apt_transaction_guard
  simulate_install "${PACKAGE_TRANSACTION_SPECS[@]}"
  require_docker_restart_quiescence "Station prerequisite package installation"
  info "Installing missing pinned Station prerequisites"
  sudo env DEBIAN_FRONTEND=noninteractive LC_ALL=C \
    apt-get install -y --no-install-recommends --no-remove \
    -o "DPkg::Pre-Install-Pkgs::=${APT_TRANSACTION_HOOK}" \
    -o "DPkg::Tools::options::/bin/bash::Version=3" \
    "${PACKAGE_TRANSACTION_SPECS[@]}"
  cleanup_apt_transaction_guard

  local spec
  for spec in "${PACKAGE_SPECS[@]}"; do
    package_is_exact "$spec" || fatal "Installed package does not match ${spec}"
  done
  info "pinned_packages=installed"
}

ensure_docker_group() {
  local user_name=${SUDO_USER:-$USER}
  getent group docker >/dev/null 2>&1 || fatal "Docker group is missing on the Station host"
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
  require_docker_mutation_quiescence "enabling NVIDIA CDI refresh"
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
  require_docker_mutation_quiescence "refreshing NVIDIA CDI configuration"
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
  local rows
  rows="$(sudo docker run --rm --device nvidia.com/gpu=all "$ACCEPTANCE_IMAGE" nvidia-smi \
    --query-gpu=pci.bus_id,name,driver_version,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total \
    --format=csv,noheader,nounits)" || return 1
  gpu_rows_are_valid "$rows" || {
    warn "CDI container probe did not expose the qualified GB300: ${GPU_ROWS_ERROR}"
    return 1
  }
}

run_gpus_test_sudo() {
  local rows
  rows="$(sudo docker run --rm --gpus all "$ACCEPTANCE_IMAGE" nvidia-smi \
    --query-gpu=pci.bus_id,name,driver_version,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total \
    --format=csv,noheader,nounits)" || return 1
  gpu_rows_are_valid "$rows" || {
    warn "Docker --gpus container probe did not expose the qualified GB300: ${GPU_ROWS_ERROR}"
    return 1
  }
}

run_cdi_test_user() {
  local rows
  rows="$(docker run --rm --device nvidia.com/gpu=all "$ACCEPTANCE_IMAGE" nvidia-smi \
    --query-gpu=pci.bus_id,name,driver_version,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total \
    --format=csv,noheader,nounits)" || return 1
  gpu_rows_are_valid "$rows"
}

run_gpus_test_user() {
  local rows
  rows="$(docker run --rm --gpus all "$ACCEPTANCE_IMAGE" nvidia-smi \
    --query-gpu=pci.bus_id,name,driver_version,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total \
    --format=csv,noheader,nounits)" || return 1
  gpu_rows_are_valid "$rows"
}

ensure_dgx_os_acceptance_image() {
  if ! station_sudo_local_default_docker image inspect "$ACCEPTANCE_IMAGE" >/dev/null 2>&1; then
    info "Pulling digest-pinned ARM64 acceptance image"
    station_sudo_local_default_docker pull --platform linux/arm64 "$ACCEPTANCE_IMAGE"
  fi
}

run_dgx_os_cdi_test_sudo() {
  local rows
  rows="$(station_sudo_local_default_docker run --rm --device nvidia.com/gpu=all "$ACCEPTANCE_IMAGE" nvidia-smi \
    --query-gpu=pci.bus_id,name,driver_version,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total \
    --format=csv,noheader,nounits)" || return 1
  gpu_rows_are_valid "$rows" || {
    warn "Factory-runtime CDI probe did not expose the qualified GB300: ${GPU_ROWS_ERROR}"
    return 1
  }
}

run_dgx_os_gpus_test_sudo() {
  local rows
  rows="$(station_sudo_local_default_docker run --rm --gpus all "$ACCEPTANCE_IMAGE" nvidia-smi \
    --query-gpu=pci.bus_id,name,driver_version,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total \
    --format=csv,noheader,nounits)" || return 1
  gpu_rows_are_valid "$rows" || {
    warn "Factory-runtime Docker --gpus probe did not expose the qualified GB300: ${GPU_ROWS_ERROR}"
    return 1
  }
}

run_dgx_os_cdi_test_user() {
  local rows
  rows="$(station_local_default_docker run --rm --device nvidia.com/gpu=all "$ACCEPTANCE_IMAGE" nvidia-smi \
    --query-gpu=pci.bus_id,name,driver_version,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total \
    --format=csv,noheader,nounits)" || return 1
  gpu_rows_are_valid "$rows"
}

run_dgx_os_gpus_test_user() {
  local rows
  rows="$(station_local_default_docker run --rm --gpus all "$ACCEPTANCE_IMAGE" nvidia-smi \
    --query-gpu=pci.bus_id,name,driver_version,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total \
    --format=csv,noheader,nounits)" || return 1
  gpu_rows_are_valid "$rows"
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
  require_docker_mutation_quiescence "configuring the NVIDIA Docker runtime"
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
  require_docker_mutation_quiescence "configuring the NVIDIA Docker runtime"
  if ! sudo nvidia-ctk runtime configure --runtime=docker; then
    fail_after_docker_runtime_rollback "$backup_dir" "$previous_daemon" "NVIDIA runtime registration failed"
  fi
  if ! root_regular_file_is_safe /etc/docker/daemon.json ""; then
    fail_after_docker_runtime_rollback "$backup_dir" "$previous_daemon" "NVIDIA runtime registration produced an unsafe Docker daemon configuration"
  fi
  if ! (require_docker_restart_quiescence "restarting Docker after NVIDIA runtime registration"); then
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
    if ! (require_docker_restart_quiescence "restarting Docker during runtime rollback"); then
      return 1
    fi
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
  if systemctl is-active --quiet containerd.service && systemctl is-active --quiet docker.service; then
    require_docker_mutation_quiescence "enabling or configuring the Station container runtime"
    sudo systemctl enable containerd.service docker.service
  else
    require_docker_restart_quiescence "starting or configuring the Station container runtime"
    sudo systemctl enable --now containerd.service docker.service
  fi
  ensure_docker_group
  ensure_acceptance_image
  ensure_cdi_runtime
  configure_docker_runtime_if_needed
  verify_docker_container_baseline
  info "runtime_setup=complete"
}

check_dgx_os_runtime_commands() {
  require_command docker
  require_command nvidia-ctk
  require_command nvidia-smi
  driver_is_loaded || fatal "The Station factory image did not expose a loaded NVIDIA driver"
  verify_gpu
  info "factory_runtime_commands=present"
}

verify_dgx_os_runtime_sudo() {
  check_dgx_os_runtime_commands
  systemctl is-active --quiet containerd.service || fatal "containerd.service is not active on the Station factory image"
  systemctl is-active --quiet docker.service || fatal "docker.service is not active on the Station factory image"
  station_sudo_local_default_docker info >/dev/null 2>&1 \
    || fatal "The local Docker daemon is not reachable with sudo on the Station factory image"
  station_sudo_local_default_docker buildx version >/dev/null 2>&1 \
    || fatal "Docker Buildx is unavailable on the Station factory image"
  # The June 2026 AI Developer Tools factory image can leave its packaged CDI
  # refresh units disabled. Image production owns that source state; remove
  # this repair after clean-host qualification consistently supplies the CDI
  # device at boot.
  if [[ "$STATION_HOST_PROFILE" == "ai-developer-tools" ]]; then
    if sudo nvidia-ctk cdi list | grep -Fxq 'nvidia.com/gpu=all'; then
      info "cdi=nvidia.com/gpu=all source=factory_runtime"
    else
      refresh_cdi
    fi
  fi
  sudo nvidia-ctk cdi list | grep -Fxq 'nvidia.com/gpu=all' \
    || fatal "The Station factory image does not advertise the nvidia.com/gpu=all CDI device"
  ensure_dgx_os_acceptance_image
  run_dgx_os_cdi_test_sudo \
    || fatal "The Station factory image failed the CDI Docker GPU visibility test"
  run_dgx_os_gpus_test_sudo \
    || fatal "The Station factory image failed the Docker --gpus all GPU visibility test"
  verify_docker_container_baseline
  if [[ "$STATION_HOST_PROFILE" == "stock-dgx-os" ]]; then
    info "DGX_OS_HOST_READY host_runtime_mutation=container_image_cache_only"
  else
    info "STATION_FACTORY_HOST_READY"
  fi
}

verify_dgx_os_runtime_user() {
  check_dgx_os_runtime_commands
  systemctl is-active --quiet containerd.service || fatal "containerd.service is not active on the Station factory image"
  systemctl is-active --quiet docker.service || fatal "docker.service is not active on the Station factory image"
  station_local_default_docker info >/dev/null 2>&1 \
    || fatal "The current user cannot access the local Docker daemon; run --apply first"
  station_local_default_docker buildx version >/dev/null 2>&1 \
    || fatal "Docker Buildx is unavailable on the Station factory image"
  nvidia-ctk cdi list | grep -Fxq 'nvidia.com/gpu=all' \
    || fatal "The Station factory image does not advertise the nvidia.com/gpu=all CDI device"
  station_local_default_docker image inspect "$ACCEPTANCE_IMAGE" >/dev/null 2>&1 \
    || fatal "Digest-pinned acceptance image is missing; run --apply"
  run_dgx_os_cdi_test_user \
    || fatal "The Station factory image failed the CDI Docker GPU visibility test"
  run_dgx_os_gpus_test_user \
    || fatal "The Station factory image failed the Docker --gpus all GPU visibility test"
  verify_docker_container_baseline
  if [[ "$STATION_HOST_PROFILE" == "stock-dgx-os" ]]; then
    info "DGX_OS_HOST_READY"
  else
    info "STATION_FACTORY_HOST_READY"
  fi
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
  verify_docker_container_baseline
  info "STATION_HOST_READY"
}

gpu_rows_are_valid() {
  local rows=$1 row bus_id name driver corrected uncorrected gb300_count=0 expected_driver="" pci_root
  GPU_ROWS_ERROR=""
  case "$STATION_HOST_PROFILE" in
    generic-ubuntu) expected_driver="$DRIVER_VERSION" ;;
    colossus-baseos) expected_driver="$BASEOS_DRIVER_VERSION" ;;
  esac
  pci_root="$(station_pci_devices_path)"
  while IFS= read -r row; do
    [[ -n "${row//[[:space:]]/}" ]] || continue
    IFS=',' read -r bus_id name driver corrected uncorrected <<<"$row"
    if ! bus_id="$(normalize_nvidia_pci_bus_id "$bus_id")"; then
      GPU_ROWS_ERROR="nvidia-smi returned an invalid PCI bus ID: ${bus_id}"
      return 1
    fi
    name="${name#"${name%%[![:space:]]*}"}"
    driver="${driver//[[:space:]]/}"
    corrected="${corrected//[[:space:]]/}"
    uncorrected="${uncorrected//[[:space:]]/}"
    if ! station_pci_device_is_gb300 "$bus_id" "$pci_root"; then
      info "gpu_bdf=${bus_id} gpu=${name} role=auxiliary validation=skipped"
      continue
    fi
    if [[ -z "$driver" ]]; then
      GPU_ROWS_ERROR="NVIDIA driver is not loaded"
      return 1
    fi
    if [[ -n "$expected_driver" && "$driver" != "$expected_driver" ]]; then
      GPU_ROWS_ERROR="Expected driver ${expected_driver}, found ${driver}"
      return 1
    fi
    if [[ "$corrected" != "0" || "$uncorrected" != "0" ]]; then
      GPU_ROWS_ERROR="ECC must be 0/0, found corrected=${corrected} uncorrected=${uncorrected}"
      return 1
    fi
    ((gb300_count += 1))
    info "gpu_bdf=${bus_id} gpu=${name} role=inference driver=${driver} ecc_corrected=${corrected} ecc_uncorrected=${uncorrected}"
  done <<<"$rows"
  if ((gb300_count != 1)); then
    GPU_ROWS_ERROR="Expected exactly one NVIDIA GB300 PCI device, found ${gb300_count}"
    return 1
  fi
}

verify_gpu() {
  local rows
  rows="$(nvidia-smi \
    --query-gpu=pci.bus_id,name,driver_version,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total \
    --format=csv,noheader,nounits)" || fatal "nvidia-smi failed"
  gpu_rows_are_valid "$rows" || fatal "$GPU_ROWS_ERROR"
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
  run_cdi_test_user || fatal "CDI verification did not expose the qualified GB300: ${GPU_ROWS_ERROR}"
  run_gpus_test_user || fatal "Docker --gpus verification did not expose the qualified GB300: ${GPU_ROWS_ERROR}"
  verify_docker_container_baseline
  info "docker=$(docker version --format '{{.Server.Version}}') expected_docker=${DOCKER_VERSION} toolkit=$(nvidia-ctk --version | head -n1) expected_toolkit=${TOOLKIT_VERSION}"
  info "STATION_HOST_READY"
}

run_check() {
  common_preflight
  if station_uses_factory_runtime; then
    check_dgx_os_runtime_commands
    info "CHECK_RESULT=READY_FOR_FACTORY_RUNTIME_PREPARATION"
    return 0
  fi
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
  require_command sudo
  acquire_sudo
  common_preflight

  if station_uses_factory_runtime; then
    if reboot_required; then
      fatal "A reboot is pending on the Station factory image; reboot before running Station express install"
    fi
    if [[ "$STATION_HOST_PROFILE" == "colossus-baseos" ]]; then
      finish_runtime
    fi
    verify_dgx_os_runtime_sudo
    if [[ "$STATION_HOST_PROFILE" != "colossus-baseos" ]]; then
      ensure_docker_group
    fi
    if ((DOCKER_GROUP_ADDED == 1)); then
      warn "Docker group membership was added and requires a new login before onboarding"
      info "APPLY_RESULT=LOGIN_REQUIRED"
      exit "$LOGIN_REQUIRED_EXIT"
    fi
    info "APPLY_RESULT=COMPLETE"
    return 0
  fi

  require_command apt-cache
  require_command apt-get
  require_command cmp
  require_command curl
  require_command dpkg
  require_command gpg
  require_command grep
  require_command readlink
  require_command sha256sum

  if reboot_required; then
    if all_packages_exact && ! driver_loaded_exact; then
      warn "A reboot is required before runtime setup can continue"
      exit_reboot_required
    fi
    fatal "An unrelated reboot is already pending"
  fi

  if ! all_packages_exact; then
    assert_no_package_mismatches
    install_packages
    ensure_docker_group
    require_docker_restart_quiescence "enabling the Station container runtime and rebooting"
    sudo systemctl enable containerd.service docker.service nvidia-cdi-refresh.path nvidia-cdi-refresh.service
    verify_docker_container_baseline
    write_install_boot_marker
    exit_reboot_required
  fi

  if install_boot_marker_matches_current_boot; then
    warn "Package installation completed in the current boot"
    exit_reboot_required
  fi

  driver_loaded_exact || {
    warn "Pinned packages are installed but driver ${DRIVER_VERSION} is not loaded"
    exit_reboot_required
  }

  finish_runtime
  verify_apply_state
  if ((DOCKER_GROUP_ADDED == 1)); then
    warn "Docker group membership was added and requires a new login before onboarding"
    exit_reboot_required
  fi
  rm -f "$INSTALL_BOOT_MARKER"
  info "APPLY_RESULT=COMPLETE"
}

run_verify() {
  common_preflight
  require_command docker
  require_command nvidia-ctk
  require_command nvidia-smi
  if station_uses_factory_runtime; then
    if [[ "$STATION_HOST_PROFILE" == "colossus-baseos" ]]; then
      verify_cdi_refresh_lifecycle
    fi
    verify_dgx_os_runtime_user
    return 0
  fi
  all_packages_exact || fatal "Pinned prerequisite packages are incomplete; run --apply"
  driver_loaded_exact || fatal "Pinned driver is not loaded; reboot, then run --apply"
  verify_host
}

main() {
  if ! parse_args "$@"; then
    usage >&2
    exit 2
  fi
  if [[ "$MODE" == "--classify-dgx-release" ]]; then
    dgx_station_release_state
    return 0
  fi
  if [[ "$MODE" == "--apply" ]]; then
    setup_log
  else
    info "version=${SCRIPT_VERSION} mode=${MODE} log=disabled_read_only"
  fi
  trap 'on_error "$LINENO"' ERR
  trap 'cleanup_apt_transaction_guard' EXIT
  case "$MODE" in
    --check) run_check ;;
    --apply) run_apply ;;
    --verify) run_verify ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
