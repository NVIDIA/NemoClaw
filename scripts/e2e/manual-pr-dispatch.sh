#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

pull_field() {
  jq -r "$1" <<<"${PULL_JSON:-}"
}

authenticate() {
  [[ "$WORKFLOW_EVENT" == "workflow_dispatch" && "$WORKFLOW_REF" == "refs/heads/main" ]] \
    || fail "Manual PR E2E must be dispatched from the trusted main branch"
  [[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] \
    || fail "pr_number must be a positive integer"
  [[ "$CHECKOUT_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
    || fail "checkout_repository must be an owner/repository name"
  [[ "$CHECKOUT_SHA" =~ ^[a-f0-9]{40}$ ]] \
    || fail "checkout_sha must be a lowercase 40-character SHA"
  [[ "$BASE_SHA" =~ ^[a-f0-9]{40}$ ]] \
    || fail "base_sha must be a lowercase 40-character SHA"
  [[ "$EXPECTED_WORKFLOW_SHA" =~ ^[a-f0-9]{40}$ && "$EXPECTED_WORKFLOW_SHA" == "$WORKFLOW_SHA" ]] \
    || fail "workflow_sha must match the trusted main workflow SHA"
  [[ "$CORRELATION_ID" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] \
    || fail "correlation_id must be a lowercase UUIDv4"
  [[ "$REVISION" == "candidate" || "$REVISION" == "base" ]] \
    || fail "revision must be candidate or base"

  [[ "$(pull_field '.state')" == "open" ]] || fail "pull request must be open"
  [[ "$(pull_field '.base.repo.full_name // ""')" == "NVIDIA/NemoClaw" ]] \
    || fail "pull request base repository must be NVIDIA/NemoClaw"
  [[ "$(pull_field '.base.sha')" == "$BASE_SHA" ]] \
    || fail "base_sha must match the PR base SHA"
  pr_head_sha="$(pull_field '.head.sha')"
  [[ "$pr_head_sha" =~ ^[a-f0-9]{40}$ ]] || fail "pull request head SHA is invalid"

  case "$REVISION" in
    candidate)
      [[ "$(pull_field '.head.repo.full_name // ""')" == "$CHECKOUT_REPOSITORY" ]] \
        || fail "checkout_repository must match the PR source repository"
      [[ "$pr_head_sha" == "$CHECKOUT_SHA" ]] \
        || fail "candidate checkout_sha must match the latest PR commit SHA"
      ;;
    base)
      [[ "$CHECKOUT_REPOSITORY" == "NVIDIA/NemoClaw" &&
        "$(pull_field '.head.repo.full_name // ""')" == "NVIDIA/NemoClaw" ]] \
        || fail "exact-base E2E requires a same-repository PR"
      [[ "$CHECKOUT_SHA" == "$BASE_SHA" ]] \
        || fail "base checkout_sha must match the exact PR base SHA"
      [[ -n "$JOBS" || -n "$TARGETS" ]] \
        || fail "exact-base E2E requires the failed candidate selector"
      [[ ",${JOBS}," != *",native-runtime-qualification-producer,"* ]] \
        || fail "native runtime qualification evidence is candidate-only"
      [[ ",${JOBS}," != *",staging-brev-launchable,"* &&
        ",${JOBS}," != *",staging-brev-launchable-identity,"* ]] \
        || fail "exact-base E2E cannot select staging Launchable"
      [[ "$INCLUDE_LAUNCHABLE" != "true" &&
        "$ALLOW_JETSON_DISPATCH" != "true" &&
        "$ALLOW_DGX_SPARK_RUNNER_QUEUE" != "true" ]] \
        || fail "exact-base E2E cannot launch staging or dedicated hardware dispatches"
      ;;
  esac

  nvidia_owned=false
  if [[ "$(pull_field '.head.repo.owner.login // ""')" == "NVIDIA" &&
  "$(pull_field '.head.repo.owner.type // ""')" == "Organization" ]]; then
    nvidia_owned=true
  fi
  [[ ",${JOBS}," != *",staging-brev-launchable-identity,"* ]] \
    || fail "Launchable identity smoke runs only against trusted main"
  if [[ "$INCLUDE_LAUNCHABLE" == "true" || ",${JOBS}," == *",staging-brev-launchable,"* ]]; then
    [[ "$nvidia_owned" == "true" ]] \
      || fail "Launchable PR E2E requires an NVIDIA-owned source repository"
    [[ "$CHECKOUT_REPOSITORY" == "NVIDIA/NemoClaw" ]] \
      || fail "Launchable PR E2E requires a branch in NVIDIA/NemoClaw"
  fi
  printf 'nvidia_owned=%s\n' "$nvidia_owned" >>"$GITHUB_OUTPUT"
  printf 'pr_head_sha=%s\n' "$pr_head_sha" >>"$GITHUB_OUTPUT"
}

controller_matrix() {
  test_matrix='[]'
  case "${JOBS}:${TARGETS}" in
    :)
      matrix='[{"id":"ubuntu-policy-custom-missing-presets-negative","runner":"ubuntu-latest"},{"id":"ubuntu-repo-cloud-langchain-deepagents-code","runner":"ubuntu-latest"},{"id":"ubuntu-repo-cloud-openclaw","runner":"ubuntu-latest"},{"id":"ubuntu-repo-docker-post-reboot-recovery","runner":"ubuntu-latest"}]'
      test_matrix='[{"id":"onboard-managed-image-buildless-e2e","file":"test/onboarding/onboard-managed-image-buildless-e2e.test.ts","project":"integration"},{"id":"vllm-docker-storage","file":"test/platform/images/vllm-docker-storage.test.ts","project":"integration"}]'
      ;;
    inference-routing: | managed-image-protected-runtime: | native-runtime-qualification-producer: | :jetson-nvmap-gpu)
      matrix='[]'
      ;;
    :ubuntu-repo-cloud-langchain-deepagents-code)
      matrix='[{"id":"ubuntu-repo-cloud-langchain-deepagents-code","runner":"ubuntu-latest","label":"ubuntu-repo-cloud-langchain-deepagents-code"}]'
      ;;
    :ubuntu-repo-docker-post-reboot-recovery)
      matrix='[{"id":"ubuntu-repo-docker-post-reboot-recovery","runner":"ubuntu-latest","label":"ubuntu-repo-docker-post-reboot-recovery"}]'
      ;;
    :ubuntu-repo-cloud-langchain-deepagents-code,ubuntu-repo-docker-post-reboot-recovery)
      matrix='[{"id":"ubuntu-repo-cloud-langchain-deepagents-code","runner":"ubuntu-latest","label":"ubuntu-repo-cloud-langchain-deepagents-code"},{"id":"ubuntu-repo-docker-post-reboot-recovery","runner":"ubuntu-latest","label":"ubuntu-repo-docker-post-reboot-recovery"}]'
      ;;
    *) fail "PR E2E target is not approved by the trusted controller" ;;
  esac
  printf 'matrix=%s\n' "$matrix" >>"$GITHUB_OUTPUT"
  printf 'test_matrix=%s\n' "$test_matrix" >>"$GITHUB_OUTPUT"
}

validate_checkout() {
  : "${PR_HEAD_SHA:?PR_HEAD_SHA is required}"
  : "${NVIDIA_OWNED:?NVIDIA_OWNED is required}"
  [[ "$CHECKED_OUT_SHA" == "$CHECKOUT_SHA" ]] \
    || fail "checked-out commit does not match checkout_sha"
  [[ "$(pull_field '.state')" == "open" ]] || fail "pull request must still be open"
  [[ "$(pull_field '.base.repo.full_name // ""')" == "NVIDIA/NemoClaw" ]] \
    || fail "pull request base repository changed before execution"
  [[ "$(pull_field '.head.repo.full_name // ""')" == "$CHECKOUT_REPOSITORY" ]] \
    || fail "checkout_repository changed before execution"
  [[ "$(pull_field '.head.sha')" == "$PR_HEAD_SHA" ]] \
    || fail "PR head changed before execution"
  [[ "$(pull_field '.base.sha')" == "$BASE_SHA" ]] \
    || fail "base_sha changed before execution"
  case "$REVISION" in
    candidate)
      [[ "$CHECKOUT_SHA" == "$PR_HEAD_SHA" ]] \
        || fail "candidate checkout changed before execution"
      ;;
    base)
      [[ "$CHECKOUT_SHA" == "$BASE_SHA" ]] \
        || fail "exact base checkout changed before execution"
      ;;
    *) fail "revision changed before execution" ;;
  esac
  if [[ "$NVIDIA_OWNED" == "true" ]]; then
    [[ "$(pull_field '.head.repo.owner.login // ""')" == "NVIDIA" &&
    "$(pull_field '.head.repo.owner.type // ""')" == "Organization" ]] \
      || fail "PR source repository ownership changed before execution"
  fi
}

authorize_credentials() {
  credentials_allowed=false
  if [[ "$WORKFLOW_REPOSITORY" == "NVIDIA/NemoClaw" &&
    "$NVIDIA_OWNED" == "true" &&
    "$EVENT_NAME" == "workflow_dispatch" &&
    "$REF" == "refs/heads/main" &&
    "$CHECKOUT_SHA" =~ ^[a-f0-9]{40}$ &&
    "$WORKFLOW_SHA" =~ ^[a-f0-9]{40}$ &&
    "$EXPECTED_WORKFLOW_SHA" == "$WORKFLOW_SHA" &&
    "$CHECKED_OUT_SHA" == "$CHECKOUT_SHA" ]]; then
    credentials_allowed=true
  fi
  printf 'allowed=%s\n' "$credentials_allowed" >>"$GITHUB_OUTPUT"
}

case "${1:-}" in
  authenticate) authenticate ;;
  authorize-credentials) authorize_credentials ;;
  controller-matrix) controller_matrix ;;
  validate-checkout) validate_checkout ;;
  *) fail "manual PR dispatch command is invalid" ;;
esac
