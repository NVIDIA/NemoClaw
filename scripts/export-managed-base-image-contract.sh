#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -ne 9 ]; then
  echo "Usage: $0 AGENT IMAGE DIGEST AMD64_DIGEST ARM64_DIGEST SOURCE_REVISION RUN_ID RUN_ATTEMPT OUTPUT" >&2
  exit 2
fi

readonly agent="$1"
readonly image="$2"
readonly digest="$3"
readonly amd64_digest="$4"
readonly arm64_digest="$5"
readonly source_revision="$6"
readonly run_id="$7"
readonly run_attempt="$8"
readonly output="$9"
readonly reference="${image}@${digest}"

mkdir -p "$(dirname -- "$output")"
jq -n \
  --arg agent "$agent" \
  --arg amd64Digest "$amd64_digest" \
  --arg amd64Reference "$image@$amd64_digest" \
  --arg arm64Digest "$arm64_digest" \
  --arg arm64Reference "$image@$arm64_digest" \
  --arg digest "$digest" \
  --arg image "$image" \
  --arg reference "$reference" \
  --arg revision "$source_revision" \
  --argjson runAttempt "$run_attempt" \
  --argjson runId "$run_id" \
  '{
    contractVersion: 1,
    agent: $agent,
    image: $image,
    digest: $digest,
    reference: $reference,
    platforms: ["linux/amd64", "linux/arm64"],
    platformDigests: {
      "linux/amd64": $amd64Digest,
      "linux/arm64": $arm64Digest
    },
    platformReferences: {
      "linux/amd64": $amd64Reference,
      "linux/arm64": $arm64Reference
    },
    sourceRevision: $revision,
    run: {
      id: $runId,
      attempt: $runAttempt
    }
  }' >"$output"

jq -e \
  --arg agent "$agent" \
  '.contractVersion == 1
   and .agent == $agent
   and (.sourceRevision | test("^[0-9a-f]{40}$"))
   and (.digest | test("^sha256:[0-9a-f]{64}$"))
   and .reference == (.image + "@" + .digest)
   and .platforms == ["linux/amd64", "linux/arm64"]
   and (.platformDigests | keys | sort) == .platforms
   and (.platformReferences | keys | sort) == .platforms
   and ([
     .platforms[] as $platform
     | (
         (.platformDigests[$platform] | test("^sha256:[0-9a-f]{64}$"))
         and .platformReferences[$platform] ==
           (.image + "@" + .platformDigests[$platform])
       )
   ] | all)' \
  "$output" >/dev/null
