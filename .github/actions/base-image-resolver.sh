# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

# Shared mechanics for the sandbox base-image resolver actions. Agent-specific
# candidate construction and validation intentionally remain in each action.

resolver_glibc_version() {
  docker run --rm --entrypoint /usr/bin/ldd "$1" --version 2>/dev/null \
    | sed -nE 's/.*GLIBC ([0-9]+\.[0-9]+).*/\1/p; s/.* ([0-9]+\.[0-9]+)$/\1/p' \
    | head -n 1
}

resolver_glibc_ok() {
  local have="$1" minimum="$2"
  [[ -n "$have" ]] \
    && [[ "$(printf '%s\n%s\n' "$minimum" "$have" | sort -V | head -n 1)" == "$minimum" ]]
}

resolver_pull() {
  docker pull "$1" >/dev/null 2>&1
}

resolver_repo_digest() {
  local ref="$1" repository="$2"
  docker image inspect "$ref" --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    | grep -F -m 1 "${repository}@sha256:"
}

resolver_try_candidates() {
  local callback="$1" ref
  shift
  for ref in "$@"; do
    if "$callback" "$ref"; then
      return 0
    fi
  done
  return 1
}

resolver_build_local() {
  local dockerfile="$1" tag="$2"
  docker build -f "$dockerfile" -t "$tag" .
}

resolver_write_env() {
  local name="$1" value="$2"
  [[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || {
    echo "::error::Invalid GitHub environment variable name: ${name}" >&2
    return 1
  }
  [[ "$value" != *$'\n'* && -n "$value" ]] || {
    echo "::error::Invalid empty or multiline image reference" >&2
    return 1
  }
  printf '%s=%s\n' "$name" "$value" >>"$GITHUB_ENV"
}
