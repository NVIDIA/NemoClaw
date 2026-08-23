#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  echo "usage: $0 --output <json> --revision <sha> --cohort <id> --platform <linux/amd64|linux/arm64> --openclaw-base <exact-ref> --hermes-base <exact-ref> --dcode-base <exact-ref> [--source-root <absolute-dir>] [--cache-to <absolute-dir>] [--cache-from <absolute-dir>]" >&2
  exit 2
}

output=""
revision=""
cohort=""
platform=""
openclaw_base=""
hermes_base=""
dcode_base=""
source_root="$PWD"
cache_to=""
cache_from=""
while (($# > 0)); do
  case "$1" in
    --cache-to)
      (($# >= 2)) || usage
      cache_to="$2"
      shift 2
      ;;
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
    --cache-from)
      (($# >= 2)) || usage
      cache_from="$2"
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
    --source-root)
      (($# >= 2)) || usage
      source_root="$2"
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
case "$platform" in
  linux/amd64) npm_target_cpu="x64" ;;
  linux/arm64) npm_target_cpu="arm64" ;;
esac
npm_target_os="linux"
npm_target_libc="glibc"
[[ "$openclaw_base" =~ ^ghcr[.]io/nvidia/nemoclaw/sandbox-base@sha256:[a-f0-9]{64}$ ]] || usage
[[ "$hermes_base" =~ ^ghcr[.]io/nvidia/nemoclaw/hermes-sandbox-base@sha256:[a-f0-9]{64}$ ]] || usage
[[ "$dcode_base" =~ ^ghcr[.]io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base@sha256:[a-f0-9]{64}$ ]] || usage
[[ "$source_root" == /* && "$source_root" != *$'\n'* && -d "$source_root" && ! -L "$source_root" ]] || usage
source_root="$(cd -- "$source_root" && pwd -P)"
seed_helper="$source_root/scripts/checks/materialize-locked-npm-cache-seed.mts"
source_lockfile="$source_root/nemoclaw/package-lock.json"
source_seed_dir="$source_root/tools/mcp-tool-discovery-runtime/npm-cache-seed"
source_mcp_lockfile="$source_root/tools/mcp-tool-discovery-runtime/package-lock.json"
source_mcp_seed_dir="$source_root/tools/mcp-tool-discovery-runtime/mcp-runtime-npm-cache-seed"
source_messaging_lockfile="$source_root/agents/openclaw/managed-image-messaging-runtime/package-lock.json"
source_messaging_seed_dir="$source_root/agents/openclaw/managed-image-messaging-runtime/npm-cache-seed"
[[ -f "$seed_helper" && ! -L "$seed_helper" ]] || usage
[[ -f "$source_lockfile" && ! -L "$source_lockfile" ]] || usage
[[ -d "$source_seed_dir" && ! -L "$source_seed_dir" ]] || usage
[[ -z "$(find "$source_seed_dir" -type l -print -quit)" ]] || usage
[[ -f "$source_mcp_lockfile" && ! -L "$source_mcp_lockfile" ]] || usage
[[ -d "$source_mcp_seed_dir" && ! -L "$source_mcp_seed_dir" ]] || usage
[[ -z "$(find "$source_mcp_seed_dir" -type l -print -quit)" ]] || usage
[[ -f "$source_messaging_lockfile" && ! -L "$source_messaging_lockfile" ]] || usage
[[ -d "$source_messaging_seed_dir" && ! -L "$source_messaging_seed_dir" ]] || usage
[[ -z "$(find "$source_messaging_seed_dir" -type l -print -quit)" ]] || usage
if [[ -n "$cache_to" ]]; then
  [[ "$cache_to" == /* && "$cache_to" != *$'\n'* && ! -L "$cache_to" ]] || usage
  mkdir -p -- "$cache_to"
  [[ -d "$cache_to" && ! -L "$cache_to" ]] || usage
  cache_to="$(cd -- "$cache_to" && pwd -P)"
  [[ -z "$(find "$cache_to" -mindepth 1 -print -quit)" ]] || {
    echo "ERROR: protected managed-image cache destination must be empty" >&2
    exit 1
  }
fi
if [[ -n "$cache_from" ]]; then
  [[ "$cache_from" == /* && "$cache_from" != *$'\n'* && -d "$cache_from" && ! -L "$cache_from" ]] || usage
  cache_from="$(cd -- "$cache_from" && pwd -P)"
  [[ -z "$(find "$cache_from" -type l -print -quit)" ]] || {
    echo "ERROR: protected managed-image imported cache contains a symlink" >&2
    exit 1
  }
  for agent in openclaw hermes langchain-deepagents-code; do
    cache_source="$cache_from/$agent"
    [[ -d "$cache_source/blobs/sha256" && -f "$cache_source/index.json" ]] || {
      echo "ERROR: protected managed-image imported cache is incomplete for ${agent}" >&2
      exit 1
    }
  done
  [[ -d "$cache_from/npm-cache-seed" && ! -L "$cache_from/npm-cache-seed" ]] || {
    echo "ERROR: protected managed-image imported cache has no locked npm cache seed" >&2
    exit 1
  }
  [[ -f "$cache_from/npm-cache-seed/manifest.json" && ! -L "$cache_from/npm-cache-seed/manifest.json" ]] || {
    echo "ERROR: protected managed-image imported cache has no locked npm cache seed manifest" >&2
    exit 1
  }
  [[ -d "$cache_from/mcp-runtime-npm-cache-seed" && ! -L "$cache_from/mcp-runtime-npm-cache-seed" ]] || {
    echo "ERROR: protected managed-image imported cache has no locked MCP runtime npm cache seed" >&2
    exit 1
  }
  [[ -f "$cache_from/mcp-runtime-npm-cache-seed/manifest.json" && ! -L "$cache_from/mcp-runtime-npm-cache-seed/manifest.json" ]] || {
    echo "ERROR: protected managed-image imported cache has no locked MCP runtime npm cache seed manifest" >&2
    exit 1
  }
  [[ -d "$cache_from/messaging-npm-cache-seed" && ! -L "$cache_from/messaging-npm-cache-seed" ]] || {
    echo "ERROR: protected managed-image imported cache has no locked messaging npm cache seed" >&2
    exit 1
  }
  [[ -f "$cache_from/messaging-npm-cache-seed/manifest.json" && ! -L "$cache_from/messaging-npm-cache-seed/manifest.json" ]] || {
    echo "ERROR: protected managed-image imported cache has no locked messaging npm cache seed manifest" >&2
    exit 1
  }
fi

for command in curl docker jq node sha256sum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "ERROR: protected managed-image build requires $command" >&2
    exit 1
  }
done

work_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/nemoclaw-protected-images.XXXXXX")"
seed_overlay_active=0
seed_backup="$work_dir/npm-cache-seed-original"
mcp_seed_overlay_active=0
mcp_seed_backup="$work_dir/mcp-runtime-npm-cache-seed-original"
messaging_seed_overlay_active=0
messaging_seed_backup="$work_dir/messaging-npm-cache-seed-original"
restore_worktree() {
  if [[ "$seed_overlay_active" == 1 ]]; then
    rm -rf -- "$source_seed_dir"
    cp -pR -- "$seed_backup" "$source_seed_dir"
  fi
  if [[ "$mcp_seed_overlay_active" == 1 ]]; then
    rm -rf -- "$source_mcp_seed_dir"
    cp -pR -- "$mcp_seed_backup" "$source_mcp_seed_dir"
  fi
  if [[ "$messaging_seed_overlay_active" == 1 ]]; then
    rm -rf -- "$source_messaging_seed_dir"
    cp -pR -- "$messaging_seed_backup" "$source_messaging_seed_dir"
  fi
  rm -rf -- "$work_dir"
}
trap restore_worktree EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -n "$cache_from" ]]; then
  imported_seed="$work_dir/npm-cache-seed-import"
  node --experimental-strip-types --no-warnings "$seed_helper" copy \
    --lockfile "$source_lockfile" \
    --seed "$cache_from/npm-cache-seed" \
    --output "$imported_seed" \
    --os "$npm_target_os" \
    --cpu "$npm_target_cpu" \
    --libc "$npm_target_libc"
  cp -pR -- "$source_seed_dir" "$seed_backup"
  seed_overlay_active=1
  rm -rf -- "$source_seed_dir"
  cp -pR -- "$imported_seed" "$source_seed_dir"

  imported_mcp_seed="$work_dir/mcp-runtime-npm-cache-seed-import"
  node --experimental-strip-types --no-warnings "$seed_helper" copy \
    --lockfile "$source_mcp_lockfile" \
    --seed "$cache_from/mcp-runtime-npm-cache-seed" \
    --output "$imported_mcp_seed" \
    --os "$npm_target_os" \
    --cpu "$npm_target_cpu" \
    --libc "$npm_target_libc"
  cp -pR -- "$source_mcp_seed_dir" "$mcp_seed_backup"
  mcp_seed_overlay_active=1
  rm -rf -- "$source_mcp_seed_dir"
  cp -pR -- "$imported_mcp_seed" "$source_mcp_seed_dir"

  imported_messaging_seed="$work_dir/messaging-npm-cache-seed-import"
  node --experimental-strip-types --no-warnings "$seed_helper" copy \
    --lockfile "$source_messaging_lockfile" \
    --seed "$cache_from/messaging-npm-cache-seed" \
    --output "$imported_messaging_seed" \
    --os "$npm_target_os" \
    --cpu "$npm_target_cpu" \
    --libc "$npm_target_libc"
  cp -pR -- "$source_messaging_seed_dir" "$messaging_seed_backup"
  messaging_seed_overlay_active=1
  rm -rf -- "$source_messaging_seed_dir"
  cp -pR -- "$imported_messaging_seed" "$source_messaging_seed_dir"
fi

contracts="$work_dir/contracts.jsonl"
: >"$contracts"

confirm_build_retry_state() {
  local agent="$1"
  local image_repository="$2"
  local manifest_status
  local registry_host="${image_repository%%/*}"
  local repository_path="${image_repository#*/}"
  local manifest_url="http://${registry_host}/v2/${repository_path}/manifests/${revision}"

  if ! manifest_status="$(curl \
    --silent \
    --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --head \
    --connect-timeout 5 \
    --max-time 15 \
    --header 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "$manifest_url")"; then
    echo "::error::Protected managed-image build retry state check failed agent=${agent} transport=curl" >&2
    return 1
  fi

  case "$manifest_status" in
    200)
      echo "::error::Protected managed-image build retry state agent=${agent} revision-tag=present" >&2
      return 1
      ;;
    404)
      echo "::notice::Protected managed-image build retry state agent=${agent} revision-tag=absent"
      return 0
      ;;
    *)
      echo "::error::Protected managed-image build retry state check failed agent=${agent} registry-http=${manifest_status}" >&2
      return 1
      ;;
  esac
}

run_build_with_retry() {
  local agent="$1"
  local image_repository="$2"
  shift 2
  local -a build_command=("$@")
  local attempt_log="$work_dir/${agent}-build-attempt.log"
  local max_attempts=2
  local attempt
  local build_status
  local failure_class
  local last_line
  local log_status
  local outcome
  local -a pipeline_status=()

  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    : >"$attempt_log"
    if "${build_command[@]}" 2>&1 | tee "$attempt_log"; then
      if [[ "$attempt" == 1 ]]; then
        outcome="passed-first-attempt"
      else
        outcome="passed-after-retry"
      fi
      echo "::notice::Protected managed-image build outcome=${outcome} agent=${agent} attempt=${attempt}/${max_attempts}"
      return 0
    else
      pipeline_status=("${PIPESTATUS[@]}")
      build_status="${pipeline_status[0]}"
      log_status="${pipeline_status[1]}"
    fi

    if [[ "$log_status" != 0 ]]; then
      echo "::error::Protected managed-image build outcome=failed-no-retry agent=${agent} attempt=${attempt}/${max_attempts} evidence-exit=${log_status}" >&2
      return "$log_status"
    fi

    last_line="$(awk 'NF { line=$0 } END { sub(/\r$/, "", line); print line }' "$attempt_log")"
    if [[ "$last_line" =~ ^ERROR:\ failed\ to\ build:\ failed\ to\ solve:\ stream\ error:\ stream\ ID\ [0-9]+\;\ INTERNAL_ERROR\;\ received\ from\ peer$ ]]; then
      failure_class="buildkit-http2-internal-error"
    elif grep -Eq '^(#[0-9]+ )?[0-9]+([.][0-9]+)? ERROR: curl failed: curl: \(6\) Could not resolve host: registry[.]npmjs[.]org$' "$attempt_log"; then
      failure_class="npm-registry-dns-resolution"
    else
      echo "::error::Protected managed-image build outcome=failed-no-retry agent=${agent} attempt=${attempt}/${max_attempts} docker-exit=${build_status}" >&2
      return "$build_status"
    fi

    if [[ "$attempt" == "$max_attempts" ]]; then
      echo "::error::Protected managed-image build outcome=exhausted agent=${agent} attempt=${attempt}/${max_attempts} failure=${failure_class} docker-exit=${build_status}" >&2
      return "$build_status"
    fi

    if ! confirm_build_retry_state "$agent" "$image_repository"; then
      echo "::error::Protected managed-image build outcome=failed-no-retry agent=${agent} attempt=${attempt}/${max_attempts} failure=state-check" >&2
      return "$build_status"
    fi

    echo "::warning::Protected managed-image build outcome=transient-external agent=${agent} attempt=${attempt}/${max_attempts} retry-in=2s failure=${failure_class}" >&2
    sleep 2
  done
}

build_agent() {
  local agent="$1"
  local dockerfile="$2"
  local base_reference="$3"
  local dockerfile_path="$source_root/$dockerfile"
  local image_repository="localhost:5000/nemoclaw-managed-protected/${agent}"
  local exact_base_raw="$work_dir/${agent}-base-exact.raw"
  local metadata="$work_dir/${agent}-build-metadata.json"
  local exact_image_raw="$work_dir/${agent}-image-exact.raw"
  local -a cache_args=()

  if [[ -n "$cache_to" ]]; then
    local cache_destination="$cache_to/$agent"
    cache_args+=(--cache-to "type=local,dest=${cache_destination},mode=max")
  fi
  if [[ -n "$cache_from" ]]; then
    local cache_source="$cache_from/$agent"
    cache_args+=(--network none)
    if [[ "$agent" == "openclaw" ]]; then
      # The exported cache is produced before the locked npm seeds are overlaid.
      # Do not import its layer graph: some BuildKit versions still reuse
      # empty-seed COPY results when --no-cache and --cache-from are combined.
      cache_args+=(--no-cache)
    else
      cache_args+=(--cache-from "type=local,src=${cache_source}")
    fi
  fi

  local base_digest="${base_reference##*@}"
  docker buildx imagetools inspect "$base_reference" --raw >"$exact_base_raw"
  local actual_base
  actual_base="sha256:$(sha256sum "$exact_base_raw" | awk '{print $1}')"
  [[ "$actual_base" == "$base_digest" ]] || {
    echo "ERROR: ${agent} exact base bytes do not match its descriptor" >&2
    exit 1
  }

  scripts/check-production-build-args.sh \
    -f "$dockerfile_path" \
    --build-arg "BASE_IMAGE=${base_reference}" \
    --build-arg "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1" \
    --build-arg "NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root"

  local -a build_command=(docker buildx build
    --file "$dockerfile_path"
    --platform "$platform"
    --push
    --provenance=false
    --sbom=false
    --metadata-file "$metadata"
    ${cache_args[@]+"${cache_args[@]}"}
    --tag "${image_repository}:${revision}"
    --label "org.opencontainers.image.source=https://github.com/NVIDIA/NemoClaw"
    --label "org.opencontainers.image.revision=${revision}"
    --label "io.nvidia.nemoclaw.agent=${agent}"
    --label "io.nvidia.nemoclaw.managed-image.contract=1"
    --label "io.nvidia.nemoclaw.managed-image.platform=${platform}"
    --label "io.nvidia.nemoclaw.managed-image.startup-profile=1"
    --label "io.nvidia.nemoclaw.managed-image.capabilities=1"
    --label "io.nvidia.nemoclaw.managed-image.cohort=${cohort}"
    --build-arg "BASE_IMAGE=${base_reference}"
    --build-arg "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1"
    --build-arg "NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root"
    "$source_root")
  run_build_with_retry "$agent" "$image_repository" "${build_command[@]}"

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

if [[ -n "$cache_to" ]]; then
  node --experimental-strip-types --no-warnings "$seed_helper" export \
    --lockfile "$source_lockfile" \
    --output "$cache_to/npm-cache-seed" \
    --os "$npm_target_os" \
    --cpu "$npm_target_cpu" \
    --libc "$npm_target_libc"
  node --experimental-strip-types --no-warnings "$seed_helper" export \
    --lockfile "$source_mcp_lockfile" \
    --output "$cache_to/mcp-runtime-npm-cache-seed" \
    --os "$npm_target_os" \
    --cpu "$npm_target_cpu" \
    --libc "$npm_target_libc"
  node --experimental-strip-types --no-warnings "$seed_helper" export \
    --lockfile "$source_messaging_lockfile" \
    --output "$cache_to/messaging-npm-cache-seed" \
    --os "$npm_target_os" \
    --cpu "$npm_target_cpu" \
    --libc "$npm_target_libc"
fi

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
