#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  echo "usage: $0 --output <json> --revision <sha> --cohort <id> --platform <linux/amd64|linux/arm64> --openclaw-base <exact-ref> --hermes-base <exact-ref> --dcode-base <exact-ref>" >&2
  exit 2
}

output=""
revision=""
cohort=""
platform=""
openclaw_base=""
hermes_base=""
dcode_base=""
while (($# > 0)); do
  case "$1" in
    --output)
      (($# >= 2)) || usage
      output="$2"
      shift 2
      ;;
    --revision)
      (($# >= 2)) || usage
      revision="$2"
      shift 2
      ;;
    --cohort)
      (($# >= 2)) || usage
      cohort="$2"
      shift 2
      ;;
    --platform)
      (($# >= 2)) || usage
      platform="$2"
      shift 2
      ;;
    --openclaw-base)
      (($# >= 2)) || usage
      openclaw_base="$2"
      shift 2
      ;;
    --hermes-base)
      (($# >= 2)) || usage
      hermes_base="$2"
      shift 2
      ;;
    --dcode-base)
      (($# >= 2)) || usage
      dcode_base="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ "$output" == /* && "$output" != *$'\n'* ]] || usage
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || usage
[[ "$cohort" =~ ^protected-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$ ]] || usage
[[ "$platform" == "linux/amd64" || "$platform" == "linux/arm64" ]] || usage
[[ "$openclaw_base" =~ ^ghcr[.]io/nvidia/nemoclaw/sandbox-base@sha256:[a-f0-9]{64}$ ]] || usage
[[ "$hermes_base" =~ ^ghcr[.]io/nvidia/nemoclaw/hermes-sandbox-base@sha256:[a-f0-9]{64}$ ]] || usage
[[ "$dcode_base" =~ ^ghcr[.]io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base@sha256:[a-f0-9]{64}$ ]] || usage

for command in docker jq sha256sum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "ERROR: protected managed-image build requires $command" >&2
    exit 1
  }
done

work_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/nemoclaw-protected-images.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
contracts="$work_dir/contracts.jsonl"
: >"$contracts"

build_agent() {
  local agent="$1"
  local dockerfile="$2"
  local base_reference="$3"
  local image_repository="localhost:5000/nemoclaw-managed-protected/${agent}"
  local exact_base_raw="$work_dir/${agent}-base-exact.raw"
  local metadata="$work_dir/${agent}-build-metadata.json"
  local exact_image_raw="$work_dir/${agent}-image-exact.raw"

  local base_digest="${base_reference##*@}"
  docker buildx imagetools inspect "$base_reference" --raw >"$exact_base_raw"
  local actual_base
  actual_base="sha256:$(sha256sum "$exact_base_raw" | awk '{print $1}')"
  [[ "$actual_base" == "$base_digest" ]] || {
    echo "ERROR: ${agent} exact base bytes do not match its descriptor" >&2
    exit 1
  }

  scripts/check-production-build-args.sh \
    -f "$dockerfile" \
    --build-arg "BASE_IMAGE=${base_reference}" \
    --build-arg "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1" \
    --build-arg "NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root"

  docker buildx build \
    --file "$dockerfile" \
    --platform "$platform" \
    --push \
    --provenance=false \
    --sbom=false \
    --metadata-file "$metadata" \
    --tag "${image_repository}:${revision}" \
    --label "org.opencontainers.image.source=https://github.com/NVIDIA/NemoClaw" \
    --label "org.opencontainers.image.revision=${revision}" \
    --label "io.nvidia.nemoclaw.agent=${agent}" \
    --label "io.nvidia.nemoclaw.managed-image.contract=1" \
    --label "io.nvidia.nemoclaw.managed-image.platform=${platform}" \
    --label "io.nvidia.nemoclaw.managed-image.startup-profile=1" \
    --label "io.nvidia.nemoclaw.managed-image.capabilities=1" \
    --label "io.nvidia.nemoclaw.managed-image.cohort=${cohort}" \
    --build-arg "BASE_IMAGE=${base_reference}" \
    --build-arg "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1" \
    --build-arg "NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root" \
    .

  local digest
  digest="$(jq -er '."containerimage.digest"' "$metadata")"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || {
    echo "ERROR: ${agent} build did not return an immutable manifest digest" >&2
    exit 1
  }
  local reference="${image_repository}@${digest}"
  docker buildx imagetools inspect "$reference" --raw >"$exact_image_raw"
  local actual_image
  actual_image="sha256:$(sha256sum "$exact_image_raw" | awk '{print $1}')"
  [[ "$actual_image" == "$digest" ]] || {
    echo "ERROR: ${agent} isolated-registry bytes do not match the build digest" >&2
    exit 1
  }
  docker pull --platform "$platform" "$reference"
  local image_json
  image_json="$(docker image inspect "$reference")"
  local image_id
  image_id="$(jq -er 'if length == 1 then .[0].Id else error("not one image") end' <<<"$image_json")"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || {
    echo "ERROR: ${agent} exact manifest did not resolve to one local content ID" >&2
    exit 1
  }
  jq -e \
    --arg agent "$agent" \
    --arg cohort "$cohort" \
    --arg image_id "$image_id" \
    --arg platform "$platform" \
    --arg revision "$revision" '
      length == 1 and
      .[0].Id == $image_id and
      ((.[0].Config.User // "") as $user |
        $user == "" or $user == "root" or $user == "0") and
      .[0].Config.Labels["io.nvidia.nemoclaw.agent"] == $agent and
      .[0].Config.Labels["io.nvidia.nemoclaw.managed-image.contract"] == "1" and
      .[0].Config.Labels["io.nvidia.nemoclaw.managed-image.platform"] == $platform and
      .[0].Config.Labels["io.nvidia.nemoclaw.managed-image.startup-profile"] == "1" and
      .[0].Config.Labels["io.nvidia.nemoclaw.managed-image.capabilities"] == "1" and
      .[0].Config.Labels["io.nvidia.nemoclaw.managed-image.cohort"] == $cohort and
      .[0].Config.Labels["org.opencontainers.image.revision"] == $revision
    ' <<<"$image_json" >/dev/null || {
    echo "ERROR: ${agent} exact protected image contract is invalid" >&2
    exit 1
  }

  jq -nc \
    --arg agent "$agent" \
    --arg reference "$reference" \
    --arg digest "$digest" \
    --arg localContentId "$image_id" \
    --arg baseReference "$base_reference" \
    --arg platform "$platform" \
    '{
      agent: $agent,
      platform: $platform,
      reference: $reference,
      digest: $digest,
      localContentId: $localContentId,
      baseReference: $baseReference
    }' >>"$contracts"
}

build_agent \
  openclaw \
  Dockerfile \
  "$openclaw_base"
build_agent \
  hermes \
  agents/hermes/Dockerfile \
  "$hermes_base"
build_agent \
  langchain-deepagents-code \
  agents/langchain-deepagents-code/Dockerfile \
  "$dcode_base"

mkdir -p "$(dirname "$output")"
jq -se \
  --arg platform "$platform" '
  if (
    length == 3 and
    ([.[].agent] | sort) == ["hermes", "langchain-deepagents-code", "openclaw"] and
    ([.[].platform] | unique) == [$platform] and
    ([.[].reference] | unique | length) == 3
  )
  then .
  else error("protected managed-image set is incomplete")
  end
' "$contracts" >"${output}.tmp"
mv "${output}.tmp" "$output"
