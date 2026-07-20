#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

TARGET_REPOSITORY="brevdev/nemoclaw-image"
TARGET_WORKFLOW="build-scheduled.yml"
TARGET_REF="main"
SUMMARY_PATH="${GITHUB_STEP_SUMMARY:-/dev/null}"

lkg_commit="unresolved"
release_tag="none"
dispatch_result="not attempted"
downstream_run_id="unavailable"
downstream_run_url=""

write_summary() {
  {
    echo "## LKG production image dispatch"
    echo
    echo "- LKG commit: \`$lkg_commit\`"
    echo "- Release tag: \`$release_tag\`"
    echo "- Target: \`$TARGET_REPOSITORY/.github/workflows/$TARGET_WORKFLOW@$TARGET_REF\`"
    echo "- Dispatch result: \`$dispatch_result\`"
    if [[ -n "$downstream_run_url" ]]; then
      echo "- Downstream run: [$downstream_run_id]($downstream_run_url)"
      echo
      echo "Follow the downstream run to terminal success and verify production image promotion."
    else
      echo "- Downstream run: \`$downstream_run_id\`"
    fi
  } >>"$SUMMARY_PATH"
}

fail() {
  echo "release-lkg-brev-image: $*" >&2
  exit 1
}

trap write_summary EXIT

if [[ "${LKG_DELETED:-false}" == "true" ]]; then
  dispatch_result="skipped (lkg deleted)"
  echo "release-lkg-brev-image: skipping deleted lkg tag"
  exit 0
fi

LKG_SHA="${LKG_SHA:?LKG_SHA is required}"
if [[ ! "$LKG_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  fail "LKG_SHA must be a full commit or tag-object SHA"
fi

lkg_commit="$(git rev-parse --verify "${LKG_SHA}^{commit}" 2>/dev/null)" \
  || fail "Unable to peel LKG target $LKG_SHA to a commit"

release_tag="$({
  git tag --points-at "$lkg_commit" --list 'v*' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -1
} || true)"

if [[ -z "$release_tag" ]]; then
  release_tag="none"
  fail "LKG target $lkg_commit has no exact vX.Y.Z release tag"
fi

release_commit="$(git rev-parse --verify "refs/tags/${release_tag}^{commit}")"
if [[ "$release_commit" != "$lkg_commit" ]]; then
  fail "Release tag $release_tag does not peel to LKG target $lkg_commit"
fi

if [[ -z "${NEMOCLAW_IMAGE_DISPATCH_TOKEN:-}" ]]; then
  fail "NEMOCLAW_IMAGE_DISPATCH_TOKEN is required to dispatch $TARGET_REPOSITORY"
fi

if ! command -v gh >/dev/null 2>&1; then
  fail "GitHub CLI is required to dispatch $TARGET_REPOSITORY"
fi

payload="$(printf '{"ref":"%s","inputs":{"nemoclaw_ref":"%s"},"return_run_details":true}' "$TARGET_REF" "$release_tag")"
endpoint="repos/$TARGET_REPOSITORY/actions/workflows/$TARGET_WORKFLOW/dispatches"

if ! dispatch_details="$(
  printf '%s\n' "$payload" \
    | env -u GH_DEBUG GH_TOKEN="$NEMOCLAW_IMAGE_DISPATCH_TOKEN" gh api \
      --method POST \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2026-03-10" \
      "$endpoint" \
      --input - \
      --jq '[.workflow_run_id, .html_url] | @tsv'
)"; then
  dispatch_result="rejected"
  fail "GitHub rejected the production image dispatch to $TARGET_REPOSITORY/$TARGET_WORKFLOW"
fi

IFS=$'\t' read -r downstream_run_id downstream_run_url <<<"$dispatch_details"
expected_run_url="https://github.com/$TARGET_REPOSITORY/actions/runs/$downstream_run_id"
if [[ ! "$downstream_run_id" =~ ^[0-9]+$ || "$downstream_run_url" != "$expected_run_url" ]]; then
  downstream_run_id="unavailable"
  downstream_run_url=""
  dispatch_result="rejected (invalid run details)"
  fail "GitHub accepted the dispatch but did not return valid downstream run details"
fi

dispatch_result="accepted (HTTP 200)"
printf 'release-lkg-brev-image: dispatched %s for %s (%s): %s\n' \
  "$TARGET_WORKFLOW" "$release_tag" "$lkg_commit" "$downstream_run_url"
