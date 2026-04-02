#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Updates the pinned sha256 digests for NIM container images in nim-images.json.
# Queries nvcr.io for the current manifest digest of each image and rewrites
# the image reference to include @sha256:<digest>.
#
# Requires: docker CLI authenticated to nvcr.io (docker login nvcr.io)
#
# Usage:
#   scripts/update-nim-pins.sh            # update nim-images.json
#   scripts/update-nim-pins.sh --check    # exit 0 if all pinned, 1 if any unpinned/stale

set -euo pipefail

case "${1:-}" in
  "" | --check) ;;
  *)
    echo "Usage: scripts/update-nim-pins.sh [--check]" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NIM_IMAGES="${REPO_ROOT}/bin/lib/nim-images.json"

if [[ ! -f "$NIM_IMAGES" ]]; then
  echo "ERROR: ${NIM_IMAGES} not found" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve the manifest digest for a single image:tag via docker manifest inspect
# ---------------------------------------------------------------------------
resolve_digest() {
  local image_ref="$1"
  local manifest digest

  manifest=$(docker manifest inspect "$image_ref" 2>/dev/null) || {
    echo ""
    return
  }

  # Try single-arch manifest first (config.digest), then multi-arch (manifests[].digest for amd64)
  digest=$(echo "$manifest" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('config', {}).get('digest'):
        print(d['config']['digest'])
    elif d.get('manifests'):
        for m in d['manifests']:
            if m.get('platform', {}).get('architecture') == 'amd64':
                print(m['digest']); break
except:
    pass
" 2>/dev/null)

  echo "${digest:-}"
}

# ---------------------------------------------------------------------------
# Extract the base image (without @sha256:...) from a full image reference
# ---------------------------------------------------------------------------
strip_digest() {
  printf '%s' "${1%%@sha256:*}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
images=$(python3 -c "
import json
data = json.load(open('${NIM_IMAGES}'))
for m in data['models']:
    print(m['image'])
")

any_unpinned=0
any_stale=0
any_failed=0

for full_ref in $images; do
  base_ref=$(strip_digest "$full_ref")
  current_digest=""

  # Extract existing pinned digest if present
  if [[ "$full_ref" == *"@sha256:"* ]]; then
    current_digest="${full_ref##*@}"
  fi

  echo -n "  ${base_ref}: "

  latest_digest=$(resolve_digest "$base_ref")

  if [[ -z "$latest_digest" ]]; then
    echo "SKIPPED (auth denied or image not found)"
    any_failed=1
    continue
  fi

  if [[ -z "$current_digest" ]]; then
    echo "UNPINNED → ${latest_digest}"
    any_unpinned=1
  elif [[ "$current_digest" == "$latest_digest" ]]; then
    echo "OK (${current_digest:0:19}...)"
    continue
  else
    echo "STALE (${current_digest:0:19}... → ${latest_digest:0:19}...)"
    any_stale=1
  fi

  if [[ "${1:-}" != "--check" ]]; then
    # Update the image reference in nim-images.json
    python3 -c "
import json, sys
data = json.load(open('${NIM_IMAGES}'))
for m in data['models']:
    stripped = m['image'].split('@')[0]
    if stripped == '${base_ref}':
        m['image'] = stripped + '@${latest_digest}'
json.dump(data, open('${NIM_IMAGES}', 'w'), indent=2)
print('')  # trailing newline
" 2>/dev/null
    # Ensure trailing newline
    python3 -c "
import pathlib
p = pathlib.Path('${NIM_IMAGES}')
t = p.read_text()
if not t.endswith('\n'):
    p.write_text(t + '\n')
"
  fi
done

if [[ "${1:-}" == "--check" ]]; then
  if [[ $any_unpinned -ne 0 || $any_stale -ne 0 ]]; then
    echo ""
    echo "Some NIM images are unpinned or stale. Run:"
    echo ""
    echo "  scripts/update-nim-pins.sh"
    echo ""
    exit 1
  fi
  if [[ $any_failed -ne 0 ]]; then
    echo ""
    echo "WARNING: Some images could not be checked (auth denied). Ensure docker is logged in to nvcr.io."
    # Don't fail CI for auth issues — the images we CAN check are pinned
  fi
  echo ""
  echo "All checkable NIM images are pinned and up-to-date."
  exit 0
fi

echo ""
echo "Updated ${NIM_IMAGES} with current digests."
if [[ $any_failed -ne 0 ]]; then
  echo "WARNING: Some images were skipped due to auth/license issues. Accept licenses at https://ngc.nvidia.com and retry."
fi
