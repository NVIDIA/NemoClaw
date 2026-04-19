#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Updates the pinned sha256 digest for node:22-slim in the Dockerfile.
# Queries Docker Hub for the current linux/amd64 manifest digest and
# rewrites every FROM line that references node:22-slim.
#
# Usage:
#   scripts/update-docker-pin.sh            # update Dockerfile in repo root
#   scripts/update-docker-pin.sh --check    # exit 0 if up-to-date, 1 if stale

set -euo pipefail

case "${1:-}" in
  "" | --check) ;;
  *)
    echo "Usage: scripts/update-docker-pin.sh [--check]" >&2
    exit 2
    ;;
esac

IMAGE="node"
TAG="22-slim"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE_PATH="${REPO_ROOT}/${DOCKERFILE}"

# ---------------------------------------------------------------------------
# Resolve the current multi-arch manifest digest for linux/amd64
# ---------------------------------------------------------------------------
resolve_latest_digest() {
  local token manifest

  # Step 1: get an auth token for the Docker Hub library repo
  token=$(curl -fsSL --retry 3 --retry-delay 1 --retry-all-errors \
    --connect-timeout 10 --max-time 30 \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/${IMAGE}:pull" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

  if [[ -z "$token" ]]; then
    echo "ERROR: failed to obtain Docker Hub auth token" >&2
    exit 1
  fi

  # Step 2: fetch the manifest list and pick the linux/amd64 digest
  manifest=$(curl -fsSL --retry 3 --retry-delay 1 --retry-all-errors \
    --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json" \
    "https://registry-1.docker.io/v2/library/${IMAGE}/manifests/${TAG}")

  local digest
  digest=$(echo "$manifest" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('manifests', []):
    p = m.get('platform', {})
    if p.get('os') == 'linux' and p.get('architecture') == 'amd64' and not p.get('variant'):
        print(m['digest'])
        break
")

  if [[ -z "$digest" ]]; then
    echo "ERROR: could not resolve digest for ${IMAGE}:${TAG}" >&2
    exit 1
  fi

  echo "$digest"
}

# ---------------------------------------------------------------------------
# Extract the currently-pinned digest from the Dockerfile (first match)
# ---------------------------------------------------------------------------
current_digest() {
  sed -n "s|^FROM ${IMAGE}:${TAG}@\(sha256:[a-f0-9]*\).*|\1|p" "$DOCKERFILE_PATH" | head -1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
latest=$(resolve_latest_digest)
pinned=$(current_digest)

if [[ -z "$pinned" ]]; then
  echo "ERROR: no pinned digest found in ${DOCKERFILE} for ${IMAGE}:${TAG}" >&2
  echo "Expected lines like: FROM ${IMAGE}:${TAG}@sha256:..." >&2
  exit 1
fi

if [[ "$pinned" == "$latest" ]]; then
  echo "OK: ${IMAGE}:${TAG} digest is already up-to-date (${pinned})"
  exit 0
fi

if [[ "${1:-}" == "--check" ]]; then
  echo "STALE: pinned digest does not match the latest upstream digest."
  echo ""
  echo "  pinned: ${pinned}"
  echo "  latest: ${latest}"
  echo ""
  echo "To update, run:"
  echo ""
  echo "  scripts/update-docker-pin.sh"
  echo ""
  exit 1
fi

# Perform the replacement
sed -i.bak "s|${IMAGE}:${TAG}@${pinned}|${IMAGE}:${TAG}@${latest}|g" "$DOCKERFILE_PATH"
rm -f "${DOCKERFILE_PATH}.bak"

echo "Updated ${DOCKERFILE}: ${IMAGE}:${TAG} digest"
echo "  old: ${pinned}"
echo "  new: ${latest}"
