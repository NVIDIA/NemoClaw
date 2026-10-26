#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Record one pushed platform image's SBOM in the CI package, under that
# platform's manifest digest, unless the package already records one that
# names that digest.
#
#   image-sbom.sh PUSHED PLATFORM [OUTPUT]
#
# PUSHED is the image's reference by tag or digest, and PLATFORM is
# linux/ARCH. With OUTPUT, also write the recorded document there. SYFT names
# the pinned Syft, and PACKAGE the CI package.
set -eu
pushed=$1
platform=$2
output=${3:-}
os=${platform%/*}
arch=${platform#*/}
case $pushed in
  *@*) repository=${pushed%@*} ;;
  *) repository=${pushed%:*} ;;
esac

# The release lists platform manifests, so key the SBOM by that digest.
digest=$(docker buildx imagetools inspect "$pushed" --raw |
  jq -r --arg os "$os" --arg arch "$arch" \
    '[.manifests[]? | select(.platform.os == $os and .platform.architecture == $arch) | .digest][0] // empty')
if [ -z "$digest" ]; then
  digest=$(docker buildx imagetools inspect "$pushed" --format '{{.Manifest.Digest}}')
fi
recorded="$PACKAGE:sbom-${digest#sha256:}"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

# A document's subject is the manifest Syft read. Scanning a local image
# names a copy Docker exports, which no registry reference has, so only a
# document that names this digest counts as its record.
subject() {
  jq -r '(.relationships[] | select(.spdxElementId == "SPDXRef-DOCUMENT" and .relationshipType == "DESCRIBES")
    | .relatedSpdxElement) as $id | .packages[] | select(.SPDXID == $id)
    | "sha256:" + ([.checksums[]? | select(.algorithm == "SHA256") | .checksumValue][0] // "")' "$1"
}
if docker pull --quiet --platform "$platform" "$recorded" > /dev/null 2>&1; then
  container=$(docker create --platform "$platform" "$recorded" /)
  docker cp "$container:/sbom.spdx.json" "$dir/sbom.spdx.json" > /dev/null
  docker rm "$container" > /dev/null
  if [ "$(subject "$dir/sbom.spdx.json")" = "$digest" ]; then
    [ -z "$output" ] || cp "$dir/sbom.spdx.json" "$output"
    echo "$recorded already records $pushed"
    exit 0
  fi
  echo "$recorded doesn't name $digest; scanning again"
fi

SYFT_CHECK_FOR_APP_UPDATE=false "$SYFT" "registry:$repository@$digest" \
  --select-catalogers +rust-cargo-lock-cataloger -q -o "spdx-json=$dir/sbom.spdx.json"
if [ "$(subject "$dir/sbom.spdx.json")" != "$digest" ]; then
  echo "::error::Syft's SBOM for $repository@$digest names another image" >&2
  exit 1
fi
printf 'FROM scratch\nCOPY sbom.spdx.json /\n' > "$dir/Dockerfile"
docker build -q --platform "$platform" -t "$recorded" "$dir" > /dev/null
docker push --quiet "$recorded" > /dev/null
[ -z "$output" ] || cp "$dir/sbom.spdx.json" "$output"
echo "$recorded records $pushed"
