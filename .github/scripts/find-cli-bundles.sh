#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Find the CLI bundles CI / Bundle built and checked at GITHUB_SHA, as it
# uploaded them. Push and manual runs build the commit itself; a pull request
# run builds a merge commit, so its bundles are another commit's.
#
# Writes to GITHUB_OUTPUT the run's ID (run) and URL (source), each platform's
# artifact ID (<platform>), and all four IDs separated by commas (ids).
set -euo pipefail

retry="Run CI / Bundle at the tag with 'gh workflow run rust.yml --ref $GITHUB_REF_NAME', and rerun this workflow once it passes."
found=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow rust.yml --commit "$GITHUB_SHA" \
  --json databaseId,event,conclusion,url --jq '[.[] | select(.conclusion == "success"
    and (.event == "push" or .event == "workflow_dispatch"))][0] // empty | "\(.databaseId) \(.url)"')
if [ -z "$found" ]; then
  echo "::error::CI / Bundle hasn't passed at $GITHUB_SHA, so no checked bundles exist to stage. $retry"
  exit 1
fi
read -r run source <<< "$found"
artifacts=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$run/artifacts?per_page=100" \
  --jq '.artifacts[] | select(.expired | not) | "\(.name) \(.id)"')
ids=
missing=
for platform in linux_arm64 linux_amd64 darwin_arm64 windows_amd64; do
  # A rerun bundle job uploads its own attempt's bundle, named after the
  # attempt; take the latest.
  prefix="bundle-$platform-$GITHUB_SHA-"
  id=$(printf '%s\n' "$artifacts" | awk -v prefix="$prefix" '
    index($1, prefix) == 1 && substr($1, length(prefix) + 1) ~ /^[0-9]+$/ {
      print substr($1, length(prefix) + 1), $2
    }' | sort -n | tail -n 1 | cut -d ' ' -f 2)
  if [ -z "$id" ]; then
    missing="$missing $platform"
    continue
  fi
  echo "$platform=$id" >> "$GITHUB_OUTPUT"
  ids="$ids${ids:+,}$id"
done
if [ -n "$missing" ]; then
  echo "::error::$source no longer has the bundle for:$missing. CI keeps a v1 commit's bundles for 7 days. $retry"
  exit 1
fi
{
  echo "run=$run"
  echo "source=$source"
  echo "ids=$ids"
} >> "$GITHUB_OUTPUT"
