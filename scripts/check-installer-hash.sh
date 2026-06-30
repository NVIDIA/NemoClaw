#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Verifies that pinned SHA-256 hashes for downloaded installers still match
# the current upstream scripts.
#
# Checked installers:
#   1. Ollama installer    — scripts/install.sh      (OLLAMA_INSTALL_SHA256)
#   2. OpenShell v0.0.72   — scripts/install-openshell.sh release-asset table
#   3. Brev OpenShell CLI  — scripts/brev-launchable-ci-cpu.sh release-asset table
#
# Usage:
#   scripts/check-installer-hash.sh            # exit 0 if current, 1 if stale
#   scripts/check-installer-hash.sh --update   # rewrite stale hashes in-place

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENSHELL_RELEASE_VERSION="0.0.72"

case "${1:-}" in
  "" | --update) ;;
  *)
    echo "Usage: scripts/check-installer-hash.sh [--update]" >&2
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

fetch_hash() {
  local url="$1" tmpfile
  tmpfile=$(mktemp)
  trap 'rm -f "$tmpfile"' RETURN
  fetch_file "$url" "$tmpfile"
  sha256_file "$tmpfile"
}

extract_pinned() {
  local file="$1" var_name="$2"
  sed -n "s/.*${var_name}=\"\\([a-f0-9]\\{64\\}\\)\".*/\\1/p" "$file" | head -1
}

update_pinned() {
  local file="$1" old_hash="$2" new_hash="$3"
  sed -i.bak "s/${old_hash}/${new_hash}/" "$file"
  rm -f "${file}.bak"
}

# ---------------------------------------------------------------------------
# Registry of pinned hashes: (label, file, variable, upstream URL)
# ---------------------------------------------------------------------------
LABELS=()
FILES=()
VARS=()
URLS=()

register() {
  LABELS+=("$1")
  FILES+=("$2")
  VARS+=("$3")
  URLS+=("$4")
}

register "Ollama installer" \
  "${REPO_ROOT}/scripts/install.sh" \
  "OLLAMA_INSTALL_SHA256" \
  "https://ollama.com/install.sh"

# invalidState: CI reports trusted OpenShell pins without comparing every
# consumed archive with the immutable v0.0.72 checksum release assets.
# sourceBoundary: NVIDIA/OpenShell owns the release assets and their published
# digests; NemoClaw owns this independent verification of its local pin table.
# whyNotSourceFix: an upstream release cannot validate which artifacts a
# downstream installer consumes, so this comparison must remain in NemoClaw.
# regressionTest: test/installer-hash-check.test.ts proves download failures and
# altered checksum manifests fail closed; the workflow also runs this live.
# removalCondition: remove this check only when the installer no longer embeds
# release-asset digests or an equivalent independent verifier replaces it.
check_openshell_release_assets() {
  local installer="${REPO_ROOT}/scripts/install-openshell.sh"
  local brev_installer="${REPO_ROOT}/scripts/brev-launchable-ci-cpu.sh"
  local release_base="https://github.com/NVIDIA/OpenShell/releases/download/v${OPENSHELL_RELEASE_VERSION}"
  local workspace manifests spec manifest expected actual source asset pinned upstream matches
  local count=0 brev_count=0 published_count=0 failures=0
  local -a manifest_specs=(
    "openshell-checksums-sha256.txt:0049181983eaf925ef9510382f75348229a9511d02e27196107782e7c3259ae1"
    "openshell-gateway-checksums-sha256.txt:3c454dc15154b8c700ec820628559ea8964c6e552d9c5f8af78b6ee19cf34547"
    "openshell-sandbox-checksums-sha256.txt:d38507501338576437cf3e554df71fefe927dc0d72758f88e260069527ed9ccc"
  )
  workspace=$(mktemp -d)
  manifests="${workspace}/published-sha256.txt"
  : >"$manifests"
  trap 'rm -rf "$workspace"' RETURN

  echo "Checking OpenShell v${OPENSHELL_RELEASE_VERSION} release assets..."
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
      echo "  STALE: ${manifest} digest does not match the pinned v${OPENSHELL_RELEASE_VERSION} release asset."
      echo "    pinned:   ${expected}"
      echo "    upstream: ${actual}"
      failures=$((failures + 1))
      continue
    fi
    echo "  OK: ${manifest} (${actual})"
    cat "${workspace}/${manifest}" >>"$manifests"
  done

  while IFS=$'\t' read -r source asset pinned; do
    if [[ "$source" == "installer" ]]; then
      count=$((count + 1))
    else
      brev_count=$((brev_count + 1))
    fi
    matches=$(awk -v asset="$asset" '$2 == asset { count++ } END { print count + 0 }' "$manifests")
    upstream=$(awk -v asset="$asset" '$2 == asset { print $1; exit }' "$manifests")
    if [[ "$matches" -eq 1 && "$pinned" == "$upstream" ]]; then
      published_count=$((published_count + 1))
      echo "  OK: ${source} ${asset} (${pinned})"
    else
      echo "  STALE: ${source} ${asset} does not match exactly one v${OPENSHELL_RELEASE_VERSION} checksum entry."
      echo "    pinned:   ${pinned}"
      echo "    upstream: ${upstream:-missing}"
      echo "    matches:  ${matches}"
      failures=$((failures + 1))
    fi
  done < <(
    awk -v marker="v${OPENSHELL_RELEASE_VERSION}:" '
      /^openshell_pinned_sha256\(\)/ { in_function = 1; next }
      in_function && /^}/ { exit }
      in_function && index($0, marker) {
        asset = substr($0, index($0, marker) + length(marker))
        sub(/\).*$/, "", asset)
        next
      }
      in_function && /printf .*"[a-f0-9]+"/ {
        split($0, fields, "\"")
        print "installer\t" asset "\t" fields[2]
      }
    ' "$installer"
    awk -v marker="v${OPENSHELL_RELEASE_VERSION}:" '
      /^openshell_cli_pinned_sha256\(\)/ { in_function = 1; next }
      in_function && /^}/ { exit }
      in_function && index($0, marker) {
        asset = substr($0, index($0, marker) + length(marker))
        sub(/\).*$/, "", asset)
        next
      }
      in_function && /printf .*"[a-f0-9]+"/ {
        split($0, fields, "\"")
        print "Brev launchable\t" asset "\t" fields[2]
      }
    ' "$brev_installer"
  )

  if [[ "$count" -ne 8 ]]; then
    echo "  STALE: expected 8 pinned OpenShell v${OPENSHELL_RELEASE_VERSION} assets, found ${count}."
    failures=$((failures + 1))
  fi
  if [[ "$brev_count" -ne 2 ]]; then
    echo "  STALE: expected 2 pinned Brev OpenShell v${OPENSHELL_RELEASE_VERSION} CLI assets, found ${brev_count}."
    failures=$((failures + 1))
  fi
  if [[ "$published_count" -ne 10 ]]; then
    echo "  STALE: expected all 10 pinned asset references in the v${OPENSHELL_RELEASE_VERSION} checksum manifests, matched ${published_count}."
    failures=$((failures + 1))
  fi
  return "$failures"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
failures=0

for i in "${!LABELS[@]}"; do
  label="${LABELS[$i]}"
  file="${FILES[$i]}"
  var="${VARS[$i]}"
  url="${URLS[$i]}"

  pinned=$(extract_pinned "$file" "$var")

  if [[ -z "$pinned" ]]; then
    echo "  SKIP: ${var} not found in ${file} (not yet merged?)"
    continue
  fi

  echo "Checking ${label} (${var})..."
  echo "  Fetching ${url}..."
  upstream=$(fetch_hash "$url")

  if [[ "$pinned" == "$upstream" ]]; then
    echo "  OK: hash is up-to-date (${pinned})"
    continue
  fi

  if [[ "${1:-}" == "--update" ]]; then
    update_pinned "$file" "$pinned" "$upstream"
    echo "  UPDATED ${file}: ${var}"
    echo "    old: ${pinned}"
    echo "    new: ${upstream}"
  else
    echo "  STALE: pinned hash does not match upstream."
    echo "    pinned:   ${pinned}"
    echo "    upstream: ${upstream}"
    failures=$((failures + 1))
  fi
done

openshell_failures=0
if check_openshell_release_assets; then
  openshell_failures=0
else
  openshell_failures=$?
fi
failures=$((failures + openshell_failures))

if ((failures > 0)); then
  echo ""
  echo "${failures} hash(es) are stale. To update, run:"
  echo ""
  echo "  scripts/check-installer-hash.sh --update"
  echo ""
  exit 1
fi

echo ""
echo "All installer hashes are current."
