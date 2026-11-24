#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Usage: assemble-cli-bundle.sh PLATFORM BUNDLE SIGNED DESTINATION
#
# Unpack BUNDLE, the bundle.tar that CI / Bundle uploaded for PLATFORM, into
# DESTINATION, which then holds dist/PLATFORM as the release ships it.
# SIGNED, when a signing job uploaded it, holds the bundle directory with its
# executables signed. Its files replace the bundle's; artifact transfer drops
# their modes, so the bundle's modes stay. Signing changes the executables'
# bytes, so the manifest is resealed with their new hashes. The release
# archive and the macOS installer hold the bundle this assembles.
set -euo pipefail

platform=$1
tar=$2
signed=$3
destination=$4
mkdir -p "$destination"
tar -xpf "$tar" -C "$destination"
bundle="$destination/dist/$platform"
if [ -d "$signed" ]; then
  cp -R "$signed/." "$bundle/"
fi
nemoclaw-build reseal "$bundle"
