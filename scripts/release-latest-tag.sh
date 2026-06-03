#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REMOTE_NAME="${REMOTE_NAME:-origin}"
RELEASE_TAG="${RELEASE_TAG:?RELEASE_TAG is required}"
PUSH_LATEST="${PUSH_LATEST:-1}"
PUSH_REMOTE_URL="${PUSH_REMOTE_URL:-$REMOTE_NAME}"

fail() {
  echo "release-latest-tag: $*" >&2
  exit 1
}

if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Refusing to promote non-semver tag: $RELEASE_TAG"
fi

# Force-refresh remote main and tags so local stale tags cannot influence the
# release-order, reachability, or annotated-tag checks.
git fetch --force "$REMOTE_NAME" \
  "+refs/heads/main:refs/remotes/${REMOTE_NAME}/main" \
  "+refs/tags/*:refs/tags/*"

if [[ "$(git cat-file -t "refs/tags/$RELEASE_TAG" 2>/dev/null || true)" != "tag" ]]; then
  fail "Refusing to promote $RELEASE_TAG: release tags must be annotated"
fi

release_commit="$(git rev-parse "${RELEASE_TAG}^{commit}")"
main_ref="refs/remotes/${REMOTE_NAME}/main"
main_commit="$(git rev-parse "$main_ref")"

if ! git merge-base --is-ancestor "$release_commit" "$main_ref"; then
  fail "Refusing to promote $RELEASE_TAG: $release_commit is not reachable from $main_ref ($main_commit)"
fi

latest_remote_semver="$(
  git ls-remote --tags "$REMOTE_NAME" 'v*' \
    | awk '{print $2}' \
    | sed 's#refs/tags/##; s#\^{}##' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -Vr \
    | head -1 \
    || true
)"

if [[ -z "$latest_remote_semver" ]]; then
  fail "No remote semver tags found"
fi

if [[ "$RELEASE_TAG" != "$latest_remote_semver" ]]; then
  fail "Refusing to promote $RELEASE_TAG: latest remote semver tag is $latest_remote_semver"
fi

git tag -fa latest "$release_commit" -m "latest -> $RELEASE_TAG"

if [[ "$PUSH_LATEST" != "0" ]]; then
  git push "$PUSH_REMOTE_URL" refs/tags/latest --force
fi

{
  echo "## Release latest tag"
  echo
  echo "- Release tag: \`$RELEASE_TAG\`"
  echo "- Release commit: \`$release_commit\`"
  echo "- Remote main: \`$main_commit\`"
  echo "- Latest remote semver: \`$latest_remote_semver\`"
  echo "- Updated: \`latest\`"
  echo "- Not touched: \`lkg\`"
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

printf 'release-latest-tag: promoted latest to %s (%s)\n' "$RELEASE_TAG" "$release_commit"
