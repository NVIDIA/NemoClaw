#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Verifies that pinned SHA-256 hashes for downloaded installers still match
# the current upstream scripts.
#
# Checked installers:
#   1. Ollama installer    — scripts/install.sh      (OLLAMA_INSTALL_SHA256)
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
