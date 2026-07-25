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

resolver_normalize_base_branch() {
  local branch="${1:-main}"
  [[ -n "$branch" ]] || branch="main"
  if ! git check-ref-format --branch "$branch" >/dev/null 2>&1; then
    echo "::warning::Invalid base branch '${branch}'; comparing with main" >&2
    branch="main"
  fi
  printf '%s\n' "$branch"
}

# Return success when the feature side of the base-branch merge base changed
# any tracked base-image input, or when Git cannot prove that it did not.
#
# Comparing merge-base -> HEAD intentionally ignores base-only drift. A stale
# feature branch can then reuse the compatible image published by current main
# instead of rebuilding main's newer Dockerfile.base locally.
resolver_base_inputs_changed_since_base() {
  local base_branch head_sha shallow base_ref merge_base status
  base_branch="$(resolver_normalize_base_branch "${1:-main}")"
  shift || true
  (($# > 0)) || {
    echo "::warning::No sandbox base-image inputs were provided; building locally" >&2
    return 0
  }

  if git diff --quiet -- "$@"; then
    status=0
  else
    status=$?
  fi
  case "$status" in
    0) ;;
    1) return 0 ;;
    *)
      echo "::warning::Could not inspect unstaged sandbox base-image inputs; building locally" >&2
      return 0
      ;;
  esac

  if git diff --cached --quiet -- "$@"; then
    status=0
  else
    status=$?
  fi
  case "$status" in
    0) ;;
    1) return 0 ;;
    *)
      echo "::warning::Could not inspect staged sandbox base-image inputs; building locally" >&2
      return 0
      ;;
  esac

  if ! head_sha="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)"; then
    echo "::warning::Could not resolve the checkout HEAD; building sandbox base locally" >&2
    return 0
  fi

  base_ref="refs/remotes/origin/${base_branch}"
  shallow="$(git rev-parse --is-shallow-repository 2>/dev/null || true)"
  if [[ "$shallow" == "true" ]]; then
    if ! git fetch --no-tags --unshallow origin \
      "$head_sha" \
      "+refs/heads/${base_branch}:${base_ref}" >/dev/null 2>&1; then
      echo "::warning::Could not recover shallow comparison history for ${base_branch}; building sandbox base locally" >&2
      return 0
    fi
  elif ! git fetch --no-tags origin \
    "+refs/heads/${base_branch}:${base_ref}" >/dev/null 2>&1; then
    echo "::warning::Could not fetch base branch ${base_branch}; building sandbox base locally" >&2
    return 0
  fi

  if ! git rev-parse --verify "${base_ref}^{commit}" >/dev/null 2>&1; then
    echo "::warning::Fetched base branch ${base_branch} is unavailable; building sandbox base locally" >&2
    return 0
  fi
  if ! merge_base="$(git merge-base "$base_ref" "$head_sha" 2>/dev/null)"; then
    echo "::warning::No common ancestor with ${base_branch}; building sandbox base locally" >&2
    return 0
  fi

  if git diff --quiet "$merge_base" "$head_sha" -- "$@"; then
    status=0
  else
    status=$?
  fi
  case "$status" in
    0) return 1 ;;
    1) return 0 ;;
    *)
      echo "::warning::Could not compare sandbox base-image inputs; building locally" >&2
      return 0
      ;;
  esac
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
