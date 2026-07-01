#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# invalidState: the three reviewed E2E consumers drift to different cloudflared
# versions/digests, or their shared pin no longer matches the upstream asset.
# sourceBoundary: Cloudflare owns the release asset; NemoClaw owns all three
# workflow pins and independently verifies the downloaded bytes.
# whyNotSourceFix: upstream cannot enforce which release NemoClaw workflows use.
# regressionTest: cloudflared-update-check-workflow.test.ts covers three-pin
# parity, asset URL identity, digest mismatch, and update instructions.
# removalCondition: remove this checker when the three consumers share one
# machine-readable dependency manifest with equivalent live asset verification.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
E2E_WORKFLOW="${CLOUDFLARED_E2E_WORKFLOW:-${REPO_ROOT}/.github/workflows/e2e.yaml}"
RELEASE_API_URL="${CLOUDFLARED_RELEASE_API_URL:-https://api.github.com/repos/cloudflare/cloudflared/releases/latest}"
DOWNLOAD_BASE_URL="${CLOUDFLARED_DOWNLOAD_BASE_URL:-https://github.com/cloudflare/cloudflared/releases/download}"
CURL_BIN="${CLOUDFLARED_CURL_BIN:-curl}"
SHA256SUM_BIN="${CLOUDFLARED_SHA256SUM_BIN:-sha256sum}"

fail() {
  printf 'cloudflared update check failed: %s\n' "$*" >&2
  exit 1
}

for tool in "${CURL_BIN}" jq "${SHA256SUM_BIN}"; do
  command -v "${tool}" >/dev/null 2>&1 || fail "required tool is unavailable: ${tool}"
done
[[ -r "${E2E_WORKFLOW}" ]] || fail "cannot read pin source: ${E2E_WORKFLOW}"

version_pins=()
while IFS= read -r pin || [[ -n "${pin}" ]]; do
  version_pins+=("${pin}")
done < <(
  sed -nE 's/^[[:space:]]*CLOUDFLARED_VERSION:[[:space:]]*"([^"]+)".*$/\1/p' \
    "${E2E_WORKFLOW}"
)

sha_pins=()
while IFS= read -r pin || [[ -n "${pin}" ]]; do
  sha_pins+=("${pin}")
done < <(
  sed -nE 's/^[[:space:]]*CLOUDFLARED_DEB_SHA256:[[:space:]]*"([0-9a-fA-F]+)".*$/\1/p' \
    "${E2E_WORKFLOW}"
)

[[ "${#version_pins[@]}" -eq 3 ]] \
  || fail "expected exactly three CLOUDFLARED_VERSION pins in ${E2E_WORKFLOW}; found ${#version_pins[@]}"
[[ "${#sha_pins[@]}" -eq 3 ]] \
  || fail "expected exactly three CLOUDFLARED_DEB_SHA256 pins in ${E2E_WORKFLOW}; found ${#sha_pins[@]}"

pinned_version="${version_pins[0]}"
pinned_sha="$(printf '%s' "${sha_pins[0]}" | tr '[:upper:]' '[:lower:]')"
for pin in "${version_pins[@]}"; do
  [[ "${pin}" == "${pinned_version}" ]] \
    || fail "CLOUDFLARED_VERSION pins diverge in ${E2E_WORKFLOW}: ${version_pins[*]}"
done
for pin in "${sha_pins[@]}"; do
  [[ "$(printf '%s' "${pin}" | tr '[:upper:]' '[:lower:]')" == "${pinned_sha}" ]] \
    || fail "CLOUDFLARED_DEB_SHA256 pins diverge in ${E2E_WORKFLOW}: ${sha_pins[*]}"
done
[[ "${pinned_version}" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$ ]] \
  || fail "invalid pinned cloudflared version: ${pinned_version}"
[[ "${pinned_sha}" =~ ^[0-9a-f]{64}$ ]] || fail "invalid pinned cloudflared SHA256"

temp_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cloudflared-update-check.XXXXXX")"
trap 'rm -rf "${temp_dir}"' EXIT
release_json="${temp_dir}/latest-release.json"
cloudflared_deb="${temp_dir}/cloudflared-linux-amd64.deb"

"${CURL_BIN}" \
  --fail \
  --silent \
  --show-error \
  --location \
  --retry 3 \
  --retry-all-errors \
  --retry-delay 2 \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  --header 'User-Agent: NVIDIA-NemoClaw-cloudflared-update-check' \
  --output "${release_json}" \
  "${RELEASE_API_URL}"

latest_version="$(jq -er '.tag_name | select(type == "string" and length > 0)' "${release_json}")" \
  || fail "latest release response has no tag_name"
asset_url="$(
  jq -er 'first(.assets[]? | select(.name == "cloudflared-linux-amd64.deb") | .browser_download_url)' \
    "${release_json}"
)" || fail "latest release ${latest_version} has no cloudflared-linux-amd64.deb asset"

[[ "${latest_version}" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$ ]] \
  || fail "latest release tag has an unexpected format: ${latest_version}"
expected_asset_url="${DOWNLOAD_BASE_URL%/}/${latest_version}/cloudflared-linux-amd64.deb"
[[ "${asset_url}" == "${expected_asset_url}" ]] \
  || fail "latest release returned an unexpected asset URL: ${asset_url}"

"${CURL_BIN}" \
  --fail \
  --silent \
  --show-error \
  --location \
  --retry 3 \
  --retry-all-errors \
  --retry-delay 2 \
  --output "${cloudflared_deb}" \
  "${asset_url}"

latest_sha="$("${SHA256SUM_BIN}" "${cloudflared_deb}" | awk '{print tolower($1)}')"
[[ "${latest_sha}" =~ ^[0-9a-f]{64}$ ]] || fail "could not compute the latest asset SHA256"

version_lines="$(grep -n 'CLOUDFLARED_VERSION:' "${E2E_WORKFLOW}" | cut -d: -f1 | paste -sd, -)"
sha_lines="$(grep -n 'CLOUDFLARED_DEB_SHA256:' "${E2E_WORKFLOW}" | cut -d: -f1 | paste -sd, -)"
workflow_display="${E2E_WORKFLOW#"${REPO_ROOT}/"}"

print_update_instructions() {
  printf '%s\n' \
    'cloudflared update required.' \
    "Pinned version: ${pinned_version}" \
    "Pinned linux-amd64.deb SHA256: ${pinned_sha}" \
    "Latest version: ${latest_version}" \
    "Latest linux-amd64.deb SHA256: ${latest_sha}" \
    'Update locations:' \
    "  ${workflow_display} CLOUDFLARED_VERSION lines: ${version_lines}" \
    "  ${workflow_display} CLOUDFLARED_DEB_SHA256 lines: ${sha_lines}" \
    'Set all three version/SHA256 pairs to the latest reviewed values, then rerun this check.' >&2
}

if [[ "${latest_version}" != "${pinned_version}" ]]; then
  print_update_instructions
  exit 1
fi

if [[ "${latest_sha}" != "${pinned_sha}" ]]; then
  printf 'The current cloudflared release asset no longer matches its reviewed SHA256.\n' >&2
  print_update_instructions
  exit 1
fi

printf '%s  %s\n' "${pinned_sha}" "${cloudflared_deb}" | "${SHA256SUM_BIN}" -c -
printf 'cloudflared pin is current: version=%s sha256=%s\n' "${pinned_version}" "${pinned_sha}"
