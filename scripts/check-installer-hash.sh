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
#
# Usage:
#   scripts/check-installer-hash.sh            # exit 0 if current, 1 if stale
#   scripts/check-installer-hash.sh --update   # rewrite stale hashes in-place

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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
fetch_hash() {
  local url="$1" tmpfile
  tmpfile=$(mktemp)
  trap 'rm -f "$tmpfile"' RETURN

  curl --proto '=https' --tlsv1.2 -fsSL \
    --connect-timeout 10 --max-time 30 \
    --retry 3 --retry-delay 1 --retry-all-errors \
    -o "$tmpfile" "$url"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$tmpfile" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$tmpfile" | awk '{print $1}'
  else
    echo "ERROR: No SHA-256 tool available (sha256sum/shasum)." >&2
    return 1
  fi
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
# consumed archive with the immutable v0.0.72 GitHub release metadata.
# sourceBoundary: NVIDIA/OpenShell owns the release assets and their published
# digests; NemoClaw owns this independent verification of its local pin table.
# whyNotSourceFix: an upstream release cannot validate which artifacts a
# downstream installer consumes, so this comparison must remain in NemoClaw.
# regressionTest: test/installer-hash-check.test.ts proves API failures and
# incomplete release metadata fail closed; the workflow also runs this live.
# removalCondition: remove this check only when the installer no longer embeds
# release-asset digests or an equivalent independent verifier replaces it.
check_openshell_release_assets() {
  local installer="${REPO_ROOT}/scripts/install-openshell.sh"
  local release_api="https://api.github.com/repos/NVIDIA/OpenShell/releases/tags/v0.0.72"
  local response asset pinned upstream github_token count=0 published_count=0
  local -a curl_args
  response=$(mktemp)
  trap 'rm -f "$response"' RETURN

  echo "Checking OpenShell v0.0.72 release assets..."
  curl_args=(
    --proto '=https'
    --tlsv1.2
    -fsSL
    --connect-timeout 10
    --max-time 30
    --retry 3
    --retry-delay 1
    --retry-all-errors
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28"
  )
  github_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [[ -z "$github_token" ]] && command -v gh >/dev/null 2>&1; then
    github_token=$(gh auth token 2>/dev/null || true)
  fi
  if [[ -n "$github_token" ]]; then
    curl_args+=(-H "Authorization: Bearer ${github_token}")
  fi
  curl "${curl_args[@]}" -o "$response" "$release_api"

  while IFS=$'\t' read -r asset pinned; do
    count=$((count + 1))
    upstream=$(jq -r --arg asset "$asset" \
      '.assets[] | select(.name == $asset) | .digest // empty' "$response")
    upstream="${upstream#sha256:}"
    if [[ "$pinned" == "$upstream" ]]; then
      published_count=$((published_count + 1))
      echo "  OK: ${asset} (${pinned})"
    else
      echo "  STALE: ${asset} does not match the v0.0.72 GitHub release."
      echo "    pinned:   ${pinned}"
      echo "    upstream: ${upstream:-missing}"
      failures=$((failures + 1))
    fi
  done < <(
    awk '
      /^openshell_pinned_sha256\(\)/ { in_function = 1; next }
      in_function && /^}/ { exit }
      in_function && /v0\.0\.72:/ {
        asset = $0
        sub(/^.*v0\.0\.72:/, "", asset)
        sub(/\).*$/, "", asset)
        next
      }
      in_function && /printf .*"[a-f0-9]+"/ {
        split($0, fields, "\"")
        print asset "\t" fields[2]
      }
    ' "$installer"
  )

  if [[ "$count" -ne 8 ]]; then
    echo "  STALE: expected 8 pinned OpenShell v0.0.72 assets, found ${count}."
    failures=$((failures + 1))
  fi
  if [[ "$published_count" -ne 8 ]]; then
    echo "  STALE: expected all 8 pinned assets in the v0.0.72 GitHub release, matched ${published_count}."
    failures=$((failures + 1))
  fi
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

check_openshell_release_assets

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
