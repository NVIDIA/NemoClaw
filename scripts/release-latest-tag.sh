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

ensure_tag_identity() {
  if git var GIT_COMMITTER_IDENT >/dev/null 2>&1; then
    return
  fi

  git config user.name "${RELEASE_TAGGER_NAME:-github-actions[bot]}"
  git config user.email "${RELEASE_TAGGER_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

  if ! git var GIT_COMMITTER_IDENT >/dev/null 2>&1; then
    fail "Unable to configure a git committer identity for latest tag promotion"
  fi
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

latest_commit="$(git rev-parse --verify --quiet "refs/tags/latest^{commit}" || true)"
if [[ -n "$latest_commit" ]] && ! git merge-base --is-ancestor "$latest_commit" "$release_commit"; then
  fail "Refusing to move latest backward: current latest $latest_commit is not an ancestor of $RELEASE_TAG ($release_commit)"
fi

previous_remote_semver="$({
  git tag -l 'v[0-9]*.[0-9]*.[0-9]*' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | grep -Fvx "$RELEASE_TAG" \
    | sort -Vr \
    | head -1
} || true)"
previous_semver_commit=""
if [[ -n "$previous_remote_semver" ]]; then
  previous_semver_commit="$(git rev-parse "${previous_remote_semver}^{commit}")"
  if ! git merge-base --is-ancestor "$previous_semver_commit" "$release_commit"; then
    fail "Refusing to move latest backward: previous release $previous_remote_semver ($previous_semver_commit) is not an ancestor of $RELEASE_TAG ($release_commit)"
  fi
fi

ensure_tag_identity
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
  echo "- Previous latest commit: \`${latest_commit:-none}\`"
  echo "- Previous semver tag: \`${previous_remote_semver:-none}\`"
  echo "- Previous semver commit: \`${previous_semver_commit:-none}\`"
  echo "- Updated: \`latest\`"
  echo "- Not touched: \`lkg\`"
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

printf 'release-latest-tag: promoted latest to %s (%s)\n' "$RELEASE_TAG" "$release_commit"
