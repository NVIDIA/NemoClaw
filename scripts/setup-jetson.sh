#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SUDO=()
((EUID != 0)) && SUDO=(sudo)

info() {
  printf "[INFO]  %s\n" "$*"
}

error() {
  printf "[ERROR] %s\n" "$*" >&2
  exit 1
}

get_jetpack_version() {
  local release_line release revision l4t_version

  release_line="$(head -n1 /etc/nv_tegra_release 2>/dev/null || true)"
  [[ -n "$release_line" ]] || return 0

  release="$(printf '%s\n' "$release_line" | sed -n 's/^# R\([0-9][0-9]*\) (release).*/\1/p')"
  revision="$(printf '%s\n' "$release_line" | sed -n 's/^.*REVISION: \([0-9][0-9]*\)\..*$/\1/p')"
  l4t_version="${release}.${revision}"

  case "$l4t_version" in
    36.*)
      printf "%s" "jp6"
      ;;
    38.*)
      printf "%s" "jp7"
      ;;
    *)
      info "Jetson detected (L4T $l4t_version) but version is not recognized — skipping host setup"
      ;;
  esac
}

configure_jetson_host() {
  local jetpack_version="$1"

  if ((EUID != 0)); then
    info "Jetson host configuration requires sudo. You may be prompted for your password."
    "${SUDO[@]}" true >/dev/null || error "Sudo is required to apply Jetson host configuration."
  fi

  case "$jetpack_version" in
    jp6)
      "${SUDO[@]}" update-alternatives --set iptables /usr/sbin/iptables-legacy
      "${SUDO[@]}" sed -i '/"iptables": false,/d; /"bridge": "none"/d; s/"default-runtime": "nvidia",/"default-runtime": "nvidia"/' /etc/docker/daemon.json
      ;;
    jp7)
      # JP7 (Thor) does not need iptables or Docker daemon.json changes.
      ;;
    *)
      error "Unsupported Jetson version: $jetpack_version"
      ;;
  esac

  "${SUDO[@]}" modprobe br_netfilter
  "${SUDO[@]}" sysctl -w net.bridge.bridge-nf-call-iptables=1 >/dev/null

  # Persist across reboots
  echo "br_netfilter" | "${SUDO[@]}" tee /etc/modules-load.d/nemoclaw.conf >/dev/null
  echo "net.bridge.bridge-nf-call-iptables=1" | "${SUDO[@]}" tee /etc/sysctl.d/99-nemoclaw.conf >/dev/null

  if [[ "$jetpack_version" == "jp6" ]]; then
    "${SUDO[@]}" systemctl restart docker
  fi
}

main() {
  local jetpack_version
  jetpack_version="$(get_jetpack_version)"
  [[ -n "$jetpack_version" ]] || exit 0

  info "Jetson detected ($jetpack_version) — applying required host configuration"
  configure_jetson_host "$jetpack_version"
}

main "$@"
