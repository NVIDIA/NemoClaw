#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <index-reference> <linux-amd64-digest> <linux-arm64-digest>" >&2
  exit 2
fi

reference="$1"
expected_amd64="$2"
expected_arm64="$3"

if [[ ! "$reference" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: managed base index reference must be immutable." >&2
  exit 1
fi
for expected in "$expected_amd64" "$expected_arm64"; do
  if [[ ! "$expected" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: managed base platform digest is invalid." >&2
    exit 1
  fi
done

index_json="$(docker buildx imagetools inspect "$reference" --raw)"
if ! jq -e '.manifests | type == "array"' <<<"$index_json" >/dev/null; then
  echo "ERROR: managed base index does not contain a manifest array." >&2
  exit 1
fi

for arch in amd64 arm64; do
  mapfile -t actual_digests < <(
    jq -r --arg arch "$arch" \
      '.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch) | .digest' \
      <<<"$index_json"
  )
  if [ "${#actual_digests[@]}" -ne 1 ]; then
    echo "ERROR: managed base index must contain exactly one linux/$arch descriptor." >&2
    exit 1
  fi
  case "$arch" in
    amd64) expected_digest="$expected_amd64" ;;
    arm64) expected_digest="$expected_arm64" ;;
  esac
  if [ "${actual_digests[0]}" != "$expected_digest" ]; then
    echo "ERROR: managed base index linux/$arch descriptor does not match this run's platform digest." >&2
    exit 1
  fi
done
