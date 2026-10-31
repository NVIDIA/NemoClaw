#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Protect reviewed dependency pins and reject multiline production build args.

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root
readonly -a production_dockerfiles=(
  "${repo_root}/Dockerfile"
  "${repo_root}/Dockerfile.base"
  "${repo_root}/agents/hermes/Dockerfile"
  "${repo_root}/agents/hermes/Dockerfile.base"
  "${repo_root}/agents/langchain-deepagents-code/Dockerfile"
  "${repo_root}/agents/langchain-deepagents-code/Dockerfile.base"
  "${repo_root}/agents/pi/Dockerfile"
  "${repo_root}/agents/pi/Dockerfile.base"
)

fail_pin_override() {
  echo "ERROR: Dependency pin overrides are not allowed in production image builds." >&2
  echo "       Use only the dependency pins reviewed in the production Dockerfiles." >&2
  exit 1
}

fail_multiline_arg() {
  echo "ERROR: production Docker build arguments must not contain CR or LF characters." >&2
  exit 1
}

is_pin_override_name() {
  case "$1" in
    *_INTEGRITY | *_TARBALL) return 0 ;;
    *) return 1 ;;
  esac
}

check_production_build_arg() {
  local build_arg="${1#--build-arg=}"
  local build_arg_name="${build_arg%%=*}"

  # Positional values are prospective Docker build arguments, so protect every
  # dependency pin name, including pins introduced after this guard was added.
  if is_pin_override_name "$build_arg_name"; then
    fail_pin_override
  fi
}

is_declared_pin_environment_name() {
  local environment_name="$1"
  local dockerfile
  local declaration
  local declared_name

  # An ambient variable is not itself a Docker build arg. Reject it only when
  # its name is a reviewed ARG in a production Dockerfile, avoiding false
  # positives from unrelated CI metadata that happens to share the suffix.
  for dockerfile in "${production_dockerfiles[@]}"; do
    while IFS= read -r declaration; do
      case "$declaration" in
        ARG\ *)
          declared_name="${declaration#ARG }"
          declared_name="${declared_name%%=*}"
          if [ "$declared_name" = "$environment_name" ] \
            && is_pin_override_name "$declared_name"; then
            return 0
          fi
          ;;
      esac
    done <"$dockerfile"
  done
  return 1
}

while IFS= read -r environment_name; do
  if is_pin_override_name "$environment_name" \
    && is_declared_pin_environment_name "$environment_name"; then
    fail_pin_override
  fi
done < <(compgen -e)

for arg in "$@"; do
  case "$arg" in
    *$'\r'* | *$'\n'*) fail_multiline_arg ;;
  esac

  check_production_build_arg "$arg"
done
