#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly LOG=/tmp/nemoclaw-brev-v1-startup.log
readonly SENTINEL=/var/run/nemoclaw-brev-v1-ready
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
exec > >(tee -a "${LOG}") 2>&1

as_root() {
  if test "$(id -u)" -eq 0; then
    "$@"
  else
    sudo "$@"
  fi
}

retry() {
  local attempt=1
  local maximum="$1"
  shift
  until "$@"; do
    if test "${attempt}" -ge "${maximum}"; then
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 10
  done
}

wait_for_apt() {
  local waited=0
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
    || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
    if test "${waited}" -ge 180; then
      echo "apt locks remained busy for 180 seconds" >&2
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

login_user="$(id -un)"
if test "${login_user}" = root; then
  login_user="$(getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 { print $1; exit }')"
fi
test -n "${login_user}"

wait_for_apt
retry 3 as_root apt-get update -qq
retry 3 as_root apt-get install -y -qq \
  ca-certificates curl git jq rsync tar docker.io
as_root systemctl enable --now docker
as_root usermod -aG docker "${login_user}"

if ! as_root docker buildx version >/dev/null 2>&1; then
  if apt-cache show docker-buildx-plugin >/dev/null 2>&1; then
    retry 3 as_root apt-get install -y -qq docker-buildx-plugin
  elif apt-cache show docker-buildx >/dev/null 2>&1; then
    retry 3 as_root apt-get install -y -qq docker-buildx
  else
    echo "the Brev package repositories do not provide Docker Buildx" >&2
    exit 1
  fi
fi

as_root docker info >/dev/null
as_root docker buildx version
as_root install -m 0644 /dev/null "${SENTINEL}"
echo "bare Brev host prerequisites are ready"
