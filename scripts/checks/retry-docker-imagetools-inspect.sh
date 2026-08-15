#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <image-reference> [imagetools-inspect-arguments...]" >&2
  exit 2
fi

attempts=5
retry_seconds=5

error_log="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-imagetools-inspect.XXXXXX")"
trap 'rm -f "$error_log"' EXIT

status=1
for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  : >"$error_log"
  if output="$(docker buildx imagetools inspect "$@" 2>"$error_log")"; then
    cat "$error_log" >&2
    printf '%s\n' "$output"
    exit 0
  else
    status="$?"
  fi
  cat "$error_log" >&2
  if [ "$attempt" -lt "$attempts" ]; then
    echo "WARN: image registry read failed on attempt $attempt/$attempts; retrying in ${retry_seconds}s." >&2
    sleep "$retry_seconds"
  fi
done

echo "ERROR: image registry read failed after $attempts attempts." >&2
exit "$status"
