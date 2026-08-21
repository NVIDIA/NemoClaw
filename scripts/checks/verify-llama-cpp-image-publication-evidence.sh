#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  printf '%s\n' "Usage: $0 --reference IMAGE@DIGEST --candidate-index PATH --platform-digests PATH --anonymous-pull-amd64 PATH --anonymous-pull-arm64 PATH --sbom-amd64 PATH --sbom-arm64 PATH --sbom-verification PATH --provenance-verification PATH --signature-verification PATH --scan-amd64 PATH --scan-arm64 PATH --repository OWNER/REPOSITORY --revision GIT_SHA --source-revision GIT_SHA --source-archive-sha256 DIGEST --cuda-development-base IMAGE@DIGEST --cuda-runtime-base IMAGE@DIGEST --run-id ID --run-attempt ATTEMPT --certificate-identity IDENTITY --certificate-oidc-issuer ISSUER --output PATH" >&2
  exit 64
}

reference=""
candidate_index=""
platform_digests=""
anonymous_pull_amd64=""
anonymous_pull_arm64=""
sbom_amd64=""
sbom_arm64=""
sbom_verification=""
provenance_verification=""
signature_verification=""
scan_amd64=""
scan_arm64=""
repository=""
revision=""
source_revision=""
source_archive_sha256=""
cuda_development_base=""
cuda_runtime_base=""
run_id=""
run_attempt=""
certificate_identity=""
certificate_oidc_issuer=""
output=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --reference)
      reference="${2:-}"
      shift 2
      ;;
    --candidate-index)
      candidate_index="${2:-}"
      shift 2
      ;;
    --platform-digests)
      platform_digests="${2:-}"
      shift 2
      ;;
    --anonymous-pull-amd64)
      anonymous_pull_amd64="${2:-}"
      shift 2
      ;;
    --anonymous-pull-arm64)
      anonymous_pull_arm64="${2:-}"
      shift 2
      ;;
    --sbom-amd64)
      sbom_amd64="${2:-}"
      shift 2
      ;;
    --sbom-arm64)
      sbom_arm64="${2:-}"
      shift 2
      ;;
    --sbom-verification)
      sbom_verification="${2:-}"
      shift 2
      ;;
    --provenance-verification)
      provenance_verification="${2:-}"
      shift 2
      ;;
    --signature-verification)
      signature_verification="${2:-}"
      shift 2
      ;;
    --scan-amd64)
      scan_amd64="${2:-}"
      shift 2
      ;;
    --scan-arm64)
      scan_arm64="${2:-}"
      shift 2
      ;;
    --repository)
      repository="${2:-}"
      shift 2
      ;;
    --revision)
      revision="${2:-}"
      shift 2
      ;;
    --source-revision)
      source_revision="${2:-}"
      shift 2
      ;;
    --source-archive-sha256)
      source_archive_sha256="${2:-}"
      shift 2
      ;;
    --cuda-development-base)
      cuda_development_base="${2:-}"
      shift 2
      ;;
    --cuda-runtime-base)
      cuda_runtime_base="${2:-}"
      shift 2
      ;;
    --run-id)
      run_id="${2:-}"
      shift 2
      ;;
    --run-attempt)
      run_attempt="${2:-}"
      shift 2
      ;;
    --certificate-identity)
      certificate_identity="${2:-}"
      shift 2
      ;;
    --certificate-oidc-issuer)
      certificate_oidc_issuer="${2:-}"
      shift 2
      ;;
    --output)
      output="${2:-}"
      shift 2
      ;;
    *) usage ;;
  esac
done

digest_pattern='sha256:[0-9a-f]{64}'
owned_image='ghcr.io/nvidia/nemoclaw/llama-cpp-server'
image="${reference%@*}"
reference_digest="${reference##*@}"
if [[ ! "$reference" =~ ^ghcr\.io/nvidia/nemoclaw/llama-cpp-server@${digest_pattern}$ ]] \
  || [ "$image" != "$owned_image" ] \
  || [ "$repository" != "NVIDIA/NemoClaw" ] \
  || [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]] \
  || [[ ! "$source_revision" =~ ^[0-9a-f]{40}$ ]] \
  || [[ ! "$source_archive_sha256" =~ ^${digest_pattern}$ ]] \
  || [[ ! "$cuda_development_base" =~ ^docker\.io/nvidia/cuda@${digest_pattern}$ ]] \
  || [[ ! "$cuda_runtime_base" =~ ^docker\.io/nvidia/cuda@${digest_pattern}$ ]] \
  || [[ ! "$run_id" =~ ^[1-9][0-9]{0,19}$ ]] \
  || [[ ! "$run_attempt" =~ ^[1-9][0-9]{0,9}$ ]] \
  || [ "$certificate_identity" != "https://github.com/NVIDIA/NemoClaw/.github/workflows/llama-cpp-image-attest.yaml@refs/heads/main" ] \
  || [ "$certificate_oidc_issuer" != "https://token.actions.githubusercontent.com" ] \
  || [ -z "$output" ]; then
  echo "ERROR: llama.cpp publication identity is invalid." >&2
  exit 1
fi

for evidence_file in \
  "$candidate_index" \
  "$platform_digests" \
  "$anonymous_pull_amd64" \
  "$anonymous_pull_arm64" \
  "$sbom_amd64" \
  "$sbom_arm64" \
  "$sbom_verification" \
  "$provenance_verification" \
  "$signature_verification" \
  "$scan_amd64" \
  "$scan_arm64"; do
  if [ ! -f "$evidence_file" ] || [ -L "$evidence_file" ] || [ ! -s "$evidence_file" ]; then
    echo "ERROR: publication evidence must be a non-empty regular file and not a symlink: $evidence_file" >&2
    exit 1
  fi
done

output_parent="$(dirname "$output")"
if [ -L "$output_parent" ] || { [ -e "$output_parent" ] && [ ! -d "$output_parent" ]; }; then
  echo "ERROR: publication receipt output parent must be absent or a directory and not a symlink." >&2
  exit 1
fi
install -d -m 0700 "$output_parent"
if [ -L "$output" ] || { [ -e "$output" ] && [ ! -f "$output" ]; }; then
  echo "ERROR: publication receipt output must be absent or a regular file and not a symlink." >&2
  exit 1
fi

temporary_root="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/llama-cpp-publication-evidence-XXXXXX")"
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf 'sha256:%s' "$(sha256sum "$1" | awk '{print $1}')"
  else
    printf 'sha256:%s' "$(shasum -a 256 "$1" | awk '{print $1}')"
  fi
}

candidate_digest="$(sha256_file "$candidate_index")"
if [ "$candidate_digest" != "$reference_digest" ]; then
  echo "ERROR: candidate index bytes do not match the exact reference." >&2
  exit 1
fi

if ! jq -e '
  (keys | sort) == ["manifests", "mediaType", "schemaVersion"]
  and .schemaVersion == 2
  and .mediaType == "application/vnd.oci.image.index.v1+json"
  and (.manifests | length) == 2
  and all(.manifests[];
    (keys | sort) == ["digest", "mediaType", "platform", "size"]
    and .mediaType == "application/vnd.oci.image.manifest.v1+json"
    and (.digest | test("^sha256:[0-9a-f]{64}$"))
    and (.size | type) == "number" and .size > 0 and (.size | floor) == .size
    and (.platform | keys | sort) == ["architecture", "os"]
    and .platform.os == "linux"
    and (.platform.architecture == "amd64" or .platform.architecture == "arm64")
  )
  and ([.manifests[].platform.architecture] | sort) == ["amd64", "arm64"]
' "$candidate_index" >/dev/null; then
  echo "ERROR: candidate index is not the exact two-platform contract." >&2
  exit 1
fi

if ! jq -e '
  (keys | sort) == ["linux/amd64", "linux/arm64"]
  and all(.[]; type == "string" and test("^sha256:[0-9a-f]{64}$"))
' "$platform_digests" >/dev/null; then
  echo "ERROR: platform digest map does not match the exact two-platform contract." >&2
  exit 1
fi
for arch in amd64 arm64; do
  expected="$(jq -er --arg platform "linux/$arch" '.[$platform]' "$platform_digests")"
  actual="$(jq -er --arg arch "$arch" '.manifests[] | select(.platform == {os:"linux", architecture:$arch}) | .digest' "$candidate_index")"
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: candidate linux/$arch descriptor is not bound to this run." >&2
    exit 1
  fi
done

mkdir -m 0700 "$temporary_root/docker-config"
anonymous_index="$temporary_root/anonymous-index.json"
DOCKER_CONFIG="$temporary_root/docker-config" \
  docker buildx imagetools inspect "$reference" --raw >"$anonymous_index"
if ! cmp -s "$candidate_index" "$anonymous_index"; then
  echo "ERROR: anonymous exact-digest pull does not match the candidate bytes." >&2
  exit 1
fi

anonymous_pull_summary="$temporary_root/anonymous-pull-summary.json"
printf '[]\n' >"$anonymous_pull_summary"
for arch in amd64 arm64; do
  platform="linux/$arch"
  expected="$(jq -er --arg platform "$platform" '.[$platform]' "$platform_digests")"
  if [ "$arch" = "amd64" ]; then
    anonymous_pull="$anonymous_pull_amd64"
  else
    anonymous_pull="$anonymous_pull_arm64"
  fi
  if ! jq -e \
    --arg digest "$expected" \
    --arg platform "$platform" \
    --arg reference "$image@$expected" '
      (keys | sort) == ["imageId", "platform", "platformDigest", "reference"]
      and .platform == $platform
      and .platformDigest == $digest
      and .reference == $reference
      and (.imageId | type == "string" and test("^sha256:[0-9a-f]{64}$"))
    ' "$anonymous_pull" >/dev/null; then
    echo "ERROR: isolated anonymous pull evidence does not match $platform." >&2
    exit 1
  fi
  jq -cS --slurpfile pull "$anonymous_pull" \
    '. + [{platform:$pull[0].platform,imageId:$pull[0].imageId}]' \
    "$anonymous_pull_summary" >"$anonymous_pull_summary.next"
  mv "$anonymous_pull_summary.next" "$anonymous_pull_summary"
done

for sbom in "$sbom_amd64" "$sbom_arm64"; do
  if ! jq -e '
    (type == "object")
    and .SPDXID == "SPDXRef-DOCUMENT"
    and (.spdxVersion == "SPDX-2.2" or .spdxVersion == "SPDX-2.3")
    and .dataLicense == "CC0-1.0"
    and (.documentNamespace | type) == "string" and (.documentNamespace | length) > 0
    and (.creationInfo.creators | type) == "array" and (.creationInfo.creators | length) > 0
    and (.packages | type) == "array"
  ' "$sbom" >/dev/null; then
    echo "ERROR: SPDX SBOM document is malformed." >&2
    exit 1
  fi
done

if ! jq -e 'type == "array" and length >= 2 and all(.[]; (.payload | type) == "string" and (.payload | length) > 0)' "$sbom_verification" >/dev/null; then
  echo "ERROR: expected verified SBOM attestations." >&2
  exit 1
fi
sbom_expected="$temporary_root/sbom-expected.txt"
{
  jq -cS . "$sbom_amd64" | sha256_file /dev/stdin
  printf '\n'
  jq -cS . "$sbom_arm64" | sha256_file /dev/stdin
  printf '\n'
} | sort -u >"$sbom_expected"
if [ "$(wc -l <"$sbom_expected" | tr -d '[:space:]')" -ne 2 ]; then
  echo "ERROR: amd64 and arm64 SPDX documents must be distinct." >&2
  exit 1
fi
sbom_actual="$temporary_root/sbom-actual.txt"
sbom_attestation_count="$(jq -er 'length' "$sbom_verification")"
for ((index = 0; index < sbom_attestation_count; index += 1)); do
  payload="$(jq -er --argjson index "$index" '.[$index].payload' "$sbom_verification")"
  statement="$temporary_root/sbom-statement-$index.json"
  printf '%s' "$payload" | openssl base64 -d -A >"$statement"
  if ! jq -e --arg digest "${reference_digest#sha256:}" '
    ._type == "https://in-toto.io/Statement/v1"
    and .predicateType == "https://spdx.dev/Document"
    and (.subject | length) == 1
    and .subject[0].digest == {sha256:$digest}
    and (.predicate | type) == "object"
  ' "$statement" >/dev/null; then
    echo "ERROR: SBOM attestation does not bind the candidate index." >&2
    exit 1
  fi
  jq -cS .predicate "$statement" | sha256_file /dev/stdin
  printf '\n'
done | sort -u >"$sbom_actual"
missing_sbom_hashes="$(comm -23 "$sbom_expected" "$sbom_actual")"
if [ -n "$missing_sbom_hashes" ]; then
  echo "ERROR: verified SBOM attestations do not match both platform documents." >&2
  exit 1
fi

if ! jq -e --arg digest "${reference_digest#sha256:}" '
  type == "array" and length >= 1
  and any(.[].verificationResult;
    .statement._type == "https://in-toto.io/Statement/v1"
    and .statement.predicateType == "https://slsa.dev/provenance/v1"
    and (.statement.subject | length) == 1
    and .statement.subject[0].digest == {sha256:$digest}
    and (.verifiedTimestamps | type) == "array"
    and (.verifiedTimestamps | length) > 0
  )
' "$provenance_verification" >/dev/null; then
  echo "ERROR: SLSA provenance verification does not bind the candidate index." >&2
  exit 1
fi

if ! jq -e --arg digest "$reference_digest" --arg image "$image" '
  type == "array" and length >= 1
  and all(.[].critical;
    .type == "cosign container image signature"
    and .identity["docker-reference"] == $image
    and .image["docker-manifest-digest"] == $digest
  )
' "$signature_verification" >/dev/null; then
  echo "ERROR: keyless signature verification does not bind the candidate index." >&2
  exit 1
fi

scan_summary="$temporary_root/scan-summary.jsonl"
: >"$scan_summary"
for arch in amd64 arm64; do
  scan_variable="scan_$arch"
  scan_file="${!scan_variable}"
  platform="linux/$arch"
  platform_digest="$(jq -er --arg platform "$platform" '.[$platform]' "$platform_digests")"
  platform_reference="$image@$platform_digest"
  if ! jq -e --arg reference "$platform_reference" '
    (.descriptor.name | ascii_downcase) == "grype"
    and (.descriptor.version | type) == "string" and (.descriptor.version | length) > 0
    and (.matches | type) == "array"
    and .source.type == "image"
    and .source.target.userInput == $reference
    and ([.matches[].vulnerability.severity | ascii_downcase | select(. == "high" or . == "critical")] | length) == 0
  ' "$scan_file" >/dev/null; then
    echo "ERROR: linux/$arch vulnerability evidence violates the high/only-fixed policy." >&2
    exit 1
  fi
  jq -cn \
    --arg platform "$platform" \
    --arg reference "$platform_reference" \
    --arg reportSha256 "$(sha256_file "$scan_file")" \
    --arg scannerVersion "$(jq -er '.descriptor.version' "$scan_file")" \
    --argjson matchCount "$(jq -er '.matches | length' "$scan_file")" \
    '{platform:$platform,reference:$reference,reportSha256:$reportSha256,scannerVersion:$scannerVersion,matchCount:$matchCount}' \
    >>"$scan_summary"
done

candidate_size="$(wc -c <"$candidate_index" | tr -d '[:space:]')"
candidate_tag="llama-cpp-candidate-${run_id}-${run_attempt}"
temporary_output="$temporary_root/receipt.json"
jq -nS \
  --arg certificateIdentity "$certificate_identity" \
  --arg certificateOidcIssuer "$certificate_oidc_issuer" \
  --arg cudaDevelopmentBase "$cuda_development_base" \
  --arg cudaRuntimeBase "$cuda_runtime_base" \
  --arg candidateTag "$candidate_tag" \
  --arg digest "$reference_digest" \
  --arg image "$image" \
  --arg provenanceSha256 "$(sha256_file "$provenance_verification")" \
  --arg reference "$reference" \
  --arg repository "$repository" \
  --arg revision "$revision" \
  --arg runAttempt "$run_attempt" \
  --arg runId "$run_id" \
  --arg sbomAmd64Sha256 "$(sha256_file "$sbom_amd64")" \
  --arg sbomArm64Sha256 "$(sha256_file "$sbom_arm64")" \
  --arg sbomVerificationSha256 "$(sha256_file "$sbom_verification")" \
  --arg signatureVerificationSha256 "$(sha256_file "$signature_verification")" \
  --arg sourceArchiveSha256 "$source_archive_sha256" \
  --arg sourceRevision "$source_revision" \
  --argjson candidateSize "$candidate_size" \
  --slurpfile platformDigests "$platform_digests" \
  --slurpfile anonymousPlatforms "$anonymous_pull_summary" \
  --slurpfile scans "$scan_summary" \
  '{
    schemaVersion: 1,
    image: {
      repository: $image,
      candidateTag: $candidateTag,
      index: {reference:$reference,digest:$digest,size:$candidateSize},
      platforms: $platformDigests[0]
    },
    build: {
      repository: $repository,
      revision: $revision,
      run: {id:$runId,attempt:$runAttempt},
      source: {revision:$sourceRevision,archiveSha256:$sourceArchiveSha256},
      cuda: {developmentBase:$cudaDevelopmentBase,runtimeBase:$cudaRuntimeBase}
    },
    evidence: {
      sbom: {
        format:"spdx-json",
        amd64Sha256:$sbomAmd64Sha256,
        arm64Sha256:$sbomArm64Sha256,
        verificationSha256:$sbomVerificationSha256
      },
      provenance: {predicateType:"https://slsa.dev/provenance/v1",verificationSha256:$provenanceSha256},
      signature: {
        mode:"sigstore-keyless",
        certificateIdentity:$certificateIdentity,
        certificateOidcIssuer:$certificateOidcIssuer,
        transparencyLog:"verified",
        verificationSha256:$signatureVerificationSha256
      },
      vulnerability: {scanner:"grype",severityCutoff:"high",onlyFixed:true,platforms:$scans},
      anonymousPull: {
        exactDigest:true,
        reference:$reference,
        indexSha256:$digest,
        platforms:$anonymousPlatforms[0]
      }
    }
  }' >"$temporary_output"

chmod 0600 "$temporary_output"
mv -f "$temporary_output" "$output"
