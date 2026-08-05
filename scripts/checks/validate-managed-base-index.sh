#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <index-reference> <linux-amd64-source-digest> <linux-arm64-source-digest>" >&2
  exit 2
fi

reference="$1"
source_amd64="$2"
source_arm64="$3"

if [[ ! "$reference" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: managed base index reference must be immutable." >&2
  exit 1
fi
for source_digest in "$source_amd64" "$source_arm64"; do
  if [[ ! "$source_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: managed base platform source digest is invalid." >&2
    exit 1
  fi
done

image="${reference%@*}"
declare -A platform_digests=()
expected_descriptors='[]'
for arch in amd64 arm64; do
  case "$arch" in
    amd64) source_digest="$source_amd64" ;;
    arm64) source_digest="$source_arm64" ;;
  esac
  source_reference="$image@$source_digest"
  source_json="$(docker buildx imagetools inspect "$source_reference" --raw)"

  mapfile -t workload_digests < <(
    jq -r --arg arch "$arch" \
      '.manifests[]? | select(.platform.os == "linux" and .platform.architecture == $arch) | .digest' \
      <<<"$source_json"
  )
  if [ "${#workload_digests[@]}" -ne 1 ]; then
    echo "ERROR: managed base source index must contain exactly one linux/$arch descriptor." >&2
    exit 1
  fi
  workload_digest="${workload_digests[0]}"
  if [[ ! "$workload_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: managed base source index linux/$arch descriptor digest is invalid." >&2
    exit 1
  fi
  if ! jq -e \
    --arg arch "$arch" \
    --arg workload_digest "$workload_digest" \
    '
      .schemaVersion == 2
      and .mediaType == "application/vnd.oci.image.index.v1+json"
      and (.manifests | type == "array" and length == 2)
      and ([
        .manifests[]
        | select(
            .platform.os == "linux"
            and .mediaType == "application/vnd.oci.image.manifest.v1+json"
            and (.digest | test("^sha256:[0-9a-f]{64}$"))
            and (.size | type == "number" and . > 0 and floor == .)
          )
      ] | length) == 1
      and ([
        .manifests[]
        | select(
            .platform.os == "unknown"
            and .platform.architecture == "unknown"
            and .mediaType == "application/vnd.oci.image.manifest.v1+json"
            and (.digest | test("^sha256:[0-9a-f]{64}$"))
            and (.size | type == "number" and . > 0 and floor == .)
            and .annotations["vnd.docker.reference.type"] == "attestation-manifest"
            and .annotations["vnd.docker.reference.digest"] == $workload_digest
          )
      ] | length) == 1
      and ([
        .manifests[]
        | select(.platform.os == "linux" and .platform.architecture == $arch)
      ] | length) == 1
    ' <<<"$source_json" >/dev/null; then
    echo "ERROR: managed base source index for linux/$arch is not one workload plus its provenance manifest." >&2
    exit 1
  fi

  platform_digests["$arch"]="$workload_digest"
  source_descriptors="$(jq -c '.manifests' <<<"$source_json")"
  expected_descriptors="$(
    jq -cn \
      --argjson expected "$expected_descriptors" \
      --argjson source "$source_descriptors" \
      '$expected + $source'
  )"
done

index_json="$(docker buildx imagetools inspect "$reference" --raw)"
if ! jq -e \
  '
    .schemaVersion == 2
    and .mediaType == "application/vnd.oci.image.index.v1+json"
    and (.manifests | type == "array")
  ' <<<"$index_json" >/dev/null; then
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
  expected_digest="${platform_digests[$arch]}"
  if [ "${actual_digests[0]}" != "$expected_digest" ]; then
    echo "ERROR: managed base index linux/$arch descriptor does not match this run's resolved workload descriptor." >&2
    exit 1
  fi
done

actual_descriptors="$(jq -cS '.manifests | sort_by(.digest)' <<<"$index_json")"
expected_descriptors="$(jq -cS 'sort_by(.digest)' <<<"$expected_descriptors")"
if [ "$actual_descriptors" != "$expected_descriptors" ]; then
  echo "ERROR: managed base index descriptors do not match this run's platform source indexes." >&2
  exit 1
fi

jq -cn \
  --arg amd64 "${platform_digests[amd64]}" \
  --arg arm64 "${platform_digests[arm64]}" \
  '{"linux/amd64": $amd64, "linux/arm64": $arm64}'
