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
anonymous_config="$(mktemp -d "$RUNNER_TEMP/anonymous-docker-XXXXXX")"
cleanup_on_failure() { rm -rf -- "$anonymous_config"; }
trap cleanup_on_failure EXIT
chmod 0700 "$anonymous_config"
if ! env -u DOCKER_AUTH_CONFIG DOCKER_CONFIG="$anonymous_config" docker pull --platform "$PLATFORM" "$reference"; then
  echo "::error::Anonymous pull of ${reference} failed. Confirm that the GHCR package is public and that the exact digest is available to anonymous clients. Then rerun this workflow."
  exit 1
fi
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
