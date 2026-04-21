#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Verifies that the SHA-256 hash pinned in k8s/nemoclaw-k8s.yaml matches
# the current https://www.nvidia.com/nemoclaw.sh installer script.
#
# Usage:
#   scripts/check-installer-hash.sh            # exit 0 if current, 1 if stale
#   scripts/check-installer-hash.sh --update   # rewrite the hash in the manifest

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="${REPO_ROOT}/k8s/nemoclaw-k8s.yaml"
INSTALLER_URL="https://www.nvidia.com/nemoclaw.sh"

case "${1:-}" in
  "" | --update) ;;
  *)
    echo "Usage: scripts/check-installer-hash.sh [--update]" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# Extract the pinned hash from the manifest
# ---------------------------------------------------------------------------
pinned_hash() {
  sed -n 's/.*NEMOCLAW_INSTALLER_SHA256="\([a-f0-9]\{64\}\)".*/\1/p' "$MANIFEST" | head -1
}

# ---------------------------------------------------------------------------
# Download the installer and compute its SHA-256
# ---------------------------------------------------------------------------
fetch_upstream_hash() {
  local tmpfile
  tmpfile=$(mktemp)
  trap 'rm -f "$tmpfile"' RETURN

  curl --proto '=https' --tlsv1.2 -fsSL \
    --connect-timeout 10 --max-time 30 \
    --retry 3 --retry-delay 1 --retry-all-errors \
    -o "$tmpfile" "$INSTALLER_URL"

  sha256sum "$tmpfile" | cut -d' ' -f1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
pinned=$(pinned_hash)

if [[ -z "$pinned" ]]; then
  echo "ERROR: no NEMOCLAW_INSTALLER_SHA256 found in ${MANIFEST}" >&2
  exit 1
fi

echo "Fetching upstream installer from ${INSTALLER_URL}..."
upstream=$(fetch_upstream_hash)

if [[ "$pinned" == "$upstream" ]]; then
  echo "OK: installer hash is up-to-date (${pinned})"
  exit 0
fi

if [[ "${1:-}" != "--update" ]]; then
  echo "STALE: pinned installer hash does not match upstream."
  echo ""
  echo "  pinned:   ${pinned}"
  echo "  upstream: ${upstream}"
  echo ""
  echo "To update, run:"
  echo ""
  echo "  scripts/check-installer-hash.sh --update"
  echo ""
  exit 1
fi

# Perform the replacement
sed -i.bak "s/${pinned}/${upstream}/" "$MANIFEST"
rm -f "${MANIFEST}.bak"

echo "Updated ${MANIFEST}: NEMOCLAW_INSTALLER_SHA256"
echo "  old: ${pinned}"
echo "  new: ${upstream}"
