#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Verifies that pinned SHA-256 hashes for downloaded OpenShell release assets
# still match the immutable upstream checksum manifests.
#
# Checked artifacts:
#   1. OpenShell archives — scripts/install-openshell.sh release-asset table
#   2. Brev OpenShell CLI — scripts/brev-launchable-ci-cpu.sh release-asset table
#
# Usage:
#   scripts/check-installer-hash.sh            # exit 0 if current, 1 if stale
#
# CI can execute this script from a trusted checkout while inspecting a
# separate pull-request tree by setting NEMOCLAW_INSTALLER_HASH_REPO_ROOT.

set -euo pipefail

if [[ -n "${NEMOCLAW_INSTALLER_HASH_REPO_ROOT:-}" ]]; then
  REPO_ROOT="$(cd "$NEMOCLAW_INSTALLER_HASH_REPO_ROOT" && pwd)"
else
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
CHECKER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Trust-anchor rollout is intentionally two-step. First land a prerequisite PR
# that adds the reviewed release-manifest digests here while runtime selectors
# still name the current release. Only after that commit is on the target branch
# may a separate pin PR select the new release. Pull-request verification runs
# this file from the base SHA, so a pin PR can never authorize its own digests.
readonly -a OPENSHELL_RELEASE_MANIFEST_ALLOWLIST=(
  "0.0.72|openshell-checksums-sha256.txt|0049181983eaf925ef9510382f75348229a9511d02e27196107782e7c3259ae1"
  "0.0.72|openshell-gateway-checksums-sha256.txt|3c454dc15154b8c700ec820628559ea8964c6e552d9c5f8af78b6ee19cf34547"
  "0.0.72|openshell-sandbox-checksums-sha256.txt|d38507501338576437cf3e554df71fefe927dc0d72758f88e260069527ed9ccc"
  "0.0.82|openshell-checksums-sha256.txt|74ba77d368744f412b2dd246099b63b38937962807333ded2b6284580a2d014e"
  "0.0.82|openshell-gateway-checksums-sha256.txt|c0a369ba2c66bcde3c18ce2753b04ff942d1fe1b5f3e4656de520f6d4b175477"
  "0.0.82|openshell-sandbox-checksums-sha256.txt|3300b9856cdbe8e3f9b0f8068bbad93673739c4cfd3212c80dc0675168ee2b8d"
)

case "${1:-}" in
  "") ;;
  *)
    echo "Usage: scripts/check-installer-hash.sh" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
fetch_file() {
  local url="$1" destination="$2"
  curl --proto '=https' --tlsv1.2 -fsSL \
    --connect-timeout 10 --max-time 30 \
    --retry 3 --retry-delay 1 --retry-all-errors \
    -o "$destination" "$url"
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "ERROR: No SHA-256 tool available (sha256sum/shasum)." >&2
    return 1
  fi
}

# invalidState: CI reports trusted OpenShell pins without comparing every
# consumed archive with the selected immutable checksum release assets.
# sourceBoundary: NVIDIA/OpenShell owns the release assets and their published
# digests; NemoClaw owns this independent verification of its local pin table.
# In pull-request CI, this checker and its pin parser execute only from the
# base-trusted checkout or the immutable bootstrap checkout, never from the PR
# head; installer files from the PR head are treated strictly as input data.
# whyNotSourceFix: an upstream release cannot validate which artifacts a
# downstream installer consumes, so this comparison must remain in NemoClaw.
# regressionTest: test/installer-hash-check.test.ts proves download failures and
# altered checksum manifests fail closed; the workflow also runs this live.
# removalCondition: remove this check only when the installer no longer embeds
# release-asset digests or an equivalent independent verifier replaces it.
check_openshell_release_assets() {
  local installer="${REPO_ROOT}/scripts/install-openshell.sh"
  local brev_installer="${REPO_ROOT}/scripts/brev-launchable-ci-cpu.sh"
  local release_base workspace manifests spec manifest expected actual source asset pinned upstream
  local matches required_manifest required_matches
  local pin_records parser_error parser_errors parsed_version release_version="" record_extra
  local allowlist_entry allowlist_version allowlist_extra
  local count=0 brev_count=0 published_count=0 failures=0
  local -a manifest_specs=()
  workspace=$(mktemp -d)
  manifests="${workspace}/published-sha256.txt"
  : >"$manifests"
  trap 'rm -rf "$workspace"' RETURN

  # invalidState: target-controlled shell formatting hides, duplicates, or
  # mixes a release version while the trusted release-asset check still reports
  # success.
  # sourceBoundary: this parser executes beside the checker only from the
  # base-trusted checkout or immutable bootstrap, never from the PR head. It
  # defines the accepted static shell subset; PR-head installers are input data
  # only and are never sourced or executed.
  # whyNotSourceFix: installers need shell-native lookup before dependencies are
  # available, and sourcing target-controlled shell here would execute PR code.
  # regressionTest: test/installer-hash-check.test.ts covers resilient formatting
  # plus missing and ambiguous pins; the workflow contract pins the parser path.
  # removalCondition: replace this parser when both installers directly consume
  # one canonical machine-readable pin manifest.
  parser_errors="${workspace}/pin-parser-errors.txt"
  if ! pin_records=$(node --experimental-strip-types \
    "${CHECKER_ROOT}/checks/extract-installer-pins.mts" \
    --blueprint "${REPO_ROOT}/nemoclaw-blueprint/blueprint.yaml" \
    --installer "$installer" \
    --brev-installer "$brev_installer" \
    --format tsv 2>"$parser_errors"); then
    echo "  STALE: unable to extract the OpenShell installer pin tables with trusted parser code."
    while IFS= read -r parser_error; do
      echo "    ${parser_error}"
    done <"$parser_errors"
    return 1
  fi

  while IFS=$'\t' read -r parsed_version source asset pinned record_extra; do
    if [[ ! "$parsed_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || -z "$source" || -z "$asset" || -z "$pinned" || -n "$record_extra" ]]; then
      echo "  STALE: trusted parser returned an invalid installer pin record."
      return 1
    fi
    if [[ -z "$release_version" ]]; then
      release_version="$parsed_version"
    elif [[ "$parsed_version" != "$release_version" ]]; then
      echo "  STALE: trusted parser returned multiple OpenShell release versions."
      return 1
    fi
    case "$source" in
      installer) count=$((count + 1)) ;;
      "Brev launchable") brev_count=$((brev_count + 1)) ;;
      *)
        echo "  STALE: trusted parser returned an unknown pin source."
        return 1
        ;;
    esac
  done <<<"$pin_records"

  if [[ "$count" -ne 8 ]]; then
    echo "  STALE: expected 8 pinned OpenShell v${release_version:-unknown} assets, found ${count}."
    failures=$((failures + 1))
  fi
  if [[ "$brev_count" -ne 2 ]]; then
    echo "  STALE: expected 2 pinned Brev OpenShell v${release_version:-unknown} CLI assets, found ${brev_count}."
    failures=$((failures + 1))
  fi
  if [[ "$failures" -ne 0 ]]; then
    return "$failures"
  fi

  for allowlist_entry in "${OPENSHELL_RELEASE_MANIFEST_ALLOWLIST[@]}"; do
    IFS='|' read -r allowlist_version manifest expected allowlist_extra <<<"$allowlist_entry"
    if [[ ! "$allowlist_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$expected" =~ ^[a-f0-9]{64}$ || -z "$manifest" || -n "$allowlist_extra" ]]; then
      echo "  STALE: trusted OpenShell release-manifest allowlist is invalid."
      return 1
    fi
    if [[ "$allowlist_version" == "$release_version" ]]; then
      manifest_specs+=("${manifest}:${expected}")
    fi
  done

  if [[ "${#manifest_specs[@]}" -eq 0 ]]; then
    echo "  STALE: OpenShell v${release_version} is not in the trusted release-manifest allowlist."
    return 1
  fi
  if [[ "${#manifest_specs[@]}" -ne 3 ]]; then
    echo "  STALE: OpenShell v${release_version} does not have exactly three trusted release-manifest digests."
    return 1
  fi
  for required_manifest in \
    openshell-checksums-sha256.txt \
    openshell-gateway-checksums-sha256.txt \
    openshell-sandbox-checksums-sha256.txt; do
    required_matches=0
    for spec in "${manifest_specs[@]}"; do
      if [[ "${spec%%:*}" == "$required_manifest" ]]; then
        required_matches=$((required_matches + 1))
      fi
    done
    if [[ "$required_matches" -ne 1 ]]; then
      echo "  STALE: OpenShell v${release_version} does not have exactly one trusted ${required_manifest} digest."
      failures=$((failures + 1))
    fi
  done
  if [[ "$failures" -ne 0 ]]; then
    return "$failures"
  fi

  release_base="https://github.com/NVIDIA/OpenShell/releases/download/v${release_version}"
  echo "Checking OpenShell v${release_version} release assets..."
  for spec in "${manifest_specs[@]}"; do
    manifest="${spec%%:*}"
    expected="${spec#*:}"
    if ! fetch_file "${release_base}/${manifest}" "${workspace}/${manifest}"; then
      echo "  STALE: unable to download ${manifest}."
      failures=$((failures + 1))
      continue
    fi
    if ! actual=$(sha256_file "${workspace}/${manifest}"); then
      echo "  STALE: unable to hash ${manifest}."
      failures=$((failures + 1))
      continue
    fi
    if [[ "$actual" != "$expected" ]]; then
      echo "  STALE: ${manifest} digest does not match the pinned v${release_version} release asset."
      echo "    pinned:   ${expected}"
      echo "    upstream: ${actual}"
      failures=$((failures + 1))
      continue
    fi
    echo "  OK: ${manifest} (${actual})"
    cat "${workspace}/${manifest}" >>"$manifests"
  done

  while IFS=$'\t' read -r parsed_version source asset pinned record_extra; do
    matches=$(awk -v asset="$asset" '$2 == asset { count++ } END { print count + 0 }' "$manifests")
    upstream=$(awk -v asset="$asset" '$2 == asset { print $1; exit }' "$manifests")
    if [[ "$matches" -eq 1 && "$pinned" == "$upstream" ]]; then
      published_count=$((published_count + 1))
      echo "  OK: ${source} ${asset} (${pinned})"
    else
      echo "  STALE: ${source} ${asset} does not match exactly one v${release_version} checksum entry."
      echo "    pinned:   ${pinned}"
      echo "    upstream: ${upstream:-missing}"
      echo "    matches:  ${matches}"
      failures=$((failures + 1))
    fi
  done <<<"$pin_records"

  if [[ "$published_count" -ne 10 ]]; then
    echo "  STALE: expected all 10 pinned asset references in the v${release_version} checksum manifests, matched ${published_count}."
    failures=$((failures + 1))
  fi
  return "$failures"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
failures=0
if check_openshell_release_assets; then
  echo ""
  echo "All installer hashes are current."
  exit 0
else
  failures=$?
fi

echo ""
echo "${failures} OpenShell release-asset check(s) failed."
exit 1
