#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

artifact_dir="${RUNNER_TEMP}/nemoclaw-cli-artifact"
manifest="$artifact_dir/manifest.json"
payload="$artifact_dir/nemoclaw-cli.tar"
if [[ ! -s "$manifest" || ! -s "$payload" ]]; then
  echo "::error::exact-commit CLI artifact is incomplete"
  exit 1
fi
[[ "$(node --version)" =~ ^v22\.[0-9]+\.[0-9]+$ ]] \
  || {
    echo "::error::consumer must restore the CLI under the pinned Node 22 toolchain"
    exit 1
  }

sha256_file() {
  node --input-type=module --eval '
    import { createHash } from "node:crypto";
    import { createReadStream } from "node:fs";
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(process.argv[1])) hash.update(chunk);
    process.stdout.write(hash.digest("hex"));
  ' "$1"
}

source_tree="$(git rev-parse 'HEAD^{tree}')"
lockfile_sha256="$(sha256_file package-lock.json)"
jq -e \
  --arg artifactName "$ARTIFACT_NAME" \
  --arg candidateRepository "$CANDIDATE_REPOSITORY" \
  --arg candidateSha "$CANDIDATE_SHA" \
  --arg lockfileSha256 "$lockfile_sha256" \
  --arg payloadSha256 "$PAYLOAD_SHA256" \
  --arg runAttempt "$PRODUCER_RUN_ATTEMPT" \
  --arg runId "$RUN_ID" \
  --arg sourceTree "$source_tree" \
  --arg workflowSha "$WORKFLOW_SHA" \
  '
    .kind == "nemoclaw-e2e-cli-artifact-v1" and
    .artifactName == $artifactName and
    .candidate.repository == $candidateRepository and
    .candidate.sha == $candidateSha and
    .candidate.sourceTree == $sourceTree and
    .candidate.lockfileSha256 == $lockfileSha256 and
    .workflow.sha == $workflowSha and
    .workflow.runId == $runId and
    .workflow.runAttempt == $runAttempt and
    (.toolchain.node | strings | test("^v22\\.[0-9]+\\.[0-9]+$")) and
    (.toolchain.npm | strings | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    .toolchain.runnerOs == "Linux" and
    .toolchain.runnerArch == "X64" and
    .build.command == "npm run build:cli" and
    .build.sourceRevision == $candidateSha and
    .payload.file == "nemoclaw-cli.tar" and
    .payload.sha256 == $payloadSha256
  ' "$manifest" >/dev/null \
  || {
    echo "::error::exact-commit CLI artifact provenance mismatch"
    exit 1
  }
actual_payload_sha256="$(sha256_file "$payload")"
[[ "$actual_payload_sha256" == "$PAYLOAD_SHA256" ]] \
  || {
    echo "::error::exact-commit CLI artifact payload digest mismatch"
    exit 1
  }
while IFS= read -r member; do
  case "$member" in
    dist | dist/* | nemoclaw/dist/shared | nemoclaw/dist/shared/*) ;;
    *)
      echo "::error::CLI artifact contains an unsafe member: $member"
      exit 1
      ;;
  esac
  case "/$member/" in
    *"/../"* | *"/./"*)
      echo "::error::CLI artifact contains traversal: $member"
      exit 1
      ;;
  esac
done < <(tar -tf "$payload")
tar -tvf "$payload" \
  | awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }' \
  || {
    echo "::error::CLI artifact contains a link or special file"
    exit 1
  }
[[ ! -e "$GITHUB_WORKSPACE/dist" && ! -L "$GITHUB_WORKSPACE/dist" ]] \
  || {
    echo "::error::consumer unexpectedly built dist before artifact restore"
    exit 1
  }
[[ -d "$GITHUB_WORKSPACE/nemoclaw" && ! -L "$GITHUB_WORKSPACE/nemoclaw" ]] \
  || {
    echo "::error::consumer nemoclaw directory must be a non-symlink directory"
    exit 1
  }
[[ ! -e "$GITHUB_WORKSPACE/nemoclaw/dist" && ! -L "$GITHUB_WORKSPACE/nemoclaw/dist" ]] \
  || {
    echo "::error::consumer unexpectedly built nemoclaw/dist before artifact restore"
    exit 1
  }
restore_dir="$(mktemp -d "${RUNNER_TEMP}/nemoclaw-cli-restore.XXXXXX")"
trap 'rm -rf -- "$restore_dir"' EXIT
tar --no-same-owner --no-same-permissions -xf "$payload" -C "$restore_dir"
cli_entrypoint="$restore_dir/dist/nemoclaw.js"
[[ -f "$cli_entrypoint" && ! -L "$cli_entrypoint" && -s "$cli_entrypoint" ]] \
  || {
    echo "::error::restored CLI artifact entry point is missing or is not a nonempty regular file"
    exit 1
  }
for boundary in \
  openshell-gateway-health-sdk.js \
  openshell-observation-boundary.cjs \
  openshell-policy-boundary.cjs \
  sandbox-name.cjs \
  snapshot-sanitizer-boundary.cjs; do
  boundary_path="$restore_dir/nemoclaw/dist/shared/$boundary"
  [[ -f "$boundary_path" && ! -L "$boundary_path" && -s "$boundary_path" ]] \
    || {
      echo "::error::restored CLI artifact shared module is missing or is not a nonempty regular file: $boundary"
      exit 1
    }
done
jq -e --arg candidateSha "$CANDIDATE_SHA" '
  type == "object" and
  (keys | sort) == ["nemoclawVersion", "sourceRevision"] and
  (.nemoclawVersion | strings | length > 0) and
  .sourceRevision == $candidateSha
' "$restore_dir/dist/build-identity.json" >/dev/null \
  || {
    echo "::error::restored CLI build identity does not match the candidate SHA"
    exit 1
  }
mv "$restore_dir/nemoclaw/dist" "$GITHUB_WORKSPACE/nemoclaw/dist"
mv "$restore_dir/dist" "$GITHUB_WORKSPACE/dist"
node "$GITHUB_WORKSPACE/bin/nemoclaw.js" --version >/dev/null
