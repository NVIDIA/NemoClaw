#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

case "${REPOSITORY}:${REF}:${EVENT_NAME}:${CHECKOUT_SHA:+controller}" in
  NVIDIA/NemoClaw:refs/heads/main:push: | NVIDIA/NemoClaw:refs/heads/main:workflow_dispatch:)
    expected_sha="$WORKFLOW_SHA"
    allow_non_head=0
    select_nearest_successful=0
    ;;
  NVIDIA/NemoClaw:refs/heads/main:workflow_dispatch:controller)
    [[ "$BASE_SHA" =~ ^[a-f0-9]{40}$ ]] || {
      echo "::error::manual PR publication selection requires an exact base SHA" >&2
      exit 1
    }
    expected_sha="$BASE_SHA"
    allow_non_head=1
    select_nearest_successful=1
    ;;
  *)
    echo "::error::base-image publication mode is not trusted" >&2
    exit 1
    ;;
esac
{
  printf 'allow_non_head=%s\n' "$allow_non_head"
  printf 'expected_sha=%s\n' "$expected_sha"
  printf 'select_nearest_successful=%s\n' "$select_nearest_successful"
} >>"$GITHUB_OUTPUT"
