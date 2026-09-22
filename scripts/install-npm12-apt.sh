#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2025 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

sources=/etc/apt/sources.list.d/debian.sources

if ! apt-get update -o APT::Update::Error-Mode=any; then
  sed -i 's|http://deb.debian.org/|http://cdn-fastly.deb.debian.org/|g' "$sources"
  apt-get update -o APT::Update::Error-Mode=any
fi

apt-get install -y --no-install-recommends ca-certificates=20250419 curl=8.14.1-2+deb13u5
rm -rf /var/lib/apt/lists/*
