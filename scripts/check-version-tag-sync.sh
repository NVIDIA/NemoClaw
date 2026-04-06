#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Pre-push hook: when pushing a v* tag, verify that package.json at the
# tagged commit has a matching version.  Blocks the push if they differ.
#
# Usage (called by prek as a pre-push hook):
#   echo "<local-ref> <local-sha> <remote-ref> <remote-sha>" | bash scripts/check-version-tag-sync.sh
#
# Manual check (no stdin needed — compares latest v* tag with package.json):
#   bash scripts/check-version-tag-sync.sh --check

set -euo pipefail

RED=$'\033[1;31m'
GREEN=$'\033[32m'
DIM=$'\033[2m'
RESET=$'\033[0m'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Extract the "version" field from the package.json at a given commit.
version_at_commit() {
  local sha="$1"
  git -C "$ROOT" show "${sha}:package.json" 2>/dev/null \
    | sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' \
    | head -1
}

check_tag() {
  local tag="$1" sha="$2"
  local tag_version="${tag#v}"
  local pkg_version
  pkg_version="$(version_at_commit "$sha")"

  if [[ -z "$pkg_version" ]]; then
    echo "${RED}✗${RESET} Tag ${tag}: could not read package.json at ${sha:0:8}" >&2
    return 1
  fi

  if [[ "$pkg_version" != "$tag_version" ]]; then
    cat >&2 <<EOF

${RED}✗ Version mismatch for tag ${tag}${RESET}

    Tag version:          ${tag_version}
    package.json version: ${pkg_version}

  Update package.json before tagging:

    ${DIM}npm version ${tag_version} --no-git-tag-version
    git add package.json
    git commit --amend --no-edit
    git tag -f ${tag}${RESET}

EOF
    return 1
  fi

  echo "${GREEN}✓${RESET} Tag ${tag} matches package.json (${pkg_version})"
  return 0
}

# ------------------------------------------------------------------
# --check mode: compare the latest v* tag against current package.json
# ------------------------------------------------------------------
if [[ "${1:-}" == "--check" ]]; then
  latest_tag="$(git -C "$ROOT" describe --tags --match 'v*' --abbrev=0 2>/dev/null || true)"
  if [[ -z "$latest_tag" ]]; then
    echo "${DIM}No v* tags found — nothing to check.${RESET}"
    exit 0
  fi
  sha="$(git -C "$ROOT" rev-list -1 "$latest_tag")"
  check_tag "$latest_tag" "$sha"
  exit $?
fi

# ------------------------------------------------------------------
# Pre-push mode: read pushed refs from stdin
# ------------------------------------------------------------------
errors=0

while IFS=' ' read -r local_ref local_sha _remote_ref _remote_sha; do
  # Only care about v* tag pushes
  case "$local_ref" in
    refs/tags/v*)
      tag="${local_ref#refs/tags/}"
      check_tag "$tag" "$local_sha" || errors=$((errors + 1))
      ;;
  esac
done

if ((errors > 0)); then
  exit 1
fi
