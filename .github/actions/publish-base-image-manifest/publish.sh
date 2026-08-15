#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
: "${AGENT:?}"
: "${DISPLAY_NAME:?}"
: "${IMAGE:?}"
: "${TAGS:?}"
: "${RUNNER_TEMP:?}"
: "${GITHUB_RUN_ID:?}"
: "${GITHUB_RUN_ATTEMPT:?}"
: "${GITHUB_SHA:?}"
: "${GITHUB_OUTPUT:?}"
shopt -s nullglob
digest_files=("$RUNNER_TEMP"/digests/*)
if [ "${#digest_files[@]}" -ne 2 ]; then
  echo "ERROR: expected exactly two platform digests, found ${#digest_files[@]}." >&2
  exit 1
fi

declare -A seen_arches=()
declare -A source_digests=()
sources=()
for digest_file in "${digest_files[@]}"; do
  digest_artifact="$(basename "$digest_file")"
  if [[ ! "$digest_artifact" =~ ^(amd64|arm64)-([0-9a-f]{64})$ ]]; then
    echo "ERROR: invalid platform digest artifact: $digest_artifact" >&2
    exit 1
  fi
  expected_arch="${BASH_REMATCH[1]}"
  digest="${BASH_REMATCH[2]}"
  if [ -n "${seen_arches[$expected_arch]:-}" ]; then
    echo "ERROR: duplicate platform digest for linux/$expected_arch." >&2
    exit 1
  fi
  source="$IMAGE@sha256:$digest"
  source_platform="$(
    scripts/checks/retry-docker-imagetools-inspect.sh "$source" \
      --format '{{.Image.OS}}/{{.Image.Architecture}}'
  )"
  if [ "$source_platform" != "linux/$expected_arch" ]; then
    echo "ERROR: digest for linux/$expected_arch resolves to $source_platform." >&2
    exit 1
  fi
  seen_arches["$expected_arch"]=1
  source_digests["linux/$expected_arch"]="sha256:$digest"
  sources+=("$source")
done
if [ "${seen_arches[amd64]:-0}" -ne 1 ] || [ "${seen_arches[arm64]:-0}" -ne 1 ]; then
  echo "ERROR: expected one validated digest for linux/amd64 and linux/arm64." >&2
  exit 1
fi

mapfile -t tags <<<"$TAGS"
tag_args=()
for tag in "${tags[@]}"; do
  if [ -n "$tag" ]; then
    tag_args+=(--tag "$tag")
  fi
done
if [ "${#tag_args[@]}" -eq 0 ]; then
  echo "ERROR: metadata did not produce any publication tags." >&2
  exit 1
fi

candidate_tag="$IMAGE:base-candidate-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
candidate_metadata="$RUNNER_TEMP/$AGENT-base-candidate-metadata.json"
docker buildx imagetools create \
  --tag "$candidate_tag" \
  --metadata-file "$candidate_metadata" \
  "${sources[@]}"
digest="$(jq -er '.["containerimage.descriptor"].digest' "$candidate_metadata")"
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: expected one staged $DISPLAY_NAME base digest." >&2
  exit 1
fi
reference="$IMAGE@$digest"
actual_platforms="$(
  scripts/checks/retry-docker-imagetools-inspect.sh "$reference" --raw \
    | jq -r '.manifests[] | select(.platform.os == "linux") | .platform.architecture' \
    | sort -u \
    | paste -sd, -
)"
if [ "$actual_platforms" != "amd64,arm64" ]; then
  echo "ERROR: staged manifest has unexpected platforms: $actual_platforms" >&2
  exit 1
fi
platform_digests_json="$(
  scripts/checks/validate-managed-base-index.sh \
    "$reference" \
    "${source_digests['linux/amd64']}" \
    "${source_digests['linux/arm64']}"
)"
declare -A platform_digests=()
for platform in linux/amd64 linux/arm64; do
  platform_digests["$platform"]="$(
    jq -er --arg platform "$platform" '.[$platform]' <<<"$platform_digests_json"
  )"
done

scripts/export-managed-base-image-contract.sh \
  "$AGENT" \
  "$IMAGE" \
  "$digest" \
  "${platform_digests['linux/amd64']}" \
  "${platform_digests['linux/arm64']}" \
  "$GITHUB_SHA" \
  "$GITHUB_RUN_ID" \
  "$GITHUB_RUN_ATTEMPT" \
  "$RUNNER_TEMP/managed-base-contract/contract.json"

publication_metadata="$RUNNER_TEMP/$AGENT-base-publication-metadata.json"
docker buildx imagetools create \
  "${tag_args[@]}" \
  --metadata-file "$publication_metadata" \
  "$reference"
published_digest="$(jq -er '.["containerimage.descriptor"].digest' "$publication_metadata")"
if [ "$published_digest" != "$digest" ]; then
  echo "ERROR: published $DISPLAY_NAME base digest differs from the validated candidate." >&2
  exit 1
fi
printf 'digest=%s\n' "$digest" >>"$GITHUB_OUTPUT"
