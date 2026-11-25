#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Usage: record-cli-signing.sh SIGNED ARCHIVES NOTES
#
# Check that the CLI archives pack-cli-bundles.sh packed into ARCHIVES are
# signed as the release requires, and record the evidence: the release asset
# ARCHIVES/release-evidence.json, and NOTES, the release notes' paragraph about
# signing.
#
# SIGNED/<platform> holds a platform's bundle when its signing job passed, with
# the programs signing-inventory.sh assigns to NVIDIA signed, and
# SIGNED/<platform>.verification.txt the output of that job's signature checks. A final release, whose tag has no prerelease suffix such as -rc.1,
# needs signed darwin_arm64 and windows_amd64 executables. The only way to stage
# one without them is the RELEASE_UNSIGNED_EXCEPTION repository variable set to
# `<tag>:<reason>` for exactly this tag. Linux has no OS code signing; a final
# release's attestations authenticate its archives.
#
# ARCHIVES/nemoclaw-<tag>-darwin_arm64.pkg and nemoclaw-<tag>-windows_amd64.msi,
# when staging attached the macOS and Windows installers, are signed (and the
# macOS one notarized) when SIGNED/installer-<platform>.verification.txt holds
# their signing job's checks. Only a release candidate may attach one unsigned.
set -euo pipefail

signed=$1
archives=$2
notes=$3
tag=$GITHUB_REF_NAME
exception=${RELEASE_UNSIGNED_EXCEPTION:-}

unsigned=()
for platform in darwin_arm64 windows_amd64; do
  [ -d "$signed/$platform" ] || unsigned+=("$platform")
done
required=true
case "$tag" in *-*) required=false ;; esac
reason=
if [ "$required" = true ] && [ "${#unsigned[@]}" -gt 0 ]; then
  case "$exception" in
    "$tag":?*) reason=${exception#"$tag":} ;;
    *)
      echo "::error::$tag is a final release, so its ${unsigned[*]} executables must be signed: list the platforms in the RELEASE_SIGNING repository variable and let their signing jobs pass. Only RELEASE_UNSIGNED_EXCEPTION set to '$tag:<reason>' stages it unsigned."
      exit 1
      ;;
  esac
fi

checksums=$(cd "$archives" && sha256sum --check --strict SHA256SUMS)
entries=()
for platform in linux_arm64 linux_amd64 darwin_arm64 windows_amd64; do
  archive="nemoclaw-$tag-$platform.tar.gz"
  files='[]'
  verification=null
  if [ -d "$signed/$platform" ]; then
    inventory=$(bash "$(dirname "$0")/signing-inventory.sh" "$signed/$platform" "$platform")
    files=$(cd "$signed/$platform" && awk -F'\t' '$1 == "nvidia" { print $2 }' <<< "$inventory" |
      xargs -r sha256sum -- | jq -Rn '[inputs | capture("^(?<sha256>[0-9a-f]{64})  (?<path>.+)$") | {path, sha256}]')
    verification=$(jq -Rs . < "$signed/$platform.verification.txt")
  fi
  entries+=("$(jq -n --arg platform "$platform" --arg archive "$archive" \
    --arg sha256 "$(awk -v name="$archive" '$2 == name { print $1 }' "$archives/SHA256SUMS")" \
    --argjson signed "$files" --argjson verification "$verification" \
    '{platform: $platform, archive: $archive, sha256: $sha256, signed: $signed, signature_verification: $verification}')")
done
installer_entries=()
declare -A installer_files=([darwin_arm64]="nemoclaw-$tag-darwin_arm64.pkg" [windows_amd64]="nemoclaw-$tag-windows_amd64.msi")
for platform in darwin_arm64 windows_amd64; do
  file=${installer_files[$platform]}
  [ -f "$archives/$file" ] || continue
  verification=null
  if [ -f "$signed/installer-$platform.verification.txt" ]; then
    verification=$(jq -Rs . < "$signed/installer-$platform.verification.txt")
  elif [ "$required" = true ]; then
    echo "::error::$tag is a final release, so its $platform installer must be signed."
    exit 1
  fi
  installer_entries+=("$(jq -n --arg platform "$platform" --arg file "$file" \
    --arg sha256 "$(awk -v name="$file" '$2 == name { print $1 }' "$archives/SHA256SUMS")" \
    --argjson verification "$verification" \
    '{platform: $platform, file: $file, sha256: $sha256, signed: ($verification != null), signature_verification: $verification}')")
done
installers=$(printf '%s\n' "${installer_entries[@]}" | jq -s .)
printf '%s\n' "${entries[@]}" | jq -s --arg version "$tag" --arg commit "$GITHUB_SHA" \
  --arg run "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT" \
  --argjson required "$required" --arg reason "$reason" \
  --argjson unsigned "$(jq -cn '$ARGS.positional' --args "${unsigned[@]}")" --arg checksums "$checksums" \
  --argjson installers "$installers" \
  '{
    version: $version,
    commit: $commit,
    run: $run,
    signing: {required: $required, unsigned: $unsigned, exception: (if $reason == "" then null else $reason end)},
    archives: .,
    installers: $installers,
    verification: [{command: "sha256sum --check --strict SHA256SUMS", output: $checksums}]
  }' > "$archives/release-evidence.json"

platforms=$(printf "\`%s\` and " "${unsigned[@]}")
platforms=${platforms% and }
{
  if [ "${#unsigned[@]}" -eq 0 ]; then
    echo "The \`darwin_arm64\` and \`windows_amd64\` executables are signed."
  elif [ -n "$reason" ]; then
    echo "**Unsigned final release:** the $platforms executables aren't signed, under an exception for this release: $reason"
  else
    echo "The $platforms executables aren't signed: release candidates may stay unsigned."
  fi
  echo
  package=${installer_files[darwin_arm64]}
  case "$(jq -r --arg file "$package" 'map(select(.file == $file) | .signed) | first // "none"' <<< "$installers")" in
    none) echo "This release has no macOS installer: a final release attaches it only when it's signed and notarized." ;;
    true) echo "\`$package\` installs the \`darwin_arm64\` CLI on macOS. It is signed and notarized." ;;
    *) echo "\`$package\` installs the \`darwin_arm64\` CLI on macOS. It isn't signed or notarized: release candidates may stay unsigned." ;;
  esac
  echo
  msi=${installer_files[windows_amd64]}
  if jq -e --arg file "$msi" 'any(.file == $file)' <<< "$installers" > /dev/null; then
    echo "\`$msi\` installs the \`windows_amd64\` CLI on Windows for the current user. It is signed."
  else
    echo "This release has no Windows installer: staging builds it only when the Windows executables are signed."
  fi
  echo
  echo "\`release-evidence.json\` records the signing decision, each signed executable with its SHA-256, and the output of the signature and checksum checks."
} > "$notes"
