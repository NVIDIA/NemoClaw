#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

jq -e '
  type == "object" and
  (keys | sort) == [
    "artifactDigest",
    "artifactId",
    "artifactName",
    "candidateRepository",
    "candidateSha",
    "kind",
    "payloadSha256",
    "runAttempt",
    "runId",
    "workflowSha"
  ] and
  .kind == "nemoclaw-e2e-cli-provenance-v1" and
  (.artifactId | strings | test("^[1-9][0-9]*$")) and
  (.artifactDigest | strings | test("^[a-f0-9]{64}$")) and
  (.artifactName | strings) and
  (.candidateRepository | strings | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) and
  (.candidateSha | strings | test("^[a-f0-9]{40}$")) and
  (.payloadSha256 | strings | test("^[a-f0-9]{64}$")) and
  (.workflowSha | strings | test("^[a-f0-9]{40}$")) and
  (.runId | strings | test("^[1-9][0-9]*$")) and
  (.runAttempt | strings | test("^[1-9][0-9]*$")) and
  .artifactName == ("nemoclaw-cli-" + .candidateSha + "-" + .payloadSha256)
' <<<"$PROVENANCE_JSON" >/dev/null \
  || {
    echo "::error::producer CLI artifact provenance is invalid"
    exit 1
  }

candidate_repository="$(jq -r '.candidateRepository' <<<"$PROVENANCE_JSON")"
candidate_sha="$(jq -r '.candidateSha' <<<"$PROVENANCE_JSON")"
run_attempt="$(jq -r '.runAttempt' <<<"$PROVENANCE_JSON")"
run_id="$(jq -r '.runId' <<<"$PROVENANCE_JSON")"
workflow_sha="$(jq -r '.workflowSha' <<<"$PROVENANCE_JSON")"
[[ "$(git rev-parse --verify HEAD)" == "$candidate_sha" ]] \
  || {
    echo "::error::consumer checkout does not match the producer candidate SHA"
    exit 1
  }
[[ "$workflow_sha" == "$CALLER_WORKFLOW_SHA" ]] \
  || {
    echo "::error::consumer and producer workflow SHAs differ"
    exit 1
  }
[[ "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] \
  || {
    echo "::error::consumer workflow run attempt is invalid"
    exit 1
  }
[[ "$run_id" == "$GITHUB_RUN_ID" ]] \
  || {
    echo "::error::consumer and producer workflow run IDs differ"
    exit 1
  }
((run_attempt <= GITHUB_RUN_ATTEMPT)) \
  || {
    echo "::error::producer workflow attempt is newer than the consumer attempt"
    exit 1
  }

remote_url="$(git remote get-url origin)"
case "$remote_url" in
  https://github.com/*) remote_repository="${remote_url#https://github.com/}" ;;
  git@github.com:*) remote_repository="${remote_url#git@github.com:}" ;;
  *)
    echo "::error::consumer checkout repository URL is invalid"
    exit 1
    ;;
esac
remote_repository="${remote_repository%.git}"
[[ "$remote_repository" == "$candidate_repository" ]] \
  || {
    echo "::error::consumer checkout repository does not match producer provenance"
    exit 1
  }

jq -r '
  "artifact_digest=" + .artifactDigest,
  "artifact_id=" + .artifactId,
  "artifact_name=" + .artifactName,
  "candidate_repository=" + .candidateRepository,
  "candidate_sha=" + .candidateSha,
  "payload_sha256=" + .payloadSha256,
  "producer_run_attempt=" + .runAttempt,
  "run_attempt=" + .runAttempt,
  "run_id=" + .runId,
  "workflow_sha=" + .workflowSha
' <<<"$PROVENANCE_JSON" >>"$GITHUB_OUTPUT"
printf 'consumer_run_attempt=%s\n' "$GITHUB_RUN_ATTEMPT" >>"$GITHUB_OUTPUT"
