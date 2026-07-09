#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root
readonly image_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
readonly source_base_image="nemoclaw-dcode-profile-source-base:${image_suffix}"
readonly stripped_image="nemoclaw-dcode-profile-missing-dependencies:${image_suffix}"
readonly failed_image="nemoclaw-dcode-profile-import-gate-failure:${image_suffix}"
build_log="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-dcode-profile-import-gate.XXXXXX.log")"
readonly build_log

cleanup() {
  docker image rm --force \
    "${failed_image}" \
    "${stripped_image}" \
    "${source_base_image}" >/dev/null 2>&1 || true
  rm -f "${build_log}"
}
trap cleanup EXIT

cd "${repo_root}"

# --progress=plain is required to prove the exact import failure marker. The
# primary security boundary is the exact ARG-name allowlist below, which covers
# agents/langchain-deepagents-code/Dockerfile.base,
# test/Dockerfile.dcode-profile-missing-dependencies, and
# agents/langchain-deepagents-code/Dockerfile. Those three reviewed Dockerfiles
# contain no secret-bearing ARGs. Only BASE_IMAGE is passed via --build-arg,
# always as a public, non-secret image reference.
for dockerfile in \
  agents/langchain-deepagents-code/Dockerfile.base \
  test/Dockerfile.dcode-profile-missing-dependencies \
  agents/langchain-deepagents-code/Dockerfile; do
  while IFS= read -r arg_name; do
    case "${arg_name}" in
      BASE_IMAGE | NEMOCLAW_MODEL | NEMOCLAW_PROVIDER_KEY | NEMOCLAW_UPSTREAM_PROVIDER | NEMOCLAW_INFERENCE_BASE_URL | NEMOCLAW_INFERENCE_API | NEMOCLAW_TOOL_DISCLOSURE | NEMOCLAW_DCODE_AUTO_APPROVAL | NEMOCLAW_BUILD_ID | NEMOCLAW_DARWIN_VM_COMPAT | NEMOCLAW_PROXY_HOST | NEMOCLAW_PROXY_PORT) ;;
      *)
        echo "ERROR: plain-progress build refuses unreviewed ARG ${arg_name} in ${dockerfile}" >&2
        exit 1
        ;;
    esac
  done < <(
    awk '
      toupper($1) == "ARG" {
        name = $2
        while (name == "\\") {
          if ((getline) <= 0) {
            print "<unterminated-ARG>"
            next
          }
          name = $1
        }
        sub(/=.*/, "", name)
        print name
      }
    ' "${dockerfile}"
  )
done

# Build the reviewed repository base directly so this trusted negative gate has
# no mutable registry input. Docker layers remain reusable by the live target.
# Plain progress and the captured production log are safe after the ARG-name
# gate above; no build gets secret-bearing input.
docker build \
  --progress=plain \
  --file agents/langchain-deepagents-code/Dockerfile.base \
  --tag "${source_base_image}" \
  .

docker build \
  --progress=plain \
  --file test/Dockerfile.dcode-profile-missing-dependencies \
  --build-arg "BASE_IMAGE=${source_base_image}" \
  --tag "${stripped_image}" \
  .

if docker build \
  --progress=plain \
  --file agents/langchain-deepagents-code/Dockerfile \
  --build-arg "BASE_IMAGE=${stripped_image}" \
  --tag "${failed_image}" \
  . 2>&1 | tee "${build_log}"; then
  echo "ERROR: DCode production image unexpectedly built without deepagents dependencies" >&2
  exit 1
fi

if ! grep -Fq "NEMOCLAW_DCODE_PROFILE_IMPORT_GATE" "${build_log}"; then
  echo "ERROR: DCode build failed before reaching the profile import gate" >&2
  exit 1
fi

if ! grep -Fq "ModuleNotFoundError: No module named 'deepagents'" "${build_log}"; then
  echo "ERROR: DCode build did not fail on the expected missing Deep Agents import" >&2
  exit 1
fi

echo "DCode profile import gate rejected a base missing deepagents and deepagents-code"
