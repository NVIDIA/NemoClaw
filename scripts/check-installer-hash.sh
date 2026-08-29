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

# Trust-anchor rollout is intentionally two-step. The base-trusted TypeScript
# parser owns each release record and emits the manifest and formula identities
# that this shell checker downloads. A later pin PR can select only a complete
# record that already exists in the target branch.

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
# regressionTest: test/install/installer-hash-check.test.ts proves download failures and
# altered checksum manifests fail closed; the workflow also runs this live.
# removalCondition: remove this check only when the installer no longer embeds
# release-asset digests or an equivalent independent verifier replaces it.
check_openshell_release_assets() {
  local installer="${REPO_ROOT}/scripts/install-openshell.sh"
  local brev_installer="${REPO_ROOT}/scripts/brev-launchable-ci-cpu.sh"
  local supervisor_runtime="${REPO_ROOT}/src/lib/onboard/docker-driver-gateway-runtime.ts"
  local release_base workspace manifests spec manifest expected actual source asset pinned upstream formula_asset
  local matches formula_expected formula_matches formula_url
  local pin_records parser_error parser_errors record_type parsed_version release_version record_extra
  local selected_release_version="" release_versions="" version_pin_records
  local count brev_count published_count expected_published_count failures=0
  local -a manifest_specs=()
  workspace=$(mktemp -d)
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
  # regressionTest: test/install/installer-hash-check.test.ts covers resilient formatting
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
    --format release-tsv 2>"$parser_errors"); then
    echo "  STALE: unable to extract the OpenShell installer pin tables with trusted parser code."
    while IFS= read -r parser_error; do
      echo "    ${parser_error}"
    done <"$parser_errors"
    return 1
  fi

  while IFS=$'\t' read -r record_type parsed_version source asset pinned record_extra; do
    if [[ ! "$parsed_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || -z "$source" || -z "$asset" || ! "$pinned" =~ ^[a-f0-9]{64}$ || -n "$record_extra" ]]; then
      echo "  STALE: trusted parser returned an invalid OpenShell release record."
      return 1
    fi
    case "$record_type" in
      manifest)
        [[ "$source" == "OpenShell release" ]] || {
          echo "  STALE: trusted parser returned an invalid OpenShell manifest record."
          return 1
        }
        ;;
      formula)
        if [[ "$asset" != "openshell.rb" || "$source" != "https://github.com/NVIDIA/OpenShell/releases/download/v${parsed_version}/${asset}" ]]; then
          echo "  STALE: trusted parser returned an invalid OpenShell formula record."
          return 1
        fi
        ;;
      pin)
        case "$source" in
          installer) ;;
          "Brev launchable")
            if [[ -z "$selected_release_version" ]]; then
              selected_release_version="$parsed_version"
            elif [[ "$selected_release_version" != "$parsed_version" ]]; then
              echo "  STALE: trusted parser returned multiple Brev OpenShell release versions."
              return 1
            fi
            ;;
          *)
            echo "  STALE: trusted parser returned an unknown pin source."
            return 1
            ;;
        esac
        ;;
      *)
        echo "  STALE: trusted parser returned an unknown OpenShell release record type."
        return 1
        ;;
    esac
    case " ${release_versions} " in
      *" ${parsed_version} "*) ;;
      *) release_versions="${release_versions:+${release_versions} }${parsed_version}" ;;
    esac
  done <<<"$pin_records"

  [[ -n "$selected_release_version" ]] || {
    echo "  STALE: trusted parser returned no selected Brev OpenShell release."
    return 1
  }

  for release_version in $release_versions; do
    manifests="${workspace}/published-sha256-${release_version}.txt"
    : >"$manifests"
    manifest_specs=()
    formula_expected=""
    formula_matches=0
    formula_url=""
    count=0
    brev_count=0
    published_count=0
    version_pin_records=""

    while IFS=$'\t' read -r record_type parsed_version source asset pinned record_extra; do
      [[ "$parsed_version" == "$release_version" ]] || continue
      case "$record_type" in
        manifest)
          manifest_specs+=("${asset}:${pinned}")
          ;;
        formula)
          formula_matches=$((formula_matches + 1))
          formula_url="$source"
          formula_expected="$pinned"
          ;;
        pin)
          version_pin_records+="${record_type}"$'\t'"${parsed_version}"$'\t'"${source}"$'\t'"${asset}"$'\t'"${pinned}"$'\n'
          case "$source" in
            installer) count=$((count + 1)) ;;
            "Brev launchable") brev_count=$((brev_count + 1)) ;;
          esac
          ;;
      esac
    done <<<"$pin_records"

    if [[ "$count" -ne 9 ]]; then
      echo "  STALE: expected 9 pinned OpenShell v${release_version} assets, found ${count}."
      return 1
    fi
    if [[ "$release_version" == "$selected_release_version" && "$brev_count" -ne 2 ]]; then
      echo "  STALE: expected 2 pinned Brev OpenShell v${release_version} CLI assets, found ${brev_count}."
      return 1
    fi
    if [[ "$release_version" != "$selected_release_version" && "$brev_count" -ne 0 ]]; then
      echo "  STALE: unselected OpenShell v${release_version} must not have Brev pins."
      return 1
    fi
    if [[ "${#manifest_specs[@]}" -ne 3 ]]; then
      echo "  STALE: trusted parser did not return exactly three OpenShell v${release_version} release manifests."
      return 1
    fi
    if [[ "$formula_matches" -ne 1 ]]; then
      echo "  STALE: trusted parser did not return exactly one OpenShell v${release_version} formula record."
      return 1
    fi

    release_base="https://github.com/NVIDIA/OpenShell/releases/download/v${release_version}"
    echo "Checking OpenShell v${release_version} release assets..."
    for spec in "${manifest_specs[@]}"; do
      manifest="${spec%%:*}"
      expected="${spec#*:}"
      if ! fetch_file "${release_base}/${manifest}" "${workspace}/${release_version}-${manifest}"; then
        echo "  STALE: unable to download ${manifest}."
        failures=$((failures + 1))
        continue
      fi
      if ! actual=$(sha256_file "${workspace}/${release_version}-${manifest}"); then
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
      cat "${workspace}/${release_version}-${manifest}" >>"$manifests"
    done

    while IFS=$'\t' read -r record_type parsed_version source asset pinned record_extra; do
      [[ -n "$parsed_version" ]] || continue
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
    done <<<"$version_pin_records"

    expected_published_count=$((count + brev_count))
    if [[ "$published_count" -ne "$expected_published_count" ]]; then
      echo "  STALE: expected all ${expected_published_count} pinned asset references for v${release_version}, matched ${published_count}."
      failures=$((failures + 1))
    fi
  done
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
