#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "::error::At least one pinned package specification is required"
  exit 2
fi

for package_spec in "$@"; do
  if [[ ! "$package_spec" =~ ^[A-Za-z0-9][A-Za-z0-9.+-]*(:[A-Za-z0-9][A-Za-z0-9.+-]*)?=[^[:space:]=]+$ ]]; then
    echo "::error::Package specification must use package=version: $package_spec" >&2
    exit 2
  fi
done

UBUNTU_APT_SOURCES="/etc/apt/sources.list.d/ubuntu.sources"
if [ ! -r "$UBUNTU_APT_SOURCES" ]; then
  echo "::error::Configured APT source list is unavailable: $UBUNTU_APT_SOURCES"
  exit 1
fi

APT_SOURCE_OPTIONS=(
  -o "Dir::Etc::sourcelist=$UBUNTU_APT_SOURCES"
  -o "Dir::Etc::sourceparts=-"
)
# Hosted runners keep RUNNER_TEMP private to the runner user. Grant only
# traversal while APT runs, then restore its exact original mode on every exit.
RUNNER_TEMP_MODE="$(stat -c '%a' "$RUNNER_TEMP")"
restore_runner_temp_mode() {
  sudo chmod "$RUNNER_TEMP_MODE" "$RUNNER_TEMP"
}
trap restore_runner_temp_mode EXIT
sudo chmod o+x "$RUNNER_TEMP"

APT_LISTS_DIR="$RUNNER_TEMP/nemoclaw-apt-lists"
sudo install -d -m 0755 "$APT_LISTS_DIR"
sudo install -d -o _apt -g root -m 0700 "$APT_LISTS_DIR/partial"
APT_SOURCE_OPTIONS+=(
  -o "Dir::State::lists=$APT_LISTS_DIR"
)
sudo apt-get "${APT_SOURCE_OPTIONS[@]}" update -qq
sudo apt-get "${APT_SOURCE_OPTIONS[@]}" install -y --no-install-recommends "$@"
