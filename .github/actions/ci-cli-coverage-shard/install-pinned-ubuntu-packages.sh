#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "::error title=Missing APT packages::Provide pinned package=version specifications." >&2
  exit 2
fi
for package_spec in "$@"; do
  if [[ ! "$package_spec" =~ ^[A-Za-z0-9][A-Za-z0-9.+-]*(:[A-Za-z0-9][A-Za-z0-9.+-]*)?=[^[:space:]=]+$ ]]; then
    echo "::error title=Unpinned APT package::Expected package=version." >&2
    exit 2
  fi
done

ubuntu_sources=/etc/apt/sources.list.d/ubuntu.sources
if ! sudo test -f "$ubuntu_sources" || ! sudo test -r "$ubuntu_sources"; then
  echo "::error title=Missing Ubuntu APT source::Expected readable $ubuntu_sources." >&2
  exit 1
fi
if [ -z "${RUNNER_TEMP:-}" ] || [ ! -d "$RUNNER_TEMP" ]; then
  echo "::error title=Missing runner temporary directory::RUNNER_TEMP must be a directory." >&2
  exit 1
fi

runner_temp_mode="$(stat -c '%a' "$RUNNER_TEMP")"
apt_lists="$(mktemp -d "$RUNNER_TEMP/nemoclaw-apt-lists.XXXXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT
  sudo rm -rf -- "$apt_lists" || status=1
  sudo chmod "$runner_temp_mode" "$RUNNER_TEMP" || status=1
  exit "$status"
}
trap cleanup EXIT

# APT's _apt user needs traversal into the isolated package-list directory.
sudo chmod o+x "$RUNNER_TEMP"
sudo chmod 0755 "$apt_lists"
sudo install -d -o _apt -g root -m 0700 "$apt_lists/partial"

apt_options=(
  -o "Dir::Etc::sourcelist=$ubuntu_sources"
  -o "Dir::Etc::sourceparts=-"
  -o "Dir::State::lists=$apt_lists"
  -o "Acquire::http::Timeout=30"
  -o "Acquire::https::Timeout=30"
)

run_apt() {
  local operation="$1"
  shift
  local log status
  log="$(mktemp "$RUNNER_TEMP/nemoclaw-apt-${operation}.XXXXXXXX")"
  echo "Installing pinned Pi tools: APT $operation started."
  if timeout -k 10s 300s sudo apt-get "${apt_options[@]}" "$@" >"$log" 2>&1; then
    rm -f -- "$log"
    echo "Installing pinned Pi tools: APT $operation completed."
    return 0
  else
    status=$?
  fi
  if [ "$status" -eq 124 ]; then
    echo "::error title=APT $operation timed out::Ubuntu package $operation exceeded 300 seconds." >&2
  elif [ "$status" -eq 137 ]; then
    echo "::error title=APT $operation was force-killed::Ubuntu package $operation exited with status 137; it may have exceeded 300 seconds and been killed by timeout." >&2
  else
    echo "::error title=APT $operation failed::Ubuntu package $operation exited with status $status." >&2
  fi
  tail -c 8192 "$log" | tail -n 60 >&2
  rm -f -- "$log"
  return "$status"
}

run_apt update update
run_apt install install -y --no-install-recommends "$@"
