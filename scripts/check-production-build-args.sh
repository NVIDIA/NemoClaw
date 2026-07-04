#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Defense-in-depth guard: primary enforcement of legacy fixture pin rejection is
# in Dockerfile and Dockerfile.base install blocks. This script prevents the
# fixture flag, versions, and pin overrides from reaching production Docker
# build commands.

set -euo pipefail

readonly legacy_fixture_key="NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root
readonly -a production_dockerfiles=(
  "${repo_root}/Dockerfile"
  "${repo_root}/Dockerfile.base"
  "${repo_root}/agents/hermes/Dockerfile"
  "${repo_root}/agents/hermes/Dockerfile.base"
  "${repo_root}/agents/langchain-deepagents-code/Dockerfile"
  "${repo_root}/agents/langchain-deepagents-code/Dockerfile.base"
)

fail_legacy_fixture() {
  echo "ERROR: ${legacy_fixture_key}=1 is only allowed in explicit stale-upgrade E2E fixture builds." >&2
  echo "       Do not pass it to production Docker image build args." >&2
  exit 1
}

fail_pin_override() {
  echo "ERROR: OpenClaw fixture versions and dependency pin overrides are not allowed in production image builds." >&2
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

  case "$build_arg" in
    OPENCLAW_VERSION=2026.3.11 | OPENCLAW_VERSION=2026.4.24)
      fail_pin_override
      ;;
  esac

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

if [ "${NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW:-0}" = "1" ]; then
  fail_legacy_fixture
fi

case "${OPENCLAW_VERSION:-}" in
  2026.3.11 | 2026.4.24) fail_pin_override ;;
esac

while IFS= read -r environment_name; do
  if is_pin_override_name "$environment_name" \
    && is_declared_pin_environment_name "$environment_name"; then
    fail_pin_override
  fi
done < <(compgen -e)

previous_arg=""
for arg in "$@"; do
  case "$arg" in
    *$'\r'* | *$'\n'*) fail_multiline_arg ;;
  esac

  case "$arg" in
    "${legacy_fixture_key}=1" | "--build-arg=${legacy_fixture_key}=1")
      fail_legacy_fixture
      ;;
  esac

  check_production_build_arg "$arg"

  if [ "$previous_arg" = "--build-arg" ] && [ "$arg" = "${legacy_fixture_key}=1" ]; then
    fail_legacy_fixture
  fi
  previous_arg="$arg"
done
