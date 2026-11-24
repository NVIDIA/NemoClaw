#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Usage: pack-cli-bundles.sh CI SIGNED ARCHIVES
#
# Pack each platform's CLI bundle into ARCHIVES/nemoclaw-<tag>-<platform>.tar.gz
# and list their checksums, and those of any other nemoclaw-* file already in
# ARCHIVES, such as the macOS installer, in ARCHIVES/SHA256SUMS.
#
# CI holds the bundles CI / Bundle uploaded, as CI/bundle-<platform>-*/bundle.tar.
# SIGNED/<platform>, when a signing job uploaded it, holds that platform's bundle
# directory with its executables signed; assemble-cli-bundle.sh puts them in
# the bundle.
set -euo pipefail

ci=$1
signed=$2
archives=$3
work=$(mktemp -d)
mkdir -p "$archives"
for platform in linux_arm64 linux_amd64 darwin_arm64 windows_amd64; do
  bundles=("$ci"/bundle-"$platform"-*/bundle.tar)
  if [ "${#bundles[@]}" -ne 1 ] || [ ! -f "${bundles[0]}" ]; then
    echo "::error::Expected one $platform bundle in $ci"
    exit 1
  fi
  mkdir "$work/$platform"
  bash "$(dirname "$0")/assemble-cli-bundle.sh" "$platform" "${bundles[0]}" "$signed/$platform" "$work/$platform"
  tar -cf - -C "$work/$platform" "dist/$platform" | gzip -n > "$archives/nemoclaw-$GITHUB_REF_NAME-$platform.tar.gz"
done
(cd "$archives" && sha256sum -- nemoclaw-* > SHA256SUMS)
