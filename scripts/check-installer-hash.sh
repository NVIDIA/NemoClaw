#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Verifies that pinned SHA-256 hashes for downloaded OpenShell release assets
# still match the base-trusted upstream release digests.
#
# Checked artifacts:
#   1. OpenShell archives/formula — scripts/install-openshell.sh release-asset table
#   2. Brev OpenShell CLI — scripts/brev-launchable-ci-cpu.sh release-asset table
#   3. OpenShell supervisor — version-to-OCI-index runtime map
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
# that adds the reviewed manifest, formula, standalone sandbox, and supervisor
# OCI identities while runtime selectors still name the current release. Only
# after that commit is on the target branch may a separate pin PR select the new
# release. Pull-request verification runs this checker and its parser from the
# base SHA, so a pin PR can never authorize its own identities.
readonly -a OPENSHELL_RELEASE_MANIFEST_ALLOWLIST=(
  "0.0.72|openshell-checksums-sha256.txt|0049181983eaf925ef9510382f75348229a9511d02e27196107782e7c3259ae1"
  "0.0.72|openshell-gateway-checksums-sha256.txt|3c454dc15154b8c700ec820628559ea8964c6e552d9c5f8af78b6ee19cf34547"
  "0.0.72|openshell-sandbox-checksums-sha256.txt|d38507501338576437cf3e554df71fefe927dc0d72758f88e260069527ed9ccc"
  "0.0.82|openshell-checksums-sha256.txt|74ba77d368744f412b2dd246099b63b38937962807333ded2b6284580a2d014e"
  "0.0.82|openshell-gateway-checksums-sha256.txt|c0a369ba2c66bcde3c18ce2753b04ff942d1fe1b5f3e4656de520f6d4b175477"
  "0.0.82|openshell-sandbox-checksums-sha256.txt|3300b9856cdbe8e3f9b0f8068bbad93673739c4cfd3212c80dc0675168ee2b8d"
  "0.0.85|openshell-checksums-sha256.txt|6554b3f96c04006d661519786d40d17e34c7860b7aac8fd35259ef2aea01567f"
  "0.0.85|openshell-gateway-checksums-sha256.txt|cc4f32afed376ebe9b43cccdb4d2a77b2524b57132a6b56bb88d705e02420f86"
  "0.0.85|openshell-sandbox-checksums-sha256.txt|b6ac353c933fa4cf9a3ef11d66cce6635f39ecc2e928d9c8ff1783ca797308b3"
  "0.0.99|openshell-checksums-sha256.txt|ea3e2c1a583e5ea00332c3b65a18068bd1f9b090f7ff0f5e24b29762cfc3b4c7"
  "0.0.99|openshell-gateway-checksums-sha256.txt|7f84f728412548720c8ef51993c58414c4f04598451c282b26ead233185e40c5"
  "0.0.99|openshell-sandbox-checksums-sha256.txt|9e67af6bab9f975432a1045fcfea5ab182ab585b17886c8c290c1eb77232b87a"
  "0.0.101|openshell-checksums-sha256.txt|9c90869d00b109b5ac1062b1a9808a592c2311d3c0c4926bae44d136b979d8a9"
  "0.0.101|openshell-gateway-checksums-sha256.txt|dcb3f1917713bf2a8e8e1803ac42c5e39d9dd41e644136b05def32b077082777"
  "0.0.101|openshell-sandbox-checksums-sha256.txt|d16f7d369c54d74d36c7df036565267a960e7ce6fb143012fe9d77f257d6e8b3"
  "0.0.103|openshell-checksums-sha256.txt|1a9016cfb9219ad6ea3dc623b3dfd517dbce062cba9484964a8ca9175c7d1c9d"
  "0.0.103|openshell-gateway-checksums-sha256.txt|800f8501329b27b79d260f21de088d8aea36de45021eaa3d29d189c433fc04b5"
  "0.0.103|openshell-sandbox-checksums-sha256.txt|ab7c77fe40e93b293e4d34e892824ed0cb131e8b973ba2660b155cdd0fa0f604"
)

# OpenShell's Homebrew formula is a release asset but is not included in any
# published checksum manifest. Keep its reviewed identity tuple in the same
# base-trusted checker so a later pin PR cannot authorize a replaced formula by
# changing its candidate-controlled pin to match the live download.
readonly -a OPENSHELL_RELEASE_FORMULA_ALLOWLIST=(
  "0.0.72|openshell.rb|https://github.com/NVIDIA/OpenShell/releases/download/v0.0.72/openshell.rb|4b75a7e3a7630eb8954d73ca828b394d5e0646adbaa4b087b2435329d53b61b3"
  "0.0.82|openshell.rb|https://github.com/NVIDIA/OpenShell/releases/download/v0.0.82/openshell.rb|fa54640184e22fa74500ab24f5b4372582616c7e12a1152cb6983bc0738c5a74"
  "0.0.85|openshell.rb|https://github.com/NVIDIA/OpenShell/releases/download/v0.0.85/openshell.rb|f53c62777fed23b42427822d231670451ee4358efeb2660c41a7a38919211b23"
  "0.0.99|openshell.rb|https://github.com/NVIDIA/OpenShell/releases/download/v0.0.99/openshell.rb|8dd34fc17ee9a30327664a18c9509c8a765cb010de38cda8e22841bddbe92713"
  "0.0.101|openshell.rb|https://github.com/NVIDIA/OpenShell/releases/download/v0.0.101/openshell.rb|87fadc7b0c854aa44f71d5b3a206865070117cd27825d59c61da252a99f402a2"
  "0.0.103|openshell.rb|https://github.com/NVIDIA/OpenShell/releases/download/v0.0.103/openshell.rb|95a290f0e0e2f57d7d46ba9171fca6e99e5226875cd12e12391b7338f6c219f9"
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
# base-trusted checkout. Installer files from the latest PR commit are input data
# and are never sourced or executed.
# whyNotSourceFix: an upstream release cannot validate which artifacts a
# downstream installer consumes, so this comparison must remain in NemoClaw.
# regressionTest: test/installer-hash-check.test.ts proves download failures and
# altered checksum manifests fail closed; the workflow also runs this live.
# removalCondition: remove this check only when the installer no longer embeds
# release-asset digests or an equivalent independent verifier replaces it.
check_openshell_release_assets() {
  local installer="${REPO_ROOT}/scripts/install-openshell.sh"
  local brev_installer="${REPO_ROOT}/scripts/brev-launchable-ci-cpu.sh"
  local supervisor_runtime="${REPO_ROOT}/src/lib/onboard/docker-driver-gateway-runtime.ts"
  local release_base workspace manifests spec manifest expected actual source asset pinned upstream formula_asset
  local matches required_manifest required_matches formula_expected="" formula_matches=0 formula_url=""
  local pin_records parser_error parser_errors parsed_version release_version="" record_extra
  local allowlist_entry allowlist_version allowlist_extra
  local formula_allowlist_entry formula_allowlist_version formula_allowlist_asset formula_allowlist_url formula_allowlist_digest formula_allowlist_extra
  local count=0 brev_count=0 published_count=0 expected_published_count=0 failures=0
  local -a manifest_specs=()
  workspace=$(mktemp -d)
  manifests="${workspace}/published-sha256.txt"
  : >"$manifests"
  trap 'rm -rf "$workspace"' RETURN

  # invalidState: target-controlled shell formatting hides, duplicates, or
  # mixes a release version while the trusted release-asset check still reports
  # success.
  # sourceBoundary: In pull-request CI, this parser and checker execute only
  # from the base-trusted checkout. The parser defines the accepted static shell
  # subset. Installer files from the latest PR commit are input data and are
  # never sourced or executed.
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
    --supervisor-runtime "$supervisor_runtime" \
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

  if [[ "$count" -ne 9 ]]; then
    echo "  STALE: expected 9 pinned OpenShell v${release_version:-unknown} assets, found ${count}."
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

  for formula_allowlist_entry in "${OPENSHELL_RELEASE_FORMULA_ALLOWLIST[@]}"; do
    IFS='|' read -r formula_allowlist_version formula_allowlist_asset formula_allowlist_url formula_allowlist_digest formula_allowlist_extra <<<"$formula_allowlist_entry"
    if [[ ! "$formula_allowlist_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || "$formula_allowlist_asset" != "openshell.rb" || "$formula_allowlist_url" != "https://github.com/NVIDIA/OpenShell/releases/download/v${formula_allowlist_version}/${formula_allowlist_asset}" || ! "$formula_allowlist_digest" =~ ^[a-f0-9]{64}$ || -n "$formula_allowlist_extra" ]]; then
      echo "  STALE: trusted OpenShell formula allowlist is invalid."
      return 1
    fi
    if [[ "$formula_allowlist_version" == "$release_version" ]]; then
      formula_matches=$((formula_matches + 1))
      formula_url="$formula_allowlist_url"
      formula_expected="$formula_allowlist_digest"
    fi
  done

  if [[ "$formula_matches" -ne 1 ]]; then
    echo "  STALE: OpenShell v${release_version} does not have exactly one trusted openshell.rb digest."
    return 1
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
    if [[ "$asset" == "openshell.rb" ]]; then
      formula_asset="${workspace}/${asset}"
      if ! fetch_file "$formula_url" "$formula_asset"; then
        echo "  STALE: unable to download ${source} ${asset}."
        failures=$((failures + 1))
        continue
      fi
      if ! actual=$(sha256_file "$formula_asset"); then
        echo "  STALE: unable to hash ${source} ${asset}."
        failures=$((failures + 1))
        continue
      fi
      if [[ "$actual" != "$formula_expected" ]]; then
        echo "  STALE: ${source} ${asset} does not match the base-trusted v${release_version} formula digest."
        echo "    trusted:  ${formula_expected}"
        echo "    upstream: ${actual}"
        failures=$((failures + 1))
      elif [[ "$pinned" == "$formula_expected" ]]; then
        published_count=$((published_count + 1))
        echo "  OK: ${source} ${asset} (${pinned})"
      else
        echo "  STALE: ${source} ${asset} pin does not match the base-trusted v${release_version} formula digest."
        echo "    pinned:   ${pinned}"
        echo "    trusted:  ${formula_expected}"
        failures=$((failures + 1))
      fi
      continue
    fi
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

  expected_published_count=$((count + brev_count))
  if [[ "$published_count" -ne "$expected_published_count" ]]; then
    echo "  STALE: expected all ${expected_published_count} pinned asset references for v${release_version}, matched ${published_count}."
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
