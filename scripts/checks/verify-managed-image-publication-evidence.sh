#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: verify-managed-image-publication-evidence.sh \
  --reference IMAGE@sha256:DIGEST \
  --digest sha256:DIGEST \
  --platform linux/amd64|linux/arm64 \
  --agent openclaw|hermes|langchain-deepagents-code \
  --base-reference IMAGE@sha256:DIGEST \
  --repository OWNER/REPOSITORY \
  --revision GIT_SHA \
  --cohort ghrun-RUN_ID-RUN_ATTEMPT \
  --run-id RUN_ID \
  --run-attempt RUN_ATTEMPT \
  --output PATH
USAGE
  exit 64
}

reference=""
expected_digest=""
platform=""
agent=""
base_reference=""
repository=""
revision=""
cohort=""
run_id=""
run_attempt=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --reference)
      [ "$#" -ge 2 ] || usage
      reference="$2"
      shift 2
      ;;
    --digest)
      [ "$#" -ge 2 ] || usage
      expected_digest="$2"
      shift 2
      ;;
    --platform)
      [ "$#" -ge 2 ] || usage
      platform="$2"
      shift 2
      ;;
    --agent)
      [ "$#" -ge 2 ] || usage
      agent="$2"
      shift 2
      ;;
    --base-reference)
      [ "$#" -ge 2 ] || usage
      base_reference="$2"
      shift 2
      ;;
    --repository)
      [ "$#" -ge 2 ] || usage
      repository="$2"
      shift 2
      ;;
    --revision)
      [ "$#" -ge 2 ] || usage
      revision="$2"
      shift 2
      ;;
    --cohort)
      [ "$#" -ge 2 ] || usage
      cohort="$2"
      shift 2
      ;;
    --run-id)
      [ "$#" -ge 2 ] || usage
      run_id="$2"
      shift 2
      ;;
    --run-attempt)
      [ "$#" -ge 2 ] || usage
      run_attempt="$2"
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || usage
      output="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

if [[ ! "$expected_digest" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || [[ ! "$reference" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
  || [ "$reference" != "${reference%@*}@${expected_digest}" ] \
  || [[ ! "$platform" =~ ^linux/(amd64|arm64)$ ]] \
  || [[ ! "$agent" =~ ^(openclaw|hermes|langchain-deepagents-code)$ ]] \
  || [[ ! "$base_reference" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
  || [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]] \
  || [[ ! "$run_id" =~ ^[1-9][0-9]{0,19}$ ]] \
  || [[ ! "$run_attempt" =~ ^[1-9][0-9]{0,9}$ ]] \
  || [ "$cohort" != "ghrun-${run_id}-${run_attempt}" ] \
  || [ -z "$output" ]; then
  echo "ERROR: managed image evidence identity is invalid." >&2
  exit 1
fi

output_parent="$(dirname "$output")"
if [ -L "$output_parent" ] || { [ -e "$output_parent" ] && [ ! -d "$output_parent" ]; }; then
  echo "ERROR: managed image evidence output parent is unsafe." >&2
  exit 1
fi
install -d -m 0700 "$output_parent"
if [ -L "$output" ] || { [ -e "$output" ] && [ ! -f "$output" ]; }; then
  echo "ERROR: managed image evidence output is unsafe." >&2
  exit 1
fi

temporary_root="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/managed-image-evidence-XXXXXX")"
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

candidate_raw="$temporary_root/candidate-index.raw"
workload_raw="$temporary_root/workload-manifest.raw"
attestation_raw="$temporary_root/attestation-manifest.raw"
slsa_statement="$temporary_root/slsa-statement.json"
spdx_statement="$temporary_root/spdx-statement.json"

digest_file() {
  printf 'sha256:%s' "$(sha256sum "$1" | awk '{print $1}')"
}

size_file() {
  wc -c <"$1" | tr -d '[:space:]'
}

descriptor_matches_file() {
  local descriptor="$1"
  local file="$2"
  [ "$(jq -er '.digest' "$descriptor")" = "$(digest_file "$file")" ] \
    && [ "$(jq -er '.size | tostring' "$descriptor")" = "$(size_file "$file")" ]
}

docker buildx imagetools inspect "$reference" --raw >"$candidate_raw"
candidate_size="$(size_file "$candidate_raw")"
candidate_digest="$(digest_file "$candidate_raw")"
if [ "$candidate_digest" != "$expected_digest" ] \
  || [[ ! "$candidate_size" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: candidate index bytes do not match the immutable build digest." >&2
  exit 1
fi

architecture="${platform#linux/}"
if ! jq -e \
  --arg architecture "$architecture" \
  '
    (keys | sort) == ["manifests", "mediaType", "schemaVersion"]
    and .schemaVersion == 2
    and .mediaType == "application/vnd.oci.image.index.v1+json"
    and (.manifests | length) == 2
    and ([
      .manifests[]
      | select(.platform == {os: "linux", architecture: $architecture})
    ] | length) == 1
    and ([
      .manifests[]
      | select(
          .platform == {os: "unknown", architecture: "unknown"}
          and .annotations["vnd.docker.reference.type"] == "attestation-manifest"
        )
    ] | length) == 1
  ' "$candidate_raw" >/dev/null; then
  echo "ERROR: candidate index is not one workload plus one attestation manifest." >&2
  exit 1
fi

workload_descriptor="$temporary_root/workload-descriptor.json"
attestation_descriptor="$temporary_root/attestation-descriptor.json"
jq -ce \
  --arg architecture "$architecture" \
  '
    .manifests
    | map(select(.platform == {os: "linux", architecture: $architecture}))
    | if length == 1 then .[0] else error("not one workload descriptor") end
  ' "$candidate_raw" >"$workload_descriptor"
jq -ce '
  .manifests
  | map(select(
      .platform == {os: "unknown", architecture: "unknown"}
      and .annotations["vnd.docker.reference.type"] == "attestation-manifest"
    ))
  | if length == 1 then .[0] else error("not one attestation descriptor") end
' "$candidate_raw" >"$attestation_descriptor"

if ! jq -e '
  (keys | sort) == ["digest", "mediaType", "platform", "size"]
  and .mediaType == "application/vnd.oci.image.manifest.v1+json"
  and (.digest | test("^sha256:[0-9a-f]{64}$"))
  and (.size | type) == "number" and .size > 0 and (.size | floor) == .size
' "$workload_descriptor" >/dev/null; then
  echo "ERROR: workload descriptor is malformed." >&2
  exit 1
fi
workload_digest="$(jq -er '.digest' "$workload_descriptor")"
if ! jq -e \
  --arg workload_digest "$workload_digest" \
  '
    (keys | sort) == ["annotations", "digest", "mediaType", "platform", "size"]
    and .mediaType == "application/vnd.oci.image.manifest.v1+json"
    and (.digest | test("^sha256:[0-9a-f]{64}$"))
    and (.size | type) == "number" and .size > 0 and (.size | floor) == .size
    and (.annotations | keys | sort) == [
      "vnd.docker.reference.digest",
      "vnd.docker.reference.type"
    ]
    and .annotations["vnd.docker.reference.digest"] == $workload_digest
    and .annotations["vnd.docker.reference.type"] == "attestation-manifest"
  ' "$attestation_descriptor" >/dev/null; then
  echo "ERROR: attestation manifest descriptor is not bound to the workload." >&2
  exit 1
fi

image="${reference%@*}"
workload_reference="${image}@${workload_digest}"
docker buildx imagetools inspect "$workload_reference" --raw >"$workload_raw"
if ! descriptor_matches_file "$workload_descriptor" "$workload_raw"; then
  echo "ERROR: workload manifest bytes do not match their candidate descriptor." >&2
  exit 1
fi

attestation_digest="$(jq -er '.digest' "$attestation_descriptor")"
attestation_reference="${image}@${attestation_digest}"
docker buildx imagetools inspect "$attestation_reference" --raw >"$attestation_raw"
if ! descriptor_matches_file "$attestation_descriptor" "$attestation_raw"; then
  echo "ERROR: attestation manifest bytes do not match their candidate descriptor." >&2
  exit 1
fi

if ! jq -e '
  (keys | sort) == ["config", "layers", "mediaType", "schemaVersion"]
  and .schemaVersion == 2
  and .mediaType == "application/vnd.oci.image.manifest.v1+json"
  and (.config | keys | sort) == ["digest", "mediaType", "size"]
  and .config.mediaType == "application/vnd.oci.image.config.v1+json"
  and (.config.digest | test("^sha256:[0-9a-f]{64}$"))
  and (.config.size | type) == "number" and .config.size > 0
  and (.config.size | floor) == .config.size
  and (.layers | length) == 2
  and all(.layers[];
    (keys | sort) == ["annotations", "digest", "mediaType", "size"]
    and .mediaType == "application/vnd.in-toto+json"
    and (.digest | test("^sha256:[0-9a-f]{64}$"))
    and (.size | type) == "number" and .size > 0
    and (.size | floor) == .size
    and (.annotations | keys) == ["in-toto.io/predicate-type"]
  )
' "$attestation_raw" >/dev/null; then
  echo "ERROR: attestation manifest does not contain exactly two in-toto statements." >&2
  exit 1
fi

slsa_descriptor="$temporary_root/slsa-descriptor.json"
spdx_descriptor="$temporary_root/spdx-descriptor.json"
jq -ce '
  .layers
  | map(select(.annotations["in-toto.io/predicate-type"] == "https://slsa.dev/provenance/v1"))
  | if length == 1 then .[0] else error("not one SLSA provenance descriptor") end
' "$attestation_raw" >"$slsa_descriptor"
jq -ce '
  .layers
  | map(select(.annotations["in-toto.io/predicate-type"] == "https://spdx.dev/Document"))
  | if length == 1 then .[0] else error("not one SPDX descriptor") end
' "$attestation_raw" >"$spdx_descriptor"

registry="${image%%/*}"
registry_repository="${image#*/}"
if [ "$registry" != "ghcr.io" ] \
  || [[ ! "$registry_repository" =~ ^[a-z0-9._/-]+$ ]]; then
  echo "ERROR: managed image evidence registry is unsupported." >&2
  exit 1
fi
registry_token="$({
  curl --fail --silent --show-error --location --retry 3 \
    "https://${registry}/token?service=${registry}&scope=repository:${registry_repository}:pull"
} | jq -er '.token | select(type == "string" and length > 0)')"
fetch_statement() {
  local descriptor="$1"
  local destination="$2"
  local statement_digest
  statement_digest="$(jq -er '.digest' "$descriptor")"
  curl --fail --silent --show-error --location --retry 3 \
    -H "Authorization: Bearer ${registry_token}" \
    "https://${registry}/v2/${registry_repository}/blobs/${statement_digest}" \
    --output "$destination"
  descriptor_matches_file "$descriptor" "$destination"
}
if ! fetch_statement "$slsa_descriptor" "$slsa_statement"; then
  echo "ERROR: SLSA statement blob does not match its attestation descriptor." >&2
  exit 1
fi
if ! fetch_statement "$spdx_descriptor" "$spdx_statement"; then
  echo "ERROR: SPDX statement blob does not match its attestation descriptor." >&2
  exit 1
fi

workload_sha256="${workload_digest#sha256:}"
base_sha256="${base_reference##*@sha256:}"
base_repository="${base_reference%@sha256:*}"
base_dependency_uri="pkg:docker/${base_repository}?digest=sha256:${base_sha256}&platform=${platform//\//%2F}"
source_url="https://github.com/${repository}"
builder_id="${source_url}/actions/runs/${run_id}/attempts/${run_attempt}"
if ! jq -e \
  --arg agent "$agent" \
  --arg base_reference "$base_reference" \
  --arg base_dependency_uri "$base_dependency_uri" \
  --arg base_sha256 "$base_sha256" \
  --arg builder_id "$builder_id" \
  --arg cohort "$cohort" \
  --arg platform "$platform" \
  --arg revision "$revision" \
  --arg source_url "$source_url" \
  --arg workload_sha256 "$workload_sha256" \
  '
    def request_args: .predicate.buildDefinition.externalParameters.request.args;
    def root_args: .predicate.buildDefinition.externalParameters.request.root.request.args;
    (keys | sort) == ["_type", "predicate", "predicateType", "subject"]
    and ._type == "https://in-toto.io/Statement/v1"
    and .predicateType == "https://slsa.dev/provenance/v1"
    and (.subject | length) == 1
    and (.subject[0] | keys | sort) == ["digest", "name"]
    and (.subject[0].name | type) == "string" and (.subject[0].name | length) > 0
    and .subject[0].digest == {sha256: $workload_sha256}
    and (.predicate | keys | sort) == ["buildDefinition", "runDetails"]
    and (.predicate.buildDefinition | keys | sort) == [
      "buildType",
      "externalParameters",
      "internalParameters",
      "resolvedDependencies"
    ]
    and .predicate.buildDefinition.buildType ==
      "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md"
    and (.predicate.buildDefinition.externalParameters | type) == "object"
    and (request_args | type) == "object"
    and request_args["build-arg:BASE_IMAGE"] == $base_reference
    and request_args["label:io.nvidia.nemoclaw.agent"] == $agent
    and request_args["label:io.nvidia.nemoclaw.managed-image.cohort"] == $cohort
    and request_args["label:io.nvidia.nemoclaw.managed-image.contract"] == "1"
    and request_args["label:io.nvidia.nemoclaw.managed-image.platform"] == $platform
    and request_args["label:org.opencontainers.image.revision"] == $revision
    and request_args["label:org.opencontainers.image.source"] == $source_url
    and (root_args | type) == "object"
    and root_args["build-arg:BASE_IMAGE"] == $base_reference
    and root_args["label:io.nvidia.nemoclaw.agent"] == $agent
    and root_args["label:io.nvidia.nemoclaw.managed-image.cohort"] == $cohort
    and root_args["label:io.nvidia.nemoclaw.managed-image.contract"] == "1"
    and root_args["label:io.nvidia.nemoclaw.managed-image.platform"] == $platform
    and root_args["label:org.opencontainers.image.revision"] == $revision
    and root_args["label:org.opencontainers.image.source"] == $source_url
    and root_args["vcs:revision"] == $revision
    and root_args["vcs:source"] == $source_url
    and (.predicate.buildDefinition.internalParameters | type) == "object"
    and (.predicate.buildDefinition.resolvedDependencies | type) == "array"
    and ([
      .predicate.buildDefinition.resolvedDependencies[]
      | select(
          .digest == {sha256: $base_sha256}
          and .uri == $base_dependency_uri
        )
    ] | length) == 1
    and (.predicate.runDetails | keys | sort) == ["builder", "metadata"]
    and (.predicate.runDetails.builder | type) == "object"
    and .predicate.runDetails.builder.id == $builder_id
    and (.predicate.runDetails.metadata | type) == "object"
  ' "$slsa_statement" >/dev/null; then
  echo "ERROR: SLSA v1 statement does not bind the exact managed image build identity." >&2
  exit 1
fi

if ! jq -e \
  --arg workload_sha256 "$workload_sha256" \
  '
    (keys | sort) == ["_type", "predicate", "predicateType", "subject"]
    and ._type == "https://in-toto.io/Statement/v1"
    and .predicateType == "https://spdx.dev/Document"
    and (.subject | length) == 1
    and (.subject[0] | keys | sort) == ["digest", "name"]
    and (.subject[0].name | type) == "string" and (.subject[0].name | length) > 0
    and .subject[0].digest == {sha256: $workload_sha256}
    and (.predicate | type) == "object"
    and .predicate.SPDXID == "SPDXRef-DOCUMENT"
    and (.predicate.spdxVersion == "SPDX-2.2" or .predicate.spdxVersion == "SPDX-2.3")
    and .predicate.dataLicense == "CC0-1.0"
    and (.predicate.documentNamespace | type) == "string"
    and (.predicate.documentNamespace | length) > 0
    and (.predicate.creationInfo | type) == "object"
    and (.predicate.creationInfo.creators | type) == "array"
    and (.predicate.creationInfo.creators | length) > 0
  ' "$spdx_statement" >/dev/null; then
  echo "ERROR: SPDX statement does not bind the exact managed image workload." >&2
  exit 1
fi

slsa_summary="$temporary_root/slsa-summary.json"
spdx_summary="$temporary_root/spdx-summary.json"
jq -ce '
  {
    type: ._type,
    predicateType,
    subject: {
      name: .subject[0].name,
      digest: ("sha256:" + .subject[0].digest.sha256)
    },
    buildType: .predicate.buildDefinition.buildType,
    builderId: .predicate.runDetails.builder.id,
    bindings: {
      agent: .predicate.buildDefinition.externalParameters.request.args[
        "label:io.nvidia.nemoclaw.agent"
      ],
      baseReference: .predicate.buildDefinition.externalParameters.request.args[
        "build-arg:BASE_IMAGE"
      ],
      cohort: .predicate.buildDefinition.externalParameters.request.args[
        "label:io.nvidia.nemoclaw.managed-image.cohort"
      ],
      platform: .predicate.buildDefinition.externalParameters.request.args[
        "label:io.nvidia.nemoclaw.managed-image.platform"
      ],
      revision: .predicate.buildDefinition.externalParameters.request.args[
        "label:org.opencontainers.image.revision"
      ],
      source: .predicate.buildDefinition.externalParameters.request.args[
        "label:org.opencontainers.image.source"
      ]
    }
  }
' "$slsa_statement" >"$slsa_summary"
jq -ce '
  {
    type: ._type,
    predicateType,
    subject: {
      name: .subject[0].name,
      digest: ("sha256:" + .subject[0].digest.sha256)
    }
  }
' "$spdx_statement" >"$spdx_summary"

temporary_output="$temporary_root/publication-evidence.json"
jq -n \
  --arg candidateDigest "$candidate_digest" \
  --argjson candidateSize "$candidate_size" \
  --arg candidateMediaType "application/vnd.oci.image.index.v1+json" \
  --slurpfile workload "$workload_descriptor" \
  --slurpfile attestation "$attestation_descriptor" \
  --slurpfile slsaDescriptor "$slsa_descriptor" \
  --slurpfile slsaStatement "$slsa_summary" \
  --slurpfile spdxDescriptor "$spdx_descriptor" \
  --slurpfile spdxStatement "$spdx_summary" \
  '{
    candidateDescriptor: {
      mediaType: $candidateMediaType,
      digest: $candidateDigest,
      size: $candidateSize
    },
    workloadDescriptor: $workload[0],
    attestations: {
      manifestDescriptor: $attestation[0],
      slsa: {
        descriptor: $slsaDescriptor[0],
        statement: $slsaStatement[0]
      },
      spdx: {
        descriptor: $spdxDescriptor[0],
        statement: $spdxStatement[0]
      }
    }
  }' >"$temporary_output"

chmod 0600 "$temporary_output"
mv -f "$temporary_output" "$output"
