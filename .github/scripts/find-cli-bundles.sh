#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Find the CLI bundles CI / Bundle built and checked at the tag, as it
# uploaded them. Only the attempts of CI / Bundle's run for the tag's push
# build bundles that report the tag's version; a manual run at the tag numbers
# its own. The tag's push starts that run alongside this workflow, which waits
# for it to finish.
#
# Writes to GITHUB_OUTPUT the run's ID (run) and URL (source), each platform's
# artifact ID (<platform>), and all four IDs separated by commas (ids).
set -euo pipefail

found=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow rust.yml --commit "$GITHUB_SHA" \
  --branch "$GITHUB_REF_NAME" --json databaseId,event,url \
  --jq '[.[] | select(.event == "push")][0] // empty | "\(.databaseId) \(.url)"')
if [ -z "$found" ]; then
  echo "::error::CI / Bundle hasn't run for the push of $GITHUB_REF_NAME, so no checked bundles that report the tag exist to stage."
  exit 1
fi
read -r run source <<< "$found"
retry="Rerun all of its jobs with 'gh run rerun $run --repo $GITHUB_REPOSITORY', whose new attempt's bundles also report the tag, and rerun this workflow once it passes."
if ! gh run watch "$run" --repo "$GITHUB_REPOSITORY" --exit-status --interval 60 > /dev/null; then
  echo "::error::$source failed, so no checked bundles exist to stage. Rerun its failed jobs, and rerun this workflow once it passes."
  exit 1
fi
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
  echo "::error::$source no longer has the bundle for:$missing. CI keeps a run's bundles for 7 days. $retry"
  exit 1
fi
{
  echo "run=$run"
  echo "source=$source"
  echo "ids=$ids"
} >> "$GITHUB_OUTPUT"
