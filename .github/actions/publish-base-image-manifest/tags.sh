#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
: "${IMAGE:?}"
: "${REF:?}"
: "${REVISION:?}"
: "${GITHUB_OUTPUT:?}"

if [[ ! "$IMAGE" =~ ^[a-z0-9.-]+/[a-z0-9._/-]+$ ]]; then
  echo "ERROR: base-image repository is invalid." >&2
  exit 1
fi
if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: base-image revision must be an exact commit SHA." >&2
  exit 1
fi

tags=()
publish_release_latest=false
case "$REF" in
  refs/heads/main)
    tags+=("$IMAGE:latest")
    ;;
  refs/heads/*) ;;
  refs/tags/*)
    tag="${REF#refs/tags/}"
    if [[ ! "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
      echo "ERROR: base-image tag is invalid." >&2
      exit 1
    fi
    tags+=("$IMAGE:$tag")
    publish_release_latest=true
    ;;
  *)
    echo "ERROR: base-image publication ref is invalid." >&2
    exit 1
    ;;
esac
tags+=("$IMAGE:${REVISION:0:8}")
if [ "$publish_release_latest" = true ]; then
  tags+=("$IMAGE:latest")
fi

{
  echo "tags<<NEMOCLAW_BASE_IMAGE_TAGS"
  printf '%s\n' "${tags[@]}"
  echo "NEMOCLAW_BASE_IMAGE_TAGS"
} >>"$GITHUB_OUTPUT"
