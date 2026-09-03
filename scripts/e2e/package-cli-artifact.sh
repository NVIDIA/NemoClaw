#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
[[ "$CANDIDATE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || {
    echo "::error::candidate repository is invalid"
    exit 1
  }
[[ "$CANDIDATE_SHA" =~ ^[a-f0-9]{40}$ ]] \
  || {
    echo "::error::candidate SHA must be a lowercase 40-character SHA"
    exit 1
  }
[[ "$WORKFLOW_SHA" =~ ^[a-f0-9]{40}$ ]] \
  || {
    echo "::error::workflow SHA must be a lowercase 40-character SHA"
    exit 1
  }
[[ "$(git rev-parse --verify HEAD)" == "$CANDIDATE_SHA" ]] \
  || {
    echo "::error::checked-out commit does not match the artifact candidate SHA"
    exit 1
  }
[[ "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ && "$RUN_ID" =~ ^[1-9][0-9]*$ ]] \
  || {
    echo "::error::workflow run identity is invalid"
    exit 1
  }
for required_file in \
  dist/nemoclaw.js \
  dist/build-identity.json \
  dist/lib/blueprint-runner.js \
  dist/nemoclaw/package.json \
  dist/nemoclaw/blueprint/runner.js; do
  [[ -f "$required_file" && ! -L "$required_file" && -s "$required_file" ]] \
    || {
      echo "::error::candidate CLI build output is missing or is not a nonempty regular file: $required_file"
      exit 1
    }
done
for boundary in \
  openshell-gateway-health-sdk.js \
  openshell-observation-boundary.cjs \
  openshell-policy-boundary.cjs \
  sandbox-name.cjs \
  snapshot-sanitizer-boundary.cjs; do
  boundary_path="nemoclaw/dist/shared/$boundary"
  [[ -f "$boundary_path" && ! -L "$boundary_path" && -s "$boundary_path" ]] \
    || {
      echo "::error::candidate CLI build shared module is missing or is not a nonempty regular file: $boundary"
      exit 1
    }
done

jq -e --arg candidateSha "$CANDIDATE_SHA" '
  type == "object" and
  (keys | sort) == ["nemoclawVersion", "sourceRevision"] and
  (.nemoclawVersion | strings | length > 0) and
  .sourceRevision == $candidateSha
' dist/build-identity.json >/dev/null \
  || {
    echo "::error::candidate CLI build identity does not match the candidate commit SHA"
    exit 1
  }
jq -e '
  type == "object" and
  (keys | sort) == ["type"] and
  .type == "module"
' dist/nemoclaw/package.json >/dev/null \
  || {
    echo "::error::candidate Blueprint Runner module boundary is invalid"
    exit 1
  }

artifact_catalog="dist/e2e-managed-image-catalog.json"
[[ ! -e "$artifact_catalog" && ! -L "$artifact_catalog" ]] || {
  echo "::error::candidate build created the managed-image catalog path" >&2
  exit 1
}
managed_catalog="${RUNNER_TEMP}/pr-managed-image-catalog.json"
catalog_json="${MANAGED_IMAGE_CATALOG:-}"
catalog_sha256="${MANAGED_IMAGE_CATALOG_SHA256:-}"
if [[ -n "$catalog_json" ]]; then
  [[ "$catalog_sha256" =~ ^[a-f0-9]{64}$ ]] || {
    echo "::error::trusted PR managed-image catalog digest is invalid" >&2
    exit 1
  }
  [[ -f "$managed_catalog" && ! -L "$managed_catalog" && -s "$managed_catalog" ]] || {
    echo "::error::trusted PR managed-image catalog is not a nonempty regular file" >&2
    exit 1
  }
  [[ "$(sha256sum "$managed_catalog" | awk '{print $1}')" == "$catalog_sha256" ]] || {
    echo "::error::trusted PR managed-image catalog changed after authentication" >&2
    exit 1
  }
  (umask 077 && set -o noclobber && printf '%s\n' "$catalog_json" >"$artifact_catalog")
  [[ -f "$artifact_catalog" && ! -L "$artifact_catalog" && -s "$artifact_catalog" ]] || {
    echo "::error::packaged PR managed-image catalog is invalid" >&2
    exit 1
  }
  [[ "$(sha256sum "$artifact_catalog" | awk '{print $1}')" == "$catalog_sha256" ]] || {
    echo "::error::packaged PR managed-image catalog does not match trusted output" >&2
    exit 1
  }
else
  [[ -z "$catalog_sha256" && ! -e "$managed_catalog" && ! -L "$managed_catalog" ]] || {
    echo "::error::managed-image catalog authority is inconsistent" >&2
    exit 1
  }
fi

artifact_dir="${RUNNER_TEMP}/nemoclaw-cli-artifact"
install -d -m 0700 "$artifact_dir"
payload="$artifact_dir/nemoclaw-cli.tar"
manifest="$artifact_dir/manifest.json"
tar \
  --sort=name \
  --mtime=@0 \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -cf "$payload" \
  dist \
  nemoclaw/dist/shared
payload_sha256="$(sha256sum "$payload" | awk '{print $1}')"
source_tree="$(git rev-parse 'HEAD^{tree}')"
lockfile_sha256="$(sha256sum package-lock.json | awk '{print $1}')"
node_version="$(node --version)"
npm_version="$(npm --version)"
artifact_name="nemoclaw-cli-${CANDIDATE_SHA}-${payload_sha256}"

jq -n \
  --arg artifactName "$artifact_name" \
  --arg buildCommand "npm run build:cli" \
  --arg candidateRepository "$CANDIDATE_REPOSITORY" \
  --arg candidateSha "$CANDIDATE_SHA" \
  --arg lockfileSha256 "$lockfile_sha256" \
  --arg nodeVersion "$node_version" \
  --arg npmVersion "$npm_version" \
  --arg payloadFile "nemoclaw-cli.tar" \
  --arg payloadSha256 "$payload_sha256" \
  --arg runAttempt "$RUN_ATTEMPT" \
  --arg runId "$RUN_ID" \
  --arg runnerArch "$RUNNER_ARCH" \
  --arg runnerOs "$RUNNER_OS" \
  --arg sourceTree "$source_tree" \
  --arg workflowSha "$WORKFLOW_SHA" \
  '{
    kind: "nemoclaw-e2e-cli-artifact-v1",
    artifactName: $artifactName,
    candidate: {
      repository: $candidateRepository,
      sha: $candidateSha,
      sourceTree: $sourceTree,
      lockfileSha256: $lockfileSha256
    },
    workflow: {
      sha: $workflowSha,
      runId: $runId,
      runAttempt: $runAttempt
    },
    toolchain: {
      node: $nodeVersion,
      npm: $npmVersion,
      runnerOs: $runnerOs,
      runnerArch: $runnerArch
    },
    build: {
      command: $buildCommand,
      sourceRevision: $candidateSha
    },
    payload: {
      file: $payloadFile,
      sha256: $payloadSha256
    }
  }' >"$manifest"
chmod 0600 "$manifest" "$payload"
{
  printf 'artifact_name=%s\n' "$artifact_name"
  printf 'candidate_sha=%s\n' "$CANDIDATE_SHA"
  printf 'payload_sha256=%s\n' "$payload_sha256"
} >>"$GITHUB_OUTPUT"
