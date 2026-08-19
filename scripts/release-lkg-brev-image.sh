#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

TARGET_REPOSITORY="brevdev/nemoclaw-image"
PRODUCTION_WORKFLOW="build-scheduled.yml"
LKG_WORKFLOW="build-lkg-image.yml"
TARGET_REF="main"
SOURCE_REPOSITORY="NVIDIA/NemoClaw"
SOURCE_WORKFLOW=".github/workflows/release-lkg-brev-image.yaml"
SOURCE_EVENT="push"
SOURCE_REF="refs/tags/lkg"
REQUEST_KIND="nemoclaw-lkg-image-request"
REQUEST_SCHEMA_VERSION="1"
REQUEST_FILENAME="nemoclaw-lkg-image-request.v1.json"
SUMMARY_PATH="${GITHUB_STEP_SUMMARY:-/dev/null}"

lkg_commit="unresolved"
release_tag="none"
production_dispatch_result="not attempted"
production_run_id="unavailable"
production_run_url=""
lkg_dispatch_result="not attempted"
lkg_run_id="unavailable"
lkg_run_url=""
last_dispatch_result="not attempted"
last_run_id="unavailable"
last_run_url=""

write_summary() {
  {
    echo "## LKG Brev image dispatches"
    echo
    echo "- LKG commit: \`$lkg_commit\`"
    echo "- Release tag: \`$release_tag\`"
    echo "- Source run: \`${GITHUB_RUN_ID:-unavailable}\` (attempt \`${GITHUB_RUN_ATTEMPT:-unavailable}\`)"
    echo
    echo "### Production image"
    echo
    echo "- Target: \`$TARGET_REPOSITORY/.github/workflows/$PRODUCTION_WORKFLOW@$TARGET_REF\`"
    echo "- Dispatch result: \`$production_dispatch_result\`"
    if [[ -n "$production_run_url" ]]; then
      echo "- Downstream run: [$production_run_id]($production_run_url)"
    else
      echo "- Downstream run: \`$production_run_id\`"
    fi
    echo
    echo "### LKG-only image"
    echo
    echo "- Target: \`$TARGET_REPOSITORY/.github/workflows/$LKG_WORKFLOW@$TARGET_REF\`"
    echo "- Dispatch result: \`$lkg_dispatch_result\`"
    if [[ -n "$lkg_run_url" ]]; then
      echo "- Downstream run: [$lkg_run_id]($lkg_run_url)"
    else
      echo "- Downstream run: \`$lkg_run_id\`"
    fi
    echo
    echo "Follow each accepted downstream run to terminal success and verify its image publication."
  } >>"$SUMMARY_PATH"
}

fail() {
  echo "release-lkg-brev-image: $*" >&2
  exit 1
}

skip_deleted_lkg() {
  if [[ "${LKG_DELETED:-false}" != "true" ]]; then
    return 1
  fi

  production_dispatch_result="skipped (lkg deleted)"
  lkg_dispatch_result="skipped (lkg deleted)"
  echo "release-lkg-brev-image: skipping deleted lkg tag"
  return 0
}

validate_source_context() {
  [[ "${GITHUB_REPOSITORY:-}" == "$SOURCE_REPOSITORY" ]] \
    || fail "GITHUB_REPOSITORY must be $SOURCE_REPOSITORY"
  [[ "${GITHUB_EVENT_NAME:-}" == "$SOURCE_EVENT" ]] \
    || fail "GITHUB_EVENT_NAME must be $SOURCE_EVENT"
  [[ "${GITHUB_REF:-}" == "$SOURCE_REF" ]] \
    || fail "GITHUB_REF must be $SOURCE_REF"
  [[ "${GITHUB_WORKFLOW_REF:-}" == "$SOURCE_REPOSITORY/$SOURCE_WORKFLOW@$SOURCE_REF" ]] \
    || fail "GITHUB_WORKFLOW_REF must identify $SOURCE_WORKFLOW at $SOURCE_REF"
  [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] \
    || fail "GITHUB_RUN_ID must be a positive decimal integer"
  [[ "${GITHUB_RUN_ATTEMPT:-}" == "1" ]] \
    || fail "GITHUB_RUN_ATTEMPT must be 1"
  [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] \
    || fail "GITHUB_SHA must be a 40-character lowercase hexadecimal SHA"
}

resolve_release() {
  LKG_SHA="${LKG_SHA:?LKG_SHA is required}"
  if [[ ! "$LKG_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    fail "LKG_SHA must be a full commit or tag-object SHA"
  fi
  if [[ "$LKG_SHA" != "$GITHUB_SHA" ]]; then
    fail "LKG_SHA must match GITHUB_SHA"
  fi

  lkg_commit="$(git rev-parse --verify "${LKG_SHA}^{commit}" 2>/dev/null)" \
    || fail "Unable to peel LKG target $LKG_SHA to a commit"
  if [[ "$lkg_commit" != "$GITHUB_SHA" ]]; then
    fail "LKG_SHA must identify the LKG commit directly"
  fi

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
}

prepare_request() {
  validate_source_context
  resolve_release

  local request_path="${LKG_REQUEST_PATH:-}"
  if [[ -z "$request_path" ]]; then
    [[ -n "${RUNNER_TEMP:-}" ]] \
      || fail "RUNNER_TEMP or LKG_REQUEST_PATH is required to locate the LKG image request"
    request_path="$RUNNER_TEMP/nemoclaw-lkg-image-request/$REQUEST_FILENAME"
  fi
  [[ -n "$request_path" && "${request_path##*/}" == "$REQUEST_FILENAME" ]] \
    || fail "LKG_REQUEST_PATH must end with $REQUEST_FILENAME"
  [[ ! -e "$request_path" ]] || fail "Refusing to overwrite existing LKG image request"

  local created_at
  created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || fail "Unable to create an RFC 3339 UTC timestamp"

  local request_json
  request_json="$(
    jq -cn \
      --argjson schema_version "$REQUEST_SCHEMA_VERSION" \
      --arg kind "$REQUEST_KIND" \
      --arg source_repository "$SOURCE_REPOSITORY" \
      --arg source_workflow "$SOURCE_WORKFLOW" \
      --arg event "$SOURCE_EVENT" \
      --arg ref "$SOURCE_REF" \
      --arg run_id "$GITHUB_RUN_ID" \
      --arg event_sha "$GITHUB_SHA" \
      --arg target_repository "$TARGET_REPOSITORY" \
      --arg target_workflow ".github/workflows/$LKG_WORKFLOW" \
      --arg created_at "$created_at" \
      '{schemaVersion:$schema_version,kind:$kind,sourceRepository:$source_repository,sourceWorkflow:$source_workflow,event:$event,ref:$ref,runId:$run_id,runAttempt:1,eventSha:$event_sha,targetRepository:$target_repository,targetWorkflow:$target_workflow,createdAt:$created_at}'
  )" || fail "Unable to create the LKG image request"

  umask 077
  local request_directory
  request_directory="$(dirname -- "$request_path")"
  mkdir -p "$request_directory"
  printf '%s\n' "$request_json" >"$request_path"
  local expected_bytes
  expected_bytes=$((${#request_json} + 1))
  local actual_bytes
  actual_bytes="$(wc -c <"$request_path" | tr -d '[:space:]')"
  if [[ "$(<"$request_path")" != "$request_json" || "$actual_bytes" != "$expected_bytes" ]]; then
    fail "LKG image request bytes are not canonical compact JSON with one trailing LF"
  fi
  jq -e \
    --arg run_id "$GITHUB_RUN_ID" \
    --arg event_sha "$GITHUB_SHA" \
    --arg created_at "$created_at" \
    'keys_unsorted == ["schemaVersion","kind","sourceRepository","sourceWorkflow","event","ref","runId","runAttempt","eventSha","targetRepository","targetWorkflow","createdAt"] and .schemaVersion == 1 and .kind == "nemoclaw-lkg-image-request" and .sourceRepository == "NVIDIA/NemoClaw" and .sourceWorkflow == ".github/workflows/release-lkg-brev-image.yaml" and .event == "push" and .ref == "refs/tags/lkg" and .runId == $run_id and .runAttempt == 1 and .eventSha == $event_sha and .targetRepository == "brevdev/nemoclaw-image" and .targetWorkflow == ".github/workflows/build-lkg-image.yml" and .createdAt == $created_at' \
    "$request_path" >/dev/null || fail "LKG image request content failed local validation"
  chmod 0400 "$request_path"
  printf 'release-lkg-brev-image: prepared %s for source run %s attempt %s\n' \
    "$request_path" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"
}

dispatch_workflow() {
  local workflow="$1"
  local payload="$2"
  local label="$3"
  local endpoint="repos/$TARGET_REPOSITORY/actions/workflows/$workflow/dispatches"
  local dispatch_details

  last_dispatch_result="failed (dispatch may have been accepted)"
  last_run_id="unavailable"
  last_run_url=""

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
    echo "release-lkg-brev-image: GitHub did not confirm the $label dispatch; it may have been accepted and will not be retried" >&2
    return 1
  fi

  IFS=$'\t' read -r last_run_id last_run_url <<<"$dispatch_details"
  local expected_run_url="https://github.com/$TARGET_REPOSITORY/actions/runs/$last_run_id"
  if [[ ! "$last_run_id" =~ ^[1-9][0-9]*$ || "$last_run_url" != "$expected_run_url" ]]; then
    last_run_id="unavailable"
    last_run_url=""
    last_dispatch_result="accepted (remote run identity unavailable)"
    echo "release-lkg-brev-image: GitHub accepted the $label dispatch but did not return valid run details; it will not be retried" >&2
    return 1
  fi

  last_dispatch_result="accepted (HTTP 200)"
  printf 'release-lkg-brev-image: dispatched %s for %s (%s): %s\n' \
    "$workflow" "$release_tag" "$lkg_commit" "$last_run_url"
  return 0
}

dispatch_images() {
  validate_source_context
  resolve_release

  if [[ -z "${NEMOCLAW_IMAGE_DISPATCH_TOKEN:-}" ]]; then
    fail "NEMOCLAW_IMAGE_DISPATCH_TOKEN is required to dispatch $TARGET_REPOSITORY"
  fi

  if ! command -v gh >/dev/null 2>&1; then
    fail "GitHub CLI is required to dispatch $TARGET_REPOSITORY"
  fi

  local production_payload
  production_payload="$(printf '{\"ref\":\"%s\",\"inputs\":{\"nemoclaw_ref\":\"%s\"},\"return_run_details\":true}' "$TARGET_REF" "$release_tag")"
  local lkg_payload
  lkg_payload="$(printf '{\"ref\":\"%s\",\"return_run_details\":true,\"inputs\":{\"requester_workflow_run_id\":\"%s\",\"requester_workflow_run_attempt\":\"%s\"}}' "$TARGET_REF" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT")"

  local failed=0
  if ! dispatch_workflow "$PRODUCTION_WORKFLOW" "$production_payload" "production image"; then
    failed=1
  fi
  production_dispatch_result="$last_dispatch_result"
  production_run_id="$last_run_id"
  production_run_url="$last_run_url"

  if ! dispatch_workflow "$LKG_WORKFLOW" "$lkg_payload" "LKG-only image"; then
    failed=1
  fi
  lkg_dispatch_result="$last_dispatch_result"
  lkg_run_id="$last_run_id"
  lkg_run_url="$last_run_url"

  if ((failed != 0)); then
    fail "One or more image dispatches were not confirmed; see the workflow summary"
  fi
}

operation="${1:-dispatch-images}"
case "$operation" in
  prepare-request)
    if skip_deleted_lkg; then
      exit 0
    fi
    prepare_request
    ;;
  dispatch-images)
    trap write_summary EXIT
    if skip_deleted_lkg; then
      exit 0
    fi
    dispatch_images
    ;;
  *)
    fail "Usage: ${0##*/} [prepare-request|dispatch-images]"
    ;;
esac
