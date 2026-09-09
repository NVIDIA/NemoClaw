#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "::error::At least one pinned Ubuntu package specification is required"
  exit 2
fi

UBUNTU_APT_SOURCES="/etc/apt/sources.list.d/ubuntu.sources"
if [ ! -r "$UBUNTU_APT_SOURCES" ]; then
  echo "::error::Required Ubuntu APT source is unavailable: $UBUNTU_APT_SOURCES"
  exit 1
fi

APT_SOURCE_OPTIONS=(
  -o "Dir::Etc::sourcelist=$UBUNTU_APT_SOURCES"
  -o "Dir::Etc::sourceparts=-"
)
sudo apt-get "${APT_SOURCE_OPTIONS[@]}" update -qq
sudo apt-get "${APT_SOURCE_OPTIONS[@]}" install -y --no-install-recommends "$@"
