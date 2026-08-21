#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

TARGET_REPOSITORY="brevdev/nemoclaw-image"
TARGET_WORKFLOW="build-daily-image.yml"
TARGET_REF="main"
SOURCE_REPOSITORY="NVIDIA/NemoClaw"
SOURCE_WORKFLOW=".github/workflows/release-daily-brev-image.yaml"
SOURCE_EVENT="push"
REQUEST_KIND="nemoclaw-daily-image-request"
REQUEST_SCHEMA_VERSION="1"
REQUEST_FILENAME="nemoclaw-daily-image-request.v1.json"
SUMMARY_PATH="${GITHUB_STEP_SUMMARY:-/dev/null}"

release_tag="unresolved"
event_sha="unresolved"
tag_object_sha="unresolved"
dispatch_result="not attempted"
downstream_run_id="unavailable"
downstream_run_url=""

fail() {
  echo "release-daily-brev-image: $*" >&2
  exit 1
}

write_summary() {
  {
    echo "## Daily Brev image dispatch"
    echo
    echo "- Release tag: \`$release_tag\`"
    echo "- Event commit: \`$event_sha\`"
    echo "- Source run: \`${GITHUB_RUN_ID:-unavailable}\` (attempt \`${GITHUB_RUN_ATTEMPT:-unavailable}\`)"
    echo "- Target: \`$TARGET_REPOSITORY/.github/workflows/$TARGET_WORKFLOW@$TARGET_REF\`"
    echo "- Dispatch result: \`$dispatch_result\`"
    if [[ -n "$downstream_run_url" ]]; then
      echo "- Downstream run: [$downstream_run_id]($downstream_run_url)"
    else
      echo "- Downstream run: \`$downstream_run_id\`"
    fi
    echo
    echo "Follow the accepted downstream run to terminal success and verify its image publication."
  } >>"$SUMMARY_PATH"
}

validate_source_context() {
  [[ "${GITHUB_REPOSITORY:-}" == "$SOURCE_REPOSITORY" ]] \
    || fail "GITHUB_REPOSITORY must be $SOURCE_REPOSITORY"
  [[ "${GITHUB_EVENT_NAME:-}" == "$SOURCE_EVENT" ]] \
    || fail "GITHUB_EVENT_NAME must be $SOURCE_EVENT"
  [[ "${DAILY_IMAGE_DELETED:-}" == "false" ]] \
    || fail "DAILY_IMAGE_DELETED must be false"
  [[ "${GITHUB_REF:-}" =~ ^refs/tags/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
    || fail "GITHUB_REF must identify an exact canonical vX.Y.Z release tag"

  release_tag="${GITHUB_REF#refs/tags/}"
  [[ "${GITHUB_WORKFLOW_REF:-}" == "$SOURCE_REPOSITORY/$SOURCE_WORKFLOW@$GITHUB_REF" ]] \
    || fail "GITHUB_WORKFLOW_REF must identify $SOURCE_WORKFLOW at $GITHUB_REF"
  [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] \
    || fail "GITHUB_RUN_ID must be a positive decimal integer"
  [[ "${GITHUB_RUN_ATTEMPT:-}" == "1" ]] \
    || fail "GITHUB_RUN_ATTEMPT must be 1"
  [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] \
    || fail "GITHUB_SHA must be a 40-character lowercase hexadecimal SHA"

  [[ -n "${DAILY_IMAGE_SHA:-}" ]] \
    || fail "DAILY_IMAGE_SHA is required"
  [[ "$DAILY_IMAGE_SHA" == "$GITHUB_SHA" ]] \
    || fail "DAILY_IMAGE_SHA must match GITHUB_SHA"
  event_sha="$GITHUB_SHA"
}

github_api() {
  env -u GH_DEBUG gh api \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "$@"
}

verify_release_tag() {
  [[ -n "${GH_TOKEN:-}" ]] \
    || fail "GH_TOKEN is required to verify the daily release tag"
  command -v gh >/dev/null 2>&1 \
    || fail "GitHub CLI is required to verify the daily release tag"

  local ref_details
  ref_details="$(
    github_api \
      "repos/$SOURCE_REPOSITORY/git/ref/tags/$release_tag" \
      --jq '[.object.type, .object.sha] | @tsv'
  )" || fail "Unable to resolve release tag $release_tag through the GitHub API"

  local ref_object_type
  IFS=$'\t' read -r ref_object_type tag_object_sha <<<"$ref_details"
  [[ "$ref_object_type" == "tag" ]] \
    || fail "Release tag $release_tag must be annotated"
  [[ "$tag_object_sha" =~ ^[0-9a-f]{40}$ ]] \
    || fail "Release tag $release_tag has an invalid tag-object SHA"

  local verified="false"
  local verification_reason="unknown"
  local attempt
  for attempt in {1..10}; do
    local tag_details
    tag_details="$(
      github_api \
        "repos/$SOURCE_REPOSITORY/git/tags/$tag_object_sha" \
        --jq '[.tag, .object.type, .object.sha, .verification.verified, .verification.reason] | @tsv'
    )" || fail "Unable to inspect release tag object $tag_object_sha through the GitHub API"

    local object_tag
    local object_type
    local object_sha
    IFS=$'\t' read -r object_tag object_type object_sha verified verification_reason <<<"$tag_details"
    [[ "$object_tag" == "$release_tag" ]] \
      || fail "Tag object $tag_object_sha names $object_tag, expected $release_tag"
    [[ "$object_type" == "commit" ]] \
      || fail "Release tag $release_tag must point directly to a commit"
    [[ "$object_sha" == "$event_sha" ]] \
      || fail "Release tag $release_tag must point to GITHUB_SHA"

    if [[ "$verified" == "true" ]]; then
      [[ "$verification_reason" == "valid" ]] \
        || fail "Release tag $release_tag verification reason must be valid"
      break
    fi
    if ((attempt < 10)); then
      echo "release-daily-brev-image: waiting for GitHub tag verification ($attempt/10)"
      sleep 3
    fi
  done
  [[ "$verified" == "true" && "$verification_reason" == "valid" ]] \
    || fail "Release tag $release_tag is not GitHub-Verified ($verification_reason)"

  local compare_status
  compare_status="$(
    github_api \
      "repos/$SOURCE_REPOSITORY/compare/$event_sha...main" \
      --jq '.status'
  )" || fail "Unable to compare release commit $event_sha with main through the GitHub API"
  [[ "$compare_status" == "ahead" || "$compare_status" == "identical" ]] \
    || fail "Release commit $event_sha must be reachable from main"
}

prepare_request() {
  validate_source_context
  verify_release_tag

  local request_path="${DAILY_IMAGE_REQUEST_PATH:-}"
  if [[ -z "$request_path" ]]; then
    [[ -n "${RUNNER_TEMP:-}" ]] \
      || fail "RUNNER_TEMP or DAILY_IMAGE_REQUEST_PATH is required to locate the daily image request"
    request_path="$RUNNER_TEMP/nemoclaw-daily-image-request/$REQUEST_FILENAME"
  fi
  [[ -n "$request_path" && "${request_path##*/}" == "$REQUEST_FILENAME" ]] \
    || fail "DAILY_IMAGE_REQUEST_PATH must end with $REQUEST_FILENAME"
  [[ ! -e "$request_path" ]] || fail "Refusing to overwrite existing daily image request"

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
      --arg ref "$GITHUB_REF" \
      --arg run_id "$GITHUB_RUN_ID" \
      --arg event_sha "$event_sha" \
      --arg release_tag "$release_tag" \
      --arg tag_object_sha "$tag_object_sha" \
      --arg target_repository "$TARGET_REPOSITORY" \
      --arg target_workflow ".github/workflows/$TARGET_WORKFLOW" \
      --arg created_at "$created_at" \
      '{schemaVersion:$schema_version,kind:$kind,sourceRepository:$source_repository,sourceWorkflow:$source_workflow,event:$event,ref:$ref,runId:$run_id,runAttempt:1,eventSha:$event_sha,releaseTag:$release_tag,tagObjectSha:$tag_object_sha,targetRepository:$target_repository,targetWorkflow:$target_workflow,createdAt:$created_at}'
  )" || fail "Unable to create the daily image request"

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
    fail "Daily image request bytes are not canonical compact JSON with one trailing LF"
  fi
  jq -e \
    --arg ref "$GITHUB_REF" \
    --arg run_id "$GITHUB_RUN_ID" \
    --arg event_sha "$event_sha" \
    --arg release_tag "$release_tag" \
    --arg tag_object_sha "$tag_object_sha" \
    --arg created_at "$created_at" \
    'keys_unsorted == ["schemaVersion","kind","sourceRepository","sourceWorkflow","event","ref","runId","runAttempt","eventSha","releaseTag","tagObjectSha","targetRepository","targetWorkflow","createdAt"] and .schemaVersion == 1 and .kind == "nemoclaw-daily-image-request" and .sourceRepository == "NVIDIA/NemoClaw" and .sourceWorkflow == ".github/workflows/release-daily-brev-image.yaml" and .event == "push" and .ref == $ref and .runId == $run_id and .runAttempt == 1 and .eventSha == $event_sha and .releaseTag == $release_tag and .tagObjectSha == $tag_object_sha and .targetRepository == "brevdev/nemoclaw-image" and .targetWorkflow == ".github/workflows/build-daily-image.yml" and .createdAt == $created_at' \
    "$request_path" >/dev/null || fail "Daily image request content failed local validation"
  chmod 0400 "$request_path"
  printf 'release-daily-brev-image: prepared %s for source run %s attempt %s\n' \
    "$request_path" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"
}

dispatch_image() {
  validate_source_context

  [[ -n "${NEMOCLAW_IMAGE_DISPATCH_TOKEN:-}" ]] \
    || fail "NEMOCLAW_IMAGE_DISPATCH_TOKEN is required to dispatch $TARGET_REPOSITORY"
  command -v gh >/dev/null 2>&1 \
    || fail "GitHub CLI is required to dispatch $TARGET_REPOSITORY"

  local payload
  payload="$(printf '{\"ref\":\"%s\",\"return_run_details\":true,\"inputs\":{\"requester_workflow_run_id\":\"%s\",\"requester_workflow_run_attempt\":\"%s\"}}' "$TARGET_REF" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT")"
  local endpoint="repos/$TARGET_REPOSITORY/actions/workflows/$TARGET_WORKFLOW/dispatches"
  local dispatch_details

  dispatch_result="failed (dispatch may have been accepted)"
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
    echo "release-daily-brev-image: GitHub did not confirm the daily image dispatch; it may have been accepted and will not be retried" >&2
    return 1
  fi

  IFS=$'\t' read -r downstream_run_id downstream_run_url <<<"$dispatch_details"
  local expected_run_url="https://github.com/$TARGET_REPOSITORY/actions/runs/$downstream_run_id"
  if [[ ! "$downstream_run_id" =~ ^[1-9][0-9]*$ || "$downstream_run_url" != "$expected_run_url" ]]; then
    downstream_run_id="unavailable"
    downstream_run_url=""
    dispatch_result="accepted (remote run identity unavailable)"
    echo "release-daily-brev-image: GitHub accepted the daily image dispatch but did not return valid run details; it will not be retried" >&2
    return 1
  fi

  dispatch_result="accepted (HTTP 200)"
  printf 'release-daily-brev-image: dispatched %s for %s (%s): %s\n' \
    "$TARGET_WORKFLOW" "$release_tag" "$event_sha" "$downstream_run_url"
}

operation="${1:-dispatch-image}"
case "$operation" in
  prepare-request)
    prepare_request
    ;;
  dispatch-image)
    trap write_summary EXIT
    if ! dispatch_image; then
      fail "Daily image dispatch was not confirmed; see the workflow summary"
    fi
    ;;
  *)
    fail "Usage: ${0##*/} [prepare-request|dispatch-image]"
    ;;
esac
