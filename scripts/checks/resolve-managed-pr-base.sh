#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
write_dcode_resolution() {
  [ "$AGENT" = "langchain-deepagents-code" ] || return 0
  local identity_ref="$1" inspect_ref="$2" expected_revision="$3"
  local digest="${identity_ref##*@}"
  if [ "$identity_ref" != "${BASE_REPOSITORY}@${digest}" ] \
    || [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: DCode base reference is not an exact platform digest." >&2
    exit 1
  fi
  if [ "$identity_ref" = "$inspect_ref" ]; then
    docker pull --platform "$PLATFORM" "$identity_ref" >/dev/null
  fi
  local image_json source_revision image_id os architecture glibc_output glibc metadata key
  image_json="$(docker image inspect "$inspect_ref")"
  source_revision="$(jq -er 'if length == 1 then .[0].Config.Labels["org.opencontainers.image.revision"] else error("not one image") end' <<<"$image_json")"
  image_id="$(jq -er '.[0].Id' <<<"$image_json")"
  os="$(jq -er '.[0].Os' <<<"$image_json")"
  architecture="$(jq -er '.[0].Architecture' <<<"$image_json")"
  if [[ ! "$source_revision" =~ ^[0-9a-f]{40}$ ]] \
    || { [ -n "$expected_revision" ] && [ "$source_revision" != "$expected_revision" ]; } \
    || [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || [ "${os}/${architecture}" != "$PLATFORM" ]; then
    echo "ERROR: DCode base image does not match its immutable receipt." >&2
    exit 1
  fi
  glibc_output="$(docker run --rm --platform "$PLATFORM" --entrypoint getconf "$inspect_ref" GNU_LIBC_VERSION)"
  [[ "$glibc_output" =~ ^glibc\ ([0-9]+[.][0-9]+)$ ]] || {
    echo "ERROR: DCode base image returned malformed glibc metadata." >&2
    exit 1
  }
  glibc="${BASH_REMATCH[1]}"
  [ "$(printf '%s\n' 2.39 "$glibc" | sort -V | head -n 1)" = "2.39" ] || {
    echo "ERROR: DCode base image is below glibc 2.39." >&2
    exit 1
  }
  metadata="$(jq -cn \
    --arg architecture "$architecture" --arg digest "$digest" \
    --arg glibc "$glibc" --arg image "$BASE_REPOSITORY" \
    --arg imageId "$image_id" --arg os "$os" --arg ref "$identity_ref" \
    --arg revision "$source_revision" \
    '{schema:1,key:"",imageName:$image,ref:$ref,digest:$digest,source:"override",sourceRevision:$revision,imageId:$imageId,os:$os,architecture:$architecture,glibcVersion:$glibc,requireOpenshellSandboxAbi:true,minGlibcVersion:"2.39"}')"
  key="$(printf '%s' "$metadata" | sha256sum | awk '{print $1}')"
  metadata="$(jq -c --arg key "$key" '.key = $key' <<<"$metadata")"
  printf 'resolution_key=%s\n' "$key" >>"$GITHUB_OUTPUT"
  printf 'resolution_label=%s\n' "$(printf '%s' "$metadata" | base64 -w0 | tr '+/' '-_' | tr -d '=')" >>"$GITHUB_OUTPUT"
}
if [[ ! "$BASE_SHA" =~ ^[0-9a-f]{40}$ || ! "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: PR base resolution requires exact base and candidate commit SHAs." >&2
  exit 1
fi
if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "$BASE_SHA"
fi
diff_status=0
git diff --quiet "$BASE_SHA" "$CANDIDATE_SHA" -- "$BASE_DOCKERFILE" || diff_status=$?
if [ "$diff_status" -gt 1 ]; then
  echo "ERROR: PR base Dockerfile comparison failed." >&2
  exit "$diff_status"
fi
if [ "$diff_status" -eq 1 ]; then
  echo "::notice::${DISPLAY_NAME} base Dockerfile changed; building the exact PR base locally"
  local_base_archive="$RUNNER_TEMP/pr-base.docker.tar"
  local_base_oci_archive="$RUNNER_TEMP/pr-base.oci.tar"
  local_base_oci="$RUNNER_TEMP/pr-base.oci"
  base_labels=()
  if [ "$AGENT" = "langchain-deepagents-code" ]; then
    base_labels+=(--label "org.opencontainers.image.revision=${CANDIDATE_SHA}")
  fi
  docker buildx build \
    --platform linux/amd64 \
    --provenance=false \
    --sbom=false \
    --file "$BASE_DOCKERFILE" \
    --tag "$LOCAL_BASE_REFERENCE" \
    "${base_labels[@]}" \
    --output "type=docker,dest=${local_base_archive}" \
    --output "type=oci,dest=${local_base_oci_archive}" \
    .
  docker load --input "$local_base_archive"
  mkdir -p "$local_base_oci"
  tar -C "$local_base_oci" -xf "$local_base_oci_archive"
  local_base_oci_digest="$(
    jq -er '
      .manifests
      | if length == 1 then .[0].digest else error("not one image") end
    ' "$local_base_oci/index.json"
  )"
  if [[ ! "$local_base_oci_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: local PR base OCI layout returned an invalid digest." >&2
    exit 1
  fi
  {
    printf 'ref=%s\n' "$LOCAL_BASE_REFERENCE"
    printf 'local=true\n'
    printf 'oci=%s@%s\n' "$local_base_oci" "$local_base_oci_digest"
  } >>"$GITHUB_OUTPUT"
  write_dcode_resolution \
    "${BASE_REPOSITORY}@${local_base_oci_digest}" \
    "$LOCAL_BASE_REFERENCE" \
    "$CANDIDATE_SHA"
  # shellcheck disable=SC2016 # backticks are literal Markdown delimiters.
  printf '### %s PR base\n\nLocally built from `%s` at `%s`.\n' \
    "$DISPLAY_NAME" "$BASE_DOCKERFILE" "$CANDIDATE_SHA" \
    >>"$GITHUB_STEP_SUMMARY"
  exit 0
fi
alias_raw="$RUNNER_TEMP/pr-base-alias.raw"
exact_raw="$RUNNER_TEMP/pr-base-exact.raw"
docker buildx imagetools inspect "$BASE_ALIAS" --raw >"$alias_raw"
if ! digest="$(
  jq -er '
    if (
      .mediaType == "application/vnd.oci.image.index.v1+json" or
      .mediaType == "application/vnd.docker.distribution.manifest.list.v2+json"
    ) then
      [
        .manifests[]
        | select(
            .platform.os == "linux" and
            .platform.architecture == "amd64"
          )
      ]
      | if length == 1 then .[0].digest else error("not one linux/amd64 image") end
    else
      error("base alias is not a platform index")
    end
  ' "$alias_raw"
)"; then
  echo "ERROR: PR base alias does not contain exactly one linux/amd64 image." >&2
  exit 1
fi
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: PR base alias returned an invalid linux/amd64 digest." >&2
  exit 1
fi
reference="${BASE_REPOSITORY}@${digest}"
docker buildx imagetools inspect "$reference" --raw >"$exact_raw"
actual="sha256:$(sha256sum "$exact_raw" | awk '{print $1}')"
if [ "$actual" != "$digest" ]; then
  echo "ERROR: exact PR base bytes do not match the selected descriptor digest." >&2
  exit 1
fi
{
  printf 'ref=%s\n' "$reference"
  printf 'local=false\n'
} >>"$GITHUB_OUTPUT"
write_dcode_resolution "$reference" "$reference" ""
# shellcheck disable=SC2016 # backticks are literal Markdown delimiters.
printf '### %s PR base\n\n`%s`\n' "$DISPLAY_NAME" "$reference" \
  >>"$GITHUB_STEP_SUMMARY"
