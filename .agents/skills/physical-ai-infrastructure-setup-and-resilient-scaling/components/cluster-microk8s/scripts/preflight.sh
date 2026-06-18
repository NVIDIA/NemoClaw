#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

MIN_GIT_VERSION="2.25.0"
MIN_SNAP_VERSION="2.45.0"
MIN_NVIDIA_DRIVER_VERSION="525"
PASS=true
WARNINGS=0

fail() { echo "ERROR: $*" >&2; PASS=false; }
warn() { echo "WARNING: $*" >&2; WARNINGS=$((WARNINGS + 1)); }
ok() { echo "OK: $*"; }

require_cmds() {
  local cmd
  for cmd in "$@"; do
    if command -v "${cmd}" >/dev/null 2>&1; then
      ok "${cmd} found ($(command -v "${cmd}"))"
    else
      fail "${cmd} not found in PATH"
    fi
  done
}

version_ge() {
  local got="${1#v}"
  local want="${2#v}"
  got="${got%%[-+]*}"
  want="${want%%[-+]*}"
  awk -v got="${got}" -v want="${want}" '
    BEGIN {
      split(got, g, ".")
      split(want, w, ".")
      for (i = 1; i <= 3; i++) {
        if ((g[i] + 0) > (w[i] + 0)) exit 0
        if ((g[i] + 0) < (w[i] + 0)) exit 1
      }
    }
  '
}

check_driver() {
  local min_version="$1"
  local version=""
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    fail "nvidia-smi not found; NVIDIA driver >= ${min_version} required"
    return
  fi
  version=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | awk 'NR == 1 { print $1; exit }' || printf "")
  if [[ -z "${version}" ]]; then
    fail "could not read NVIDIA driver version"
  elif version_ge "${version}" "${min_version}"; then
    ok "NVIDIA driver ${version} >= ${min_version}"
  else
    fail "NVIDIA driver ${version} < ${min_version}"
  fi
}

check_min_version() {
  local name="$1"
  local version="$2"
  local min_version="$3"
  if [[ -z "${version}" ]]; then
    fail "could not determine ${name} version; need >= ${min_version}"
  elif version_ge "${version}" "${min_version}"; then
    ok "${name} ${version} >= ${min_version}"
  else
    fail "${name} ${version} < ${min_version}"
  fi
}

check_disk_gb() {
  local path="$1"
  local min_gb="$2"
  local avail_kb=""
  avail_kb=$(df -Pk "${path}" 2>/dev/null | awk 'NR == 2 { print $4; exit }' || printf "")
  if [[ -z "${avail_kb}" ]]; then
    fail "could not determine free disk for ${path}"
  elif awk -v kb="${avail_kb}" -v min_gb="${min_gb}" 'BEGIN { exit (kb >= min_gb * 1024 * 1024) ? 0 : 1 }'; then
    ok "${path} has at least ${min_gb} GB free"
  else
    fail "${path} has less than ${min_gb} GB free"
  fi
}

microk8s_is_running() {
  local status
  status=$(microk8s status --wait-ready --timeout 5 2>/dev/null | grep -c 'is running' || true)
  [[ "${status}" -ge 2 ]]
}

check_port_listener() {
  local port="$1"
  local ss_output owner_cmd
  if ! command -v ss >/dev/null 2>&1; then
    warn "ss not found; skipping port availability checks"
    return
  fi

  # Try sudo first (microk8s ports need root to see process info),
  # fall back to unprivileged ss.
  ss_output=$(sudo ss -ltnp "sport = :${port}" 2>/dev/null || ss -ltn "sport = :${port}" 2>/dev/null)
  if ! echo "${ss_output}" | grep -q 'LISTEN'; then
    ok "port ${port} is free"
    return
  fi

  # Port is listening — extract owner from ss output (users:(("procname",pid=N,...)))
  owner_cmd=$(echo "${ss_output}" | grep -oP 'users:\(\("\K[^"]+' | head -1 || printf "")

  # microk8s ports expected from a running cluster
  case "${owner_cmd}" in
    kubelite|kubelet|kube-apiserver|kube-proxy)
      ok "port ${port} is in use by microk8s ${owner_cmd} (cluster already running)"
      return
      ;;
    "")
      # ss couldn't show process info (ran without sudo).
      # Fall back: if microk8s is reachable, assume port belongs to it.
      if microk8s_is_running; then
        ok "port ${port} is listening and microk8s is running (cluster already running)"
        return
      fi
      ;;
  esac

  # Port is in use by something unexpected
  fail "port ${port} is already listening (owner=${owner_cmd:-unknown}) — not a recognised microk8s component"
}

check_ports_free() {
  local port
  for port in "$@"; do
    check_port_listener "${port}"
  done
}

finish() {
  if [[ "${PASS}" != "true" ]]; then
    echo "==> cluster-microk8s preflight failed" >&2
    exit 1
  fi
  echo "==> cluster-microk8s preflight passed (${WARNINGS} warning(s))"
}

echo "==> cluster-microk8s preflight"
require_cmds git sudo snap awk df
check_min_version "git" "$(git --version 2>/dev/null | awk '{ print $3; exit }' || printf "")" "${MIN_GIT_VERSION}"
check_min_version "snap" "$(snap version 2>/dev/null | awk '$1 == "snap" { print $2; exit }' || printf "")" "${MIN_SNAP_VERSION}"
check_driver "${MIN_NVIDIA_DRIVER_VERSION}"
check_disk_gb "${HOME}" 20
check_ports_free 16443 10250 10255
finish
