#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Install the protoc that the pinned v1 SDK build runs, verified against the SHA-256 that v1's
# versions.json pins, and put it on PATH. The v1 parse consumer passes PATH to Cargo but not
# PROTOC. Update these pins together with V1ALPHA1_CHECKED_REVISION.
# Usage: install.sh <runner.os>-<runner.arch>
PLATFORM="${1:?usage: install.sh <runner.os>-<runner.arch>}"
set -euo pipefail
base="https://github.com/protocolbuffers/protobuf/releases/download/v36.2"
case "$PLATFORM" in
  Linux-X64)
    asset=protoc-36.2-linux-x86_64.zip
    sha256=121f6c7afe1d4d0e3ea6aab9432038599250134cbf4474cb1167d2c7decd4278
    ;;
  Linux-ARM64)
    asset=protoc-36.2-linux-aarch_64.zip
    sha256=8b8f18bd2b30346efbc698dd5a73dd7c805f3ef8380f6dfc95c768f3f1852f6a
    ;;
  macOS-ARM64)
    asset=protoc-36.2-osx-aarch_64.zip
    sha256=9cd98a532c5c5e0c4161314de0225de27e4c8a323917b6ea7b1b714d3ae23466
    ;;
  macOS-X64)
    asset=protoc-36.2-osx-x86_64.zip
    sha256=228cc7add4616cc14ca5e80dee83209d44449a7aee95a914ae748fa374efb078
    ;;
  *)
    echo "v1 pins no protoc for $PLATFORM" >&2
    exit 1
    ;;
esac
archive="$RUNNER_TEMP/$asset"
curl --proto '=https' --tlsv1.2 -fsSL "$base/$asset" -o "$archive"
if command -v sha256sum >/dev/null; then
  echo "$sha256  $archive" | sha256sum -c --quiet -
else
  echo "$sha256  $archive" | shasum -a 256 -c --quiet -
fi
rm -rf "$RUNNER_TEMP/v1-protoc"
unzip -q "$archive" -d "$RUNNER_TEMP/v1-protoc"
echo "$RUNNER_TEMP/v1-protoc/bin" >>"$GITHUB_PATH"
