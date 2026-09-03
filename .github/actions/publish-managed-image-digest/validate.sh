#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: managed image publication did not return a valid digest: $DIGEST" >&2
  exit 1
fi
reference="${IMAGE}@${DIGEST}"
raw="$RUNNER_TEMP/managed-image-published-manifest.raw"
docker buildx imagetools inspect "$reference" --raw >"$raw"
if [ "sha256:$(sha256sum "$raw" | awk '{print $1}')" != "$DIGEST" ]; then
  echo "ERROR: published managed image manifest bytes do not match the build digest." >&2
  exit 1
fi
layer_manifest="$raw"
if jq -e '(.manifests | type) == "array"' "$raw" >/dev/null; then
  platform_os="${PLATFORM%%/*}"
  platform_arch="${PLATFORM#*/}"
  platform_digest="$(
    jq -er --arg os "$platform_os" --arg arch "$platform_arch" '
      [
        .manifests[]
        | select(.platform.os == $os and .platform.architecture == $arch)
        | .digest
      ]
      | if length == 1 and (.[0] | test("^sha256:[0-9a-f]{64}$"))
        then .[0]
        else error("expected one exact platform workload descriptor")
        end
    ' "$raw"
  )" || {
    echo "ERROR: published managed image index does not contain one exact $PLATFORM workload." >&2
    exit 1
  }
  layer_manifest="$RUNNER_TEMP/managed-image-platform-manifest.raw"
  docker buildx imagetools inspect "${IMAGE}@${platform_digest}" --raw >"$layer_manifest"
  if [ "sha256:$(sha256sum "$layer_manifest" | awk '{print $1}')" != "$platform_digest" ]; then
    echo "ERROR: published managed image platform manifest bytes do not match its descriptor." >&2
    exit 1
  fi
elif ! jq -e '(.layers | type) == "array"' "$raw" >/dev/null; then
  echo "ERROR: published managed image digest is neither an OCI image manifest nor index." >&2
  exit 1
fi
layer_count="$(
  jq -er '
    if .schemaVersion == 2 and (.layers | type) == "array" and (.layers | length) > 0
    then .layers | length
    else error("expected one nonempty OCI image layer graph")
    end
  ' "$layer_manifest"
)" || {
  echo "ERROR: published managed image manifest does not contain one valid layer graph." >&2
  exit 1
}
if [ "$layer_count" -gt 124 ]; then
  echo "ERROR: published managed image has $layer_count filesystem layers; Docker import requires at most 124 to preserve one layer of headroom." >&2
  exit 1
fi
anonymous_config="$(mktemp -d "$RUNNER_TEMP/anonymous-docker-XXXXXX")"
cleanup_on_failure() { rm -rf -- "$anonymous_config"; }
trap cleanup_on_failure EXIT
chmod 0700 "$anonymous_config"
action_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$action_root/../../.." && pwd -P)"
pull_helper="$repository_root/scripts/checks/pull-public-exact-digest.sh"
if [ ! -f "$pull_helper" ] || [ -L "$pull_helper" ] || [ ! -x "$pull_helper" ]; then
  echo "ERROR: bounded anonymous exact-digest pull helper is unavailable." >&2
  exit 1
fi
"$pull_helper" "$reference" "$PLATFORM" "$anonymous_config"
image_id="$(docker image inspect --format '{{.Id}}' "$reference")"
if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || [ "$(docker image inspect --format '{{.Id}}' "$image_id")" != "$image_id" ]; then
  echo "ERROR: exact managed image did not resolve to one immutable local image ID." >&2
  exit 1
fi
{
  printf 'docker-config=%s\n' "$anonymous_config"
  printf 'local-id=%s\n' "$image_id"
  printf 'reference=%s\n' "$reference"
} >>"$GITHUB_OUTPUT"
trap - EXIT
